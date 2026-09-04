import { describe, expect, it } from "vitest";
import {
  DEFAULT_CALLEE_MIN_SPEECH_MS,
  DEFAULT_CALLEE_SPEECH_GRACE_MS,
  createCalleeSpeechGate,
  isNonEmptyCalleeTranscript,
  noteStreamStart,
  onSpeechStarted,
  onSpeechStopped,
  onTranscript,
} from "../src/bridge/callee-speech.js";

const config = {
  graceMs: DEFAULT_CALLEE_SPEECH_GRACE_MS,
  minSpeechMs: DEFAULT_CALLEE_MIN_SPEECH_MS,
};

describe("callee speech gate (waitForCallee)", () => {
  it("defaults grace to 1000ms and min speech to 250ms", () => {
    expect(DEFAULT_CALLEE_SPEECH_GRACE_MS).toBe(1000);
    expect(DEFAULT_CALLEE_MIN_SPEECH_MS).toBe(250);
  });

  it("treats whitespace-only ASR as empty", () => {
    expect(isNonEmptyCalleeTranscript("")).toBe(false);
    expect(isNonEmptyCalleeTranscript("   ")).toBe(false);
    expect(isNonEmptyCalleeTranscript("Estou")).toBe(true);
  });

  it("does not unlock on speech_started during the post-answer grace window (ringback/noise)", () => {
    const gate = createCalleeSpeechGate();
    noteStreamStart(gate, 0);
    const early = onSpeechStarted(gate, true, 200, config);
    expect(early).toEqual({ unlock: false, reason: "grace_period" });
    expect(gate.acceptedSpeechStartedAtMs).toBeUndefined();

    const atGraceEdge = onSpeechStarted(gate, true, 999, config);
    expect(atGraceEdge.reason).toBe("grace_period");
    expect(atGraceEdge.unlock).toBe(false);
  });

  it("does not unlock on speech_started alone after grace — waits for min duration or transcript", () => {
    const gate = createCalleeSpeechGate();
    noteStreamStart(gate, 0);
    const started = onSpeechStarted(gate, true, 1000, config);
    expect(started).toEqual({ unlock: false, reason: "awaiting_min_duration" });
    expect(gate.acceptedSpeechStartedAtMs).toBe(1000);
  });

  it("ignores speech_stopped for an utterance that started during grace", () => {
    const gate = createCalleeSpeechGate();
    noteStreamStart(gate, 0);
    onSpeechStarted(gate, true, 100, config);
    const stopped = onSpeechStopped(gate, true, 1500, config);
    expect(stopped).toEqual({ unlock: false, reason: "no_accepted_utterance" });
  });

  it("unlocks after grace when speech lasts at least minSpeechMs", () => {
    const gate = createCalleeSpeechGate();
    noteStreamStart(gate, 0);
    onSpeechStarted(gate, true, 1100, config);
    const tooShort = onSpeechStopped(gate, true, 1100 + 200, config);
    expect(tooShort).toEqual({ unlock: false, reason: "speech_too_short" });

    onSpeechStarted(gate, true, 2000, config);
    const ok = onSpeechStopped(gate, true, 2000 + 250, config);
    expect(ok).toEqual({ unlock: true, reason: "min_speech_duration" });
  });

  it("uses VAD audio duration when speech_stopped provides it", () => {
    const gate = createCalleeSpeechGate();
    noteStreamStart(gate, 0);
    onSpeechStarted(gate, true, 1200, config);
    const ok = onSpeechStopped(gate, true, 1210, config, 400);
    expect(ok).toEqual({ unlock: true, reason: "min_speech_duration" });
  });

  it("does not unlock on empty transcript", () => {
    expect(onTranscript(true, "   ")).toEqual({ unlock: false, reason: "empty_transcript" });
    expect(onTranscript(true, "")).toEqual({ unlock: false, reason: "empty_transcript" });
  });

  it("unlocks on first non-empty transcript even during grace", () => {
    const duringGrace = onTranscript(true, "Estou");
    expect(duringGrace).toEqual({ unlock: true, reason: "non_empty_transcript" });
  });

  it("does not unlock when not waiting", () => {
    const gate = createCalleeSpeechGate();
    noteStreamStart(gate, 0);
    expect(onSpeechStarted(gate, false, 2000, config)).toEqual({ unlock: false, reason: "not_waiting" });
    expect(onSpeechStopped(gate, false, 2300, config)).toEqual({ unlock: false, reason: "not_waiting" });
    expect(onTranscript(false, "Estou")).toEqual({ unlock: false, reason: "not_waiting" });
  });
});
