import { describe, expect, it } from "vitest";
import {
  LANGUAGES,
  buildSessionInstructions,
  defaultGreeting,
  languageHint,
  isLanguage,
} from "../src/prompt.js";

describe("prompt / language", () => {
  it("accepts pt-PT, en-GB, and en-US", () => {
    expect([...LANGUAGES]).toEqual(["pt-PT", "en-GB", "en-US"]);
    expect(isLanguage("pt-PT")).toBe(true);
    expect(isLanguage("en-GB")).toBe(true);
    expect(isLanguage("en-US")).toBe(true);
    expect(isLanguage("pt-BR")).toBe(false);
    expect(isLanguage("fr-FR")).toBe(false);
  });

  it("locks pt-PT to European Portuguese, never Brazilian", () => {
    const text = buildSessionInstructions({
      language: "pt-PT",
      greeting: defaultGreeting("pt-PT"),
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

  it("locks en-GB to natural British English and en-US to natural American English", () => {
    const gb = buildSessionInstructions({
      language: "en-GB",
      greeting: defaultGreeting("en-GB"),
      objective: "Confirm Thursday at 4pm",
    });
    const us = buildSessionInstructions({
      language: "en-US",
      greeting: defaultGreeting("en-US"),
      objective: "Confirm Thursday at 4pm",
    });
    expect(gb).toMatch(/British English/i);
    expect(gb).toMatch(/mobile/);
    expect(gb).not.toMatch(/português europeu/i);
    expect(us).toMatch(/American English/i);
    expect(us).not.toMatch(/British English/i);
    expect(us).not.toMatch(/português europeu/i);
    expect(gb).toMatch(/end_call/);
    expect(us).toMatch(/end_call/);
  });

  it("maps language_hint to xAI BCP-47 codes", () => {
    expect(languageHint("pt-PT")).toBe("pt-PT");
    expect(languageHint("en-GB")).toBe("en");
    expect(languageHint("en-US")).toBe("en");
  });

  it("provides language-specific greeting defaults", () => {
    expect(defaultGreeting("pt-PT")).toMatch(/Olá/);
    expect(defaultGreeting("en-GB")).toMatch(/^Hello,/);
    expect(defaultGreeting("en-US")).toMatch(/^Hi,/);
    expect(defaultGreeting("en-GB")).toMatch(/recorded/i);
    expect(defaultGreeting("en-US")).toMatch(/recorded/i);
  });
});
