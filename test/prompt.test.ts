import { describe, expect, it } from "vitest";
import { LANGUAGES, buildSessionInstructions, languageHint, isLanguage } from "../src/prompt.js";

describe("prompt / language", () => {
  it("is PT-PT only", () => {
    expect([...LANGUAGES]).toEqual(["pt-PT"]);
    expect(isLanguage("pt-PT")).toBe(true);
    expect(isLanguage("en-GB")).toBe(false);
    expect(isLanguage("en-US")).toBe(false);
    expect(isLanguage("pt-BR")).toBe(false);
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
    expect(text).not.toMatch(/British English/i);
    expect(text).not.toMatch(/American English/i);
  });

  it("maps language_hint to pt-PT for Grok ASR", () => {
    expect(languageHint("pt-PT")).toBe("pt-PT");
  });
});
