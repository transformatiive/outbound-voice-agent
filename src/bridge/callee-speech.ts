export const DEFAULT_CALLEE_SPEECH_GRACE_MS = 1000;
export const DEFAULT_CALLEE_MIN_SPEECH_MS = 250;

export type CalleeSpeechGateConfig = {
  graceMs: number;
  minSpeechMs: number;
};

export type CalleeSpeechGate = {
  streamStartedAtMs: number | undefined;
  acceptedSpeechStartedAtMs: number | undefined;
};

export type CalleeSpeechBlockReason =
  | "not_waiting"
  | "grace_period"
  | "empty_transcript"
  | "awaiting_min_duration"
  | "speech_too_short"
  | "no_accepted_utterance";

export type CalleeSpeechUnlockReason = "non_empty_transcript" | "min_speech_duration";

export type CalleeSpeechDecision =
  | { unlock: false; reason: CalleeSpeechBlockReason }
  | { unlock: true; reason: CalleeSpeechUnlockReason };

export function createCalleeSpeechGate(): CalleeSpeechGate {
  return { streamStartedAtMs: undefined, acceptedSpeechStartedAtMs: undefined };
}

export function noteStreamStart(gate: CalleeSpeechGate, atMs: number): void {
  gate.streamStartedAtMs = atMs;
  gate.acceptedSpeechStartedAtMs = undefined;
}

export function isNonEmptyCalleeTranscript(text: string): boolean {
  return text.trim().length > 0;
}

export function onSpeechStarted(
  gate: CalleeSpeechGate,
  waiting: boolean,
  atMs: number,
  config: CalleeSpeechGateConfig,
): CalleeSpeechDecision {
  if (!waiting) return { unlock: false, reason: "not_waiting" };
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
  const startedAt = gate.acceptedSpeechStartedAtMs;
  gate.acceptedSpeechStartedAtMs = undefined;
  if (startedAt === undefined) return { unlock: false, reason: "no_accepted_utterance" };
  const durationMs =
    audioDurationMs !== undefined ? Math.max(0, audioDurationMs) : Math.max(0, atMs - startedAt);
  if (durationMs < config.minSpeechMs) return { unlock: false, reason: "speech_too_short" };
  return { unlock: true, reason: "min_speech_duration" };
}

export function onTranscript(waiting: boolean, text: string): CalleeSpeechDecision {
  if (!waiting) return { unlock: false, reason: "not_waiting" };
  if (!isNonEmptyCalleeTranscript(text)) return { unlock: false, reason: "empty_transcript" };
  return { unlock: true, reason: "non_empty_transcript" };
}

function inGrace(gate: CalleeSpeechGate, atMs: number, graceMs: number): boolean {
  if (gate.streamStartedAtMs === undefined) return true;
  return atMs - gate.streamStartedAtMs < graceMs;
}
