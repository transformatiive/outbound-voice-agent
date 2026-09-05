import { describe, expect, it } from "vitest";
import {
  DEFAULT_CALLEE_MIN_SPEECH_MS,
  DEFAULT_CALLEE_SPEECH_GRACE_MS,
  calleeTranscriptFromEvent,
  createCalleeSpeechGate,
  hasPendingPostGraceUnlock,
  isNonEmptyCalleeTranscript,
  isShortCalleeGreeting,
  msSinceStreamStart,
  noteStreamStart,
  onPostGraceCheck,
  onSpeechStarted,
  onSpeechStopped,
  onTranscript,
  onOngoingSpeechCheck,
} from "../src/bridge/callee-speech.js";

const config = {
  graceMs: DEFAULT_CALLEE_SPEECH_GRACE_MS,
  minSpeechMs: DEFAULT_CALLEE_MIN_SPEECH_MS,
};

describe("callee speech gate (waitForCallee)", () => {
  it("defaults grace to 500ms and min speech to 80ms", () => {
    expect(DEFAULT_CALLEE_SPEECH_GRACE_MS).toBe(500);
    expect(DEFAULT_CALLEE_MIN_SPEECH_MS).toBe(80);
  });

  it("reports milliseconds since stream start", () => {
    const gate = createCalleeSpeechGate();
    expect(msSinceStreamStart(gate, 100)).toBeUndefined();
    noteStreamStart(gate, 1000);
    expect(msSinceStreamStart(gate, 1000)).toBe(0);
    expect(msSinceStreamStart(gate, 1420)).toBe(420);
  });

  it("treats whitespace-only ASR as empty and short phone greetings as unlockable", () => {
    expect(isNonEmptyCalleeTranscript("")).toBe(false);
    expect(isNonEmptyCalleeTranscript("   ")).toBe(false);
    expect(isNonEmptyCalleeTranscript("Estou")).toBe(true);
    expect(isShortCalleeGreeting("Estou")).toBe(true);
    expect(isShortCalleeGreeting("estou?")).toBe(true);
    expect(isShortCalleeGreeting("Estou?")).toBe(true);
    expect(isShortCalleeGreeting("«estou?»")).toBe(true);
    expect(isShortCalleeGreeting("estou ?")).toBe(true);
    expect(isShortCalleeGreeting("Estou.")).toBe(true);
    expect(isShortCalleeGreeting("estou eu")).toBe(true);
    expect(isShortCalleeGreeting("Alô")).toBe(true);
    expect(isShortCalleeGreeting("sim")).toBe(true);
    expect(isShortCalleeGreeting("ok")).toBe(true);
    expect(isShortCalleeGreeting("hello")).toBe(true);
    expect(isShortCalleeGreeting("Hello?")).toBe(true);
    expect(isShortCalleeGreeting("Still?")).toBe(true);
    expect(isShortCalleeGreeting("still")).toBe(true);
    expect(isShortCalleeGreeting("Esto?")).toBe(true);
    expect(isShortCalleeGreeting("esto")).toBe(true);
    expect(isShortCalleeGreeting("Two")).toBe(true);
    expect(isShortCalleeGreeting("Confirmar a marcação de quinta")).toBe(false);
  });

  it("reads estou? from nested Grok transcript payloads", () => {
    expect(calleeTranscriptFromEvent({ transcript: "estou?" })).toBe("estou?");
    expect(calleeTranscriptFromEvent({ transcript: { text: "Estou?" } })).toBe("Estou?");
    expect(
      calleeTranscriptFromEvent({
        item: { content: [{ transcript: "«estou?»" }] },
      }),
    ).toBe("«estou?»");
    expect(onTranscript(true, calleeTranscriptFromEvent({ transcript: { text: "estou?" } }))).toEqual({
      unlock: true,
      reason: "short_greeting",
    });
  });

  it("does not unlock on speech_started during the post-answer grace window (ringback/noise)", () => {
    const gate = createCalleeSpeechGate();
    noteStreamStart(gate, 0);
    const early = onSpeechStarted(gate, true, 200, config);
    expect(early).toEqual({ unlock: false, reason: "grace_period" });
    expect(gate.acceptedSpeechStartedAtMs).toBeUndefined();

    const atGraceEdge = onSpeechStarted(gate, true, 499, config);
    expect(atGraceEdge.reason).toBe("grace_period");
    expect(atGraceEdge.unlock).toBe(false);
  });

  it("does not unlock on speech_started alone after grace — waits for min duration or transcript", () => {
    const gate = createCalleeSpeechGate();
    noteStreamStart(gate, 0);
    const started = onSpeechStarted(gate, true, 500, config);
    expect(started).toEqual({ unlock: false, reason: "awaiting_min_duration" });
    expect(gate.acceptedSpeechStartedAtMs).toBe(500);
  });

  it("does not duration-unlock while speech_stopped is still inside grace (ringback)", () => {
    const gate = createCalleeSpeechGate();
    noteStreamStart(gate, 0);
    onSpeechStarted(gate, true, 100, config);
    const stopped = onSpeechStopped(gate, true, 400, config);
    expect(stopped).toEqual({ unlock: false, reason: "grace_period" });
  });

  it("unlocks a word-length «estou» that starts in grace and ends after grace even with empty ASR", () => {
    const gate = createCalleeSpeechGate();
    noteStreamStart(gate, 0);
    onSpeechStarted(gate, true, 350, config);
    const stopped = onSpeechStopped(gate, true, 500, config, 150);
    expect(stopped).toEqual({ unlock: true, reason: "min_speech_duration" });
  });

  it("unlocks after grace when speech lasts at least minSpeechMs", () => {
    const gate = createCalleeSpeechGate();
    noteStreamStart(gate, 0);
    onSpeechStarted(gate, true, 600, config);
    const tooShort = onSpeechStopped(gate, true, 600 + 50, config);
    expect(tooShort).toEqual({ unlock: false, reason: "speech_too_short" });

    onSpeechStarted(gate, true, 900, config);
    const ok = onSpeechStopped(gate, true, 900 + 130, config);
    expect(ok).toEqual({ unlock: true, reason: "min_speech_duration" });
  });

  it("uses VAD audio duration when speech_stopped provides it", () => {
    const gate = createCalleeSpeechGate();
    noteStreamStart(gate, 0);
    onSpeechStarted(gate, true, 700, config);
    const ok = onSpeechStopped(gate, true, 710, config, 140);
    expect(ok).toEqual({ unlock: true, reason: "min_speech_duration" });
  });

  it("does not unlock on empty transcript", () => {
    expect(onTranscript(true, "   ")).toEqual({ unlock: false, reason: "empty_transcript" });
    expect(onTranscript(true, "")).toEqual({ unlock: false, reason: "empty_transcript" });
  });

  it("unlocks immediately on short greetings including estou / estou? / alô / sim / ok / hello", () => {
    expect(onTranscript(true, "Estou")).toEqual({ unlock: true, reason: "short_greeting" });
    expect(onTranscript(true, "estou?")).toEqual({ unlock: true, reason: "short_greeting" });
    expect(onTranscript(true, "Estou?")).toEqual({ unlock: true, reason: "short_greeting" });
    expect(onTranscript(true, "«estou?»")).toEqual({ unlock: true, reason: "short_greeting" });
    expect(onTranscript(true, "alô")).toEqual({ unlock: true, reason: "short_greeting" });
    expect(onTranscript(true, "Sim.")).toEqual({ unlock: true, reason: "short_greeting" });
    expect(onTranscript(true, "ok")).toEqual({ unlock: true, reason: "short_greeting" });
    expect(onTranscript(true, "hello")).toEqual({ unlock: true, reason: "short_greeting" });
    expect(onTranscript(true, "Hello?")).toEqual({ unlock: true, reason: "short_greeting" });
    expect(onTranscript(true, "Still?")).toEqual({ unlock: true, reason: "short_greeting" });
    expect(onTranscript(true, "Esto?")).toEqual({ unlock: true, reason: "short_greeting" });
  });

  it("unlocks on first non-empty transcript even during grace", () => {
    const duringGrace = onTranscript(true, "Pois, pode dizer");
    expect(duringGrace).toEqual({ unlock: true, reason: "non_empty_transcript" });
  });

  it("remembers a word-length «estou» inside grace and unlocks as soon as grace ends", () => {
    const gate = createCalleeSpeechGate();
    noteStreamStart(gate, 0);
    onSpeechStarted(gate, true, 180, config);
    const during = onSpeechStopped(gate, true, 330, config, 150);
    expect(during).toEqual({ unlock: false, reason: "grace_period" });
    expect(hasPendingPostGraceUnlock(gate)).toBe(true);

    const stillInGrace = onPostGraceCheck(gate, true, 499, config);
    expect(stillInGrace).toEqual({ unlock: false, reason: "grace_period" });
    expect(hasPendingPostGraceUnlock(gate)).toBe(true);

    const afterGrace = onPostGraceCheck(gate, true, 500, config);
    expect(afterGrace).toEqual({ unlock: true, reason: "grace_elapsed" });
    expect(hasPendingPostGraceUnlock(gate)).toBe(false);
  });

  it("does not pending-unlock a sub-min click during grace", () => {
    const gate = createCalleeSpeechGate();
    noteStreamStart(gate, 0);
    onSpeechStarted(gate, true, 50, config);
    onSpeechStopped(gate, true, 80, config, 30);
    expect(hasPendingPostGraceUnlock(gate)).toBe(false);
    expect(onPostGraceCheck(gate, true, 500, config)).toEqual({
      unlock: false,
      reason: "no_accepted_utterance",
    });
  });

  it("unlocks pending grace speech on the first post-grace speech_started (no extra wait)", () => {
    const gate = createCalleeSpeechGate();
    noteStreamStart(gate, 0);
    onSpeechStarted(gate, true, 200, config);
    onSpeechStopped(gate, true, 360, config, 160);
    const started = onSpeechStarted(gate, true, 500, config);
    expect(started).toEqual({ unlock: true, reason: "grace_elapsed" });
  });

  it("does not unlock when not waiting", () => {
    const gate = createCalleeSpeechGate();
    noteStreamStart(gate, 0);
    expect(onSpeechStarted(gate, false, 2000, config)).toEqual({ unlock: false, reason: "not_waiting" });
    expect(onSpeechStopped(gate, false, 2300, config)).toEqual({ unlock: false, reason: "not_waiting" });
    expect(onTranscript(false, "Estou")).toEqual({ unlock: false, reason: "not_waiting" });
    expect(onPostGraceCheck(gate, false, 2000, config)).toEqual({ unlock: false, reason: "not_waiting" });
  });

  it("unlocks a ~90ms first-turn «estou» after grace even with empty ASR", () => {
    const gate = createCalleeSpeechGate();
    noteStreamStart(gate, 0);
    onSpeechStarted(gate, true, 520, config);
    const stopped = onSpeechStopped(gate, true, 610, config, 90);
    expect(stopped).toEqual({ unlock: true, reason: "min_speech_duration" });
  });

  it("queues a short in-grace «estou» of 90ms and unlocks when grace ends", () => {
    const gate = createCalleeSpeechGate();
    noteStreamStart(gate, 0);
    onSpeechStarted(gate, true, 200, config);
    const during = onSpeechStopped(gate, true, 290, config, 90);
    expect(during).toEqual({ unlock: false, reason: "grace_period" });
    expect(hasPendingPostGraceUnlock(gate)).toBe(true);
    expect(onPostGraceCheck(gate, true, 500, config)).toEqual({ unlock: true, reason: "grace_elapsed" });
  });

  it("unlocks a post-grace short answer after min speech without waiting for ASR", () => {
    const gate = createCalleeSpeechGate();
    noteStreamStart(gate, 0);
    onSpeechStarted(gate, true, 600, config);
    expect(onOngoingSpeechCheck(gate, true, 650, config)).toEqual({
      unlock: false,
      reason: "awaiting_min_duration",
    });
    expect(onOngoingSpeechCheck(gate, true, 680, config)).toEqual({
      unlock: true,
      reason: "short_answer",
    });
  });

  it("does not short-answer-unlock speech that started during grace", () => {
    const gate = createCalleeSpeechGate();
    noteStreamStart(gate, 0);
    onSpeechStarted(gate, true, 200, config);
    expect(onOngoingSpeechCheck(gate, true, 700, config)).toEqual({
      unlock: false,
      reason: "no_accepted_utterance",
    });
  });
});
