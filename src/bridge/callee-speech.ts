export const DEFAULT_CALLEE_SPEECH_GRACE_MS = 350;
/** Word-length floor after grace. «Estou» / «estou?» is often ~80–180ms; 130ms still missed first turns. */
export const DEFAULT_CALLEE_MIN_SPEECH_MS = 80;

export type CalleeSpeechGateConfig = {
  graceMs: number;
  minSpeechMs: number;
};

export type CalleeSpeechGate = {
  streamStartedAtMs: number | undefined;
  acceptedSpeechStartedAtMs: number | undefined;
  lastSpeechStartedAtMs: number | undefined;
  pendingPostGraceUnlock: boolean;
};

export type CalleeSpeechBlockReason =
  | "not_waiting"
  | "grace_period"
  | "empty_transcript"
  | "speech_too_short"
  | "no_accepted_utterance";

export type CalleeSpeechUnlockReason =
  | "non_empty_transcript"
  | "short_greeting"
  | "min_speech_duration"
  | "short_answer"
  | "grace_elapsed";

export type CalleeSpeechDecision =
  | { unlock: false; reason: CalleeSpeechBlockReason }
  | { unlock: true; reason: CalleeSpeechUnlockReason };

const SHORT_GREETING_TOKEN =
  /^(estou|esto|estau|alo|sim|ok|okay|hello|hi|hey|yes|yeah|yep|pois|diga|pronto|ola|wai|two|tu|still|stihl|steel|steal)$/i;

export function createCalleeSpeechGate(): CalleeSpeechGate {
  return {
    streamStartedAtMs: undefined,
    acceptedSpeechStartedAtMs: undefined,
    lastSpeechStartedAtMs: undefined,
    pendingPostGraceUnlock: false,
  };
}

export function noteStreamStart(gate: CalleeSpeechGate, atMs: number): void {
  gate.streamStartedAtMs = atMs;
  gate.acceptedSpeechStartedAtMs = undefined;
  gate.lastSpeechStartedAtMs = undefined;
  gate.pendingPostGraceUnlock = false;
}

export function hasPendingPostGraceUnlock(gate: CalleeSpeechGate): boolean {
  return gate.pendingPostGraceUnlock;
}

export function msSinceStreamStart(gate: CalleeSpeechGate, atMs: number): number | undefined {
  if (gate.streamStartedAtMs === undefined) return undefined;
  return Math.max(0, atMs - gate.streamStartedAtMs);
}

export function isNonEmptyCalleeTranscript(text: string): boolean {
  return text.trim().length > 0;
}

export function normalizeCalleeTranscript(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[?!.…¿¡,;:«»""''`´]+/gu, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isShortCalleeGreeting(text: string): boolean {
  const t = normalizeCalleeTranscript(text);
  if (!t) return false;
  if (SHORT_GREETING_TOKEN.test(t)) return true;
  const tokens = t.split(" ").filter(Boolean);
  if (tokens.length === 0) return false;
  const first = tokens[0] ?? "";
  if (
    tokens.length <= 3 &&
    /^(estou|esto|estau|alo|ola|sim|ok|okay|still|stihl|hello|hi|hey)$/i.test(first)
  ) {
    return true;
  }
  return tokens.length <= 2 && tokens.every((tok) => SHORT_GREETING_TOKEN.test(tok));
}

export function calleeTranscriptFromEvent(event: Record<string, unknown>): string {
  const direct = transcriptFromUnknown(event.transcript);
  if (direct) return direct;
  if (typeof event.text === "string" && event.text.trim()) return event.text;
  const item = event.item;
  if (item && typeof item === "object" && !Array.isArray(item)) {
    const content = (item as { content?: unknown }).content;
    if (Array.isArray(content)) {
      for (const part of content) {
        const fromPart = transcriptFromUnknown(part);
        if (fromPart) return fromPart;
      }
    }
    const fromItem = transcriptFromUnknown(item);
    if (fromItem) return fromItem;
  }
  return "";
}

export function onSpeechStarted(
  gate: CalleeSpeechGate,
  waiting: boolean,
  atMs: number,
  config: CalleeSpeechGateConfig,
): CalleeSpeechDecision {
  if (!waiting) return { unlock: false, reason: "not_waiting" };
  gate.lastSpeechStartedAtMs = atMs;
  if (inGrace(gate, atMs, config.graceMs)) {
    // Keep lastSpeechStartedAtMs so an overlapping «estou» unlocks as soon as
    // grace ends (media / speech_stopped). Do not accept yet — ringback.
    return { unlock: false, reason: "grace_period" };
  }
  if (gate.pendingPostGraceUnlock) {
    gate.pendingPostGraceUnlock = false;
    gate.acceptedSpeechStartedAtMs = undefined;
    gate.lastSpeechStartedAtMs = undefined;
    return { unlock: true, reason: "grace_elapsed" };
  }
  // After grace, first VAD speech_started is the callee picking up.
  // Do not stall on awaiting_min_duration / inbound media frames (call 5fac53d9).
  gate.acceptedSpeechStartedAtMs = atMs;
  gate.pendingPostGraceUnlock = false;
  return { unlock: true, reason: "short_answer" };
}

export function onSpeechStopped(
  gate: CalleeSpeechGate,
  waiting: boolean,
  atMs: number,
  config: CalleeSpeechGateConfig,
  audioDurationMs?: number,
): CalleeSpeechDecision {
  if (!waiting) return { unlock: false, reason: "not_waiting" };
  const acceptedAt = gate.acceptedSpeechStartedAtMs;
  const lastStartedAt = gate.lastSpeechStartedAtMs;
  gate.acceptedSpeechStartedAtMs = undefined;
  gate.lastSpeechStartedAtMs = undefined;

  const durationMs = utteranceDurationMs(atMs, acceptedAt, lastStartedAt, audioDurationMs);

  if (inGrace(gate, atMs, config.graceMs)) {
    if (durationMs >= config.minSpeechMs) gate.pendingPostGraceUnlock = true;
    return { unlock: false, reason: "grace_period" };
  }
  if (gate.pendingPostGraceUnlock) {
    gate.pendingPostGraceUnlock = false;
    return { unlock: true, reason: "grace_elapsed" };
  }
  if (acceptedAt === undefined && lastStartedAt === undefined && audioDurationMs === undefined) {
    return { unlock: false, reason: "no_accepted_utterance" };
  }

  if (durationMs < config.minSpeechMs) return { unlock: false, reason: "speech_too_short" };
  return { unlock: true, reason: "min_speech_duration" };
}

export function onTranscript(waiting: boolean, text: string): CalleeSpeechDecision {
  if (!waiting) return { unlock: false, reason: "not_waiting" };
  if (isShortCalleeGreeting(text)) return { unlock: true, reason: "short_greeting" };
  if (!isNonEmptyCalleeTranscript(text)) return { unlock: false, reason: "empty_transcript" };
  return { unlock: true, reason: "non_empty_transcript" };
}

/**
 * After grace, any in-progress callee speech is enough to greet — including
 * «estou» that started during grace and is still going. Do not wait for
 * speech_stopped, min duration, or a slow ASR transcript.
 */
export function onOngoingSpeechCheck(
  gate: CalleeSpeechGate,
  waiting: boolean,
  atMs: number,
  config: CalleeSpeechGateConfig,
): CalleeSpeechDecision {
  if (!waiting) return { unlock: false, reason: "not_waiting" };
  if (inGrace(gate, atMs, config.graceMs)) return { unlock: false, reason: "grace_period" };
  if (gate.pendingPostGraceUnlock) {
    gate.pendingPostGraceUnlock = false;
    gate.acceptedSpeechStartedAtMs = undefined;
    gate.lastSpeechStartedAtMs = undefined;
    return { unlock: true, reason: "grace_elapsed" };
  }
  const inProgress =
    gate.lastSpeechStartedAtMs !== undefined || gate.acceptedSpeechStartedAtMs !== undefined;
  if (!inProgress) return { unlock: false, reason: "no_accepted_utterance" };
  gate.acceptedSpeechStartedAtMs = undefined;
  gate.lastSpeechStartedAtMs = undefined;
  gate.pendingPostGraceUnlock = false;
  return { unlock: true, reason: "short_answer" };
}

export function onPostGraceCheck(
  gate: CalleeSpeechGate,
  waiting: boolean,
  atMs: number,
  config: CalleeSpeechGateConfig,
): CalleeSpeechDecision {
  if (!waiting) return { unlock: false, reason: "not_waiting" };
  if (inGrace(gate, atMs, config.graceMs)) return { unlock: false, reason: "grace_period" };
  if (!gate.pendingPostGraceUnlock) return { unlock: false, reason: "no_accepted_utterance" };
  gate.pendingPostGraceUnlock = false;
  return { unlock: true, reason: "grace_elapsed" };
}

function transcriptFromUnknown(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value;
  if (!value || typeof value !== "object") return "";
  const record = value as { transcript?: unknown; text?: unknown };
  if (typeof record.transcript === "string" && record.transcript.trim()) return record.transcript;
  if (typeof record.text === "string" && record.text.trim()) return record.text;
  return "";
}

function utteranceDurationMs(
  atMs: number,
  acceptedAt: number | undefined,
  lastStartedAt: number | undefined,
  audioDurationMs: number | undefined,
): number {
  if (audioDurationMs !== undefined) return Math.max(0, audioDurationMs);
  const startedAt = acceptedAt ?? lastStartedAt;
  if (startedAt === undefined) return 0;
  return Math.max(0, atMs - startedAt);
}

function inGrace(gate: CalleeSpeechGate, atMs: number, graceMs: number): boolean {
  if (gate.streamStartedAtMs === undefined) return true;
  return atMs - gate.streamStartedAtMs < graceMs;
}

/**
 * GPT-Live has no `speech_started` VAD event. G.711 μ-law silence is typically
 * 0xFF / 0x7F. Quiet «estou?» is often near-silence in μ-law, so we also use
 * decoded magnitude rather than only raw non-silence bytes.
 */
export function pcmuPayloadLooksLikeSpeech(base64: string): boolean {
  if (!base64) return false;
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length < 80) return false;
  let loud = 0;
  let energetic = 0;
  for (const b of bytes) {
    if (b !== 0xff && b !== 0x7f) loud += 1;
    if (mulawMagnitude(b) >= 180) energetic += 1;
  }
  return loud > bytes.length * 0.18 || energetic > bytes.length * 0.1;
}

const MULAW_BIAS = 0x84;

function mulawMagnitude(byte: number): number {
  const u = ~byte & 0xff;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const mag = ((mantissa << 3) + MULAW_BIAS) << exponent;
  return mag - MULAW_BIAS;
}

/** Rising/falling edges from Telnyx PCMU — GPT-Live has no speech_stopped. */
export type PcmuVad = {
  speaking: boolean;
  consecutiveSpeech: number;
  consecutiveSilence: number;
};

export type PcmuVadEdge = "none" | "speech_started" | "speech_stopped";

const PCMU_START_FRAMES = 2;
const PCMU_STOP_FRAMES = 4;

export function createPcmuVad(): PcmuVad {
  return { speaking: false, consecutiveSpeech: 0, consecutiveSilence: 0 };
}

export function observePcmuFrame(vad: PcmuVad, base64: string): PcmuVadEdge {
  const speech = pcmuPayloadLooksLikeSpeech(base64);
  if (speech) {
    vad.consecutiveSpeech += 1;
    vad.consecutiveSilence = 0;
    if (!vad.speaking && vad.consecutiveSpeech >= PCMU_START_FRAMES) {
      vad.speaking = true;
      return "speech_started";
    }
    return "none";
  }
  vad.consecutiveSilence += 1;
  vad.consecutiveSpeech = 0;
  if (vad.speaking && vad.consecutiveSilence >= PCMU_STOP_FRAMES) {
    vad.speaking = false;
    return "speech_stopped";
  }
  return "none";
}

export function applyInboundPcmuVad(input: {
  vad: PcmuVad;
  payload: string;
  gate: CalleeSpeechGate;
  waiting: boolean;
  atMs: number;
  config: CalleeSpeechGateConfig;
}): CalleeSpeechDecision | undefined {
  const edge = observePcmuFrame(input.vad, input.payload);
  switch (edge) {
    case "none":
      return undefined;
    case "speech_started":
      return onSpeechStarted(input.gate, input.waiting, input.atMs, input.config);
    case "speech_stopped":
      return onSpeechStopped(input.gate, input.waiting, input.atMs, input.config);
    default: {
      const _never: never = edge;
      throw new Error(`unsupported pcmu vad edge: ${_never}`);
    }
  }
}
