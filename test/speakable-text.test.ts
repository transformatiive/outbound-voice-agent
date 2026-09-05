import { describe, expect, it } from "vitest";
import { firstSentenceAndRest, takeCompleteSentences } from "../src/bridge/speakable-text.js";

describe("takeCompleteSentences", () => {
  it("holds text until a sentence boundary", () => {
    expect(takeCompleteSentences("Perfeito, mesa para")).toEqual({
      complete: [],
      rest: "Perfeito, mesa para",
    });
  });

  it("releases each finished sentence and keeps the trailing fragment", () => {
    expect(takeCompleteSentences("Perfeito. Mesa para as 18h")).toEqual({
      complete: ["Perfeito."],
      rest: "Mesa para as 18h",
    });
  });

  it("releases every finished sentence including a terminal one", () => {
    expect(takeCompleteSentences("Certo. Perfeito, às 18h.")).toEqual({
      complete: ["Certo.", "Perfeito, às 18h."],
      rest: "",
    });
  });

  it("splits the first sentence from the remaining spoken tail", () => {
    expect(firstSentenceAndRest("Perfeito. Mesa para as 18h.")).toEqual({
      first: "Perfeito.",
      rest: "Mesa para as 18h.",
    });
    expect(firstSentenceAndRest("Certo.")).toEqual({ first: "Certo.", rest: "" });
    expect(firstSentenceAndRest("Mesa para as 18h")).toEqual({
      first: "Mesa para as 18h",
      rest: "",
    });
  });

  it("treats ellipsis and question marks as boundaries", () => {
    expect(takeCompleteSentences("Alô? Está? Sim")).toEqual({
      complete: ["Alô?", "Está?"],
      rest: "Sim",
    });
  });
});
