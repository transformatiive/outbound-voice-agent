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
  | "awaiting_min_duration"
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
    gate.acceptedSpeechStartedAtMs = undefined;
    return { unlock: false, reason: "grace_period" };
  }
  if (gate.pendingPostGraceUnlock) {
    gate.pendingPostGraceUnlock = false;
    return { unlock: true, reason: "grace_elapsed" };
  }
  gate.acceptedSpeechStartedAtMs = atMs;
  return { unlock: false, reason: "awaiting_min_duration" };
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
 * After grace, a word-length burst of speech is enough to greet — do not wait
 * for speech_stopped or a slow ASR transcript («Still?» for «estou»).
 */
export function onOngoingSpeechCheck(
  gate: CalleeSpeechGate,
  waiting: boolean,
  atMs: number,
  config: CalleeSpeechGateConfig,
): CalleeSpeechDecision {
  if (!waiting) return { unlock: false, reason: "not_waiting" };
  if (inGrace(gate, atMs, config.graceMs)) return { unlock: false, reason: "grace_period" };
  const started = gate.acceptedSpeechStartedAtMs;
  if (started === undefined) return { unlock: false, reason: "no_accepted_utterance" };
  if (atMs - started < config.minSpeechMs) return { unlock: false, reason: "awaiting_min_duration" };
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
