import { describe, expect, it } from "vitest";
import {
  DEFAULT_POST_OPENING_PAUSE_MS,
  greetingIntroCacheKey,
  pcmuSilenceFrames,
  spokenGreetingBeats,
} from "../src/bridge/greeting-cadence.js";

describe("greeting cadence", () => {
  it("splits time-of-day from identity so playback can pause and listen", () => {
    expect(spokenGreetingBeats("Boa tarde. Sou a secretária do Nuno Barreto. Confirmar quinta.")).toEqual({
      opening: "Boa tarde.",
      intro: "Sou a secretária do Nuno Barreto. Confirmar quinta.",
    });
  });

  it("skips the second beat when the greeting is a single sentence", () => {
    expect(spokenGreetingBeats("Olá, fala a secretária.")).toEqual({
      opening: "Olá, fala a secretária.",
      intro: "",
    });
  });

  it("emits μ-law silence frames for the post-opening pause and none when duration is 0", () => {
    expect(DEFAULT_POST_OPENING_PAUSE_MS).toBe(550);
    expect(pcmuSilenceFrames(0)).toEqual([]);
    const frames = pcmuSilenceFrames(DEFAULT_POST_OPENING_PAUSE_MS);
    expect(frames.length).toBe(28);
    expect(Buffer.from(frames[0] ?? "", "base64").every((b) => b === 0xff)).toBe(true);
    expect(greetingIntroCacheKey("call-1")).toBe("call-1::intro");
  });
});
