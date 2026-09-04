import { describe, expect, it } from "vitest";
import { LANGUAGES, buildSessionInstructions, languageHint } from "../src/prompt.js";

describe("prompt / language", () => {
  it("accepts only pt-PT, en-GB, and en-US", () => {
    expect([...LANGUAGES].sort()).toEqual(["en-GB", "en-US", "pt-PT"]);
  });

  it("locks pt-PT to European Portuguese, never Brazilian", () => {
    const text = buildSessionInstructions({
      language: "pt-PT",
      greeting: "Olá, fala a Ara.",
      objective: "Confirmar a marcação de quinta às 16h",
    });
    expect(text).toMatch(/português europeu/i);
    expect(text).toMatch(/telemóvel/);
    expect(text).toMatch(/nunca.*celular/i);
    expect(text).toContain("Confirmar a marcação de quinta às 16h");
    expect(text).toMatch(/end_call/);
  });

  it("locks en-GB to British English and en-US to American English", () => {
    const gb = buildSessionInstructions({
      language: "en-GB",
      greeting: "Hello, this is Ara.",
      objective: "Confirm Thursday 4pm",
    });
    const us = buildSessionInstructions({
      language: "en-US",
      greeting: "Hello, this is Ara.",
      objective: "Confirm Thursday 4pm",
    });
    expect(gb).toMatch(/British English/i);
    expect(us).toMatch(/American English/i);
    expect(gb).toMatch(/do not repeat the greeting/i);
    expect(us).toMatch(/end_call/);
  });

  it("maps language_hint to xAI BCP-47 codes", () => {
    expect(languageHint("pt-PT")).toBe("pt-PT");
    expect(languageHint("en-GB")).toBe("en");
    expect(languageHint("en-US")).toBe("en");
  });
});
