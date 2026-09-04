export const DEFAULT_CALLEE_SPEECH_GRACE_MS = 1000;
/** Word-length floor after grace. «Estou» is often ~120–180ms; 250ms was too strict. */
export const DEFAULT_CALLEE_MIN_SPEECH_MS = 130;

export type CalleeSpeechGateConfig = {
  graceMs: number;
  minSpeechMs: number;
};

export type CalleeSpeechGate = {
  streamStartedAtMs: number | undefined;
  acceptedSpeechStartedAtMs: number | undefined;
  lastSpeechStartedAtMs: number | undefined;
};

export type CalleeSpeechBlockReason =
  | "not_waiting"
  | "grace_period"
  | "empty_transcript"
  | "awaiting_min_duration"
  | "speech_too_short"
  | "no_accepted_utterance";

export type CalleeSpeechUnlockReason = "non_empty_transcript" | "short_greeting" | "min_speech_duration";

export type CalleeSpeechDecision =
  | { unlock: false; reason: CalleeSpeechBlockReason }
  | { unlock: true; reason: CalleeSpeechUnlockReason };

const SHORT_GREETING =
  /^(estou|esto|alo|alô|sim|ok|okay|hello|hi|hey|yes|yeah|yep|pois|diga|pronto|ola|olá|wai|two|tu)$/i;

export function createCalleeSpeechGate(): CalleeSpeechGate {
  return {
    streamStartedAtMs: undefined,
    acceptedSpeechStartedAtMs: undefined,
    lastSpeechStartedAtMs: undefined,
  };
}

export function noteStreamStart(gate: CalleeSpeechGate, atMs: number): void {
  gate.streamStartedAtMs = atMs;
  gate.acceptedSpeechStartedAtMs = undefined;
  gate.lastSpeechStartedAtMs = undefined;
}

export function isNonEmptyCalleeTranscript(text: string): boolean {
  return text.trim().length > 0;
}

export function isShortCalleeGreeting(text: string): boolean {
  const t = stripDiacritics(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  if (!t) return false;
  if (SHORT_GREETING.test(t)) return true;
  const tokens = t.split(/\s+/).filter(Boolean);
  return tokens.length <= 2 && tokens.every((tok) => SHORT_GREETING.test(tok));
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

  if (inGrace(gate, atMs, config.graceMs)) {
    return { unlock: false, reason: "grace_period" };
  }
  if (acceptedAt === undefined && lastStartedAt === undefined && audioDurationMs === undefined) {
    return { unlock: false, reason: "no_accepted_utterance" };
  }

  const durationMs = utteranceDurationMs(atMs, acceptedAt, lastStartedAt, audioDurationMs);
  if (durationMs < config.minSpeechMs) return { unlock: false, reason: "speech_too_short" };
  return { unlock: true, reason: "min_speech_duration" };
}

export function onTranscript(waiting: boolean, text: string): CalleeSpeechDecision {
  if (!waiting) return { unlock: false, reason: "not_waiting" };
  if (isShortCalleeGreeting(text)) return { unlock: true, reason: "short_greeting" };
  if (!isNonEmptyCalleeTranscript(text)) return { unlock: false, reason: "empty_transcript" };
  return { unlock: true, reason: "non_empty_transcript" };
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

function stripDiacritics(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "");
}
