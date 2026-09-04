import { describe, expect, it } from "vitest";
import {
  LANGUAGES,
  buildSessionInstructions,
  defaultGreeting,
  instructionsRequestWait,
  languageHint,
  isLanguage,
  type Language,
} from "../src/prompt.js";

function assertNoSpokenBranding(text: string): void {
  expect(text).not.toMatch(/\bAra\b/);
  expect(text).not.toMatch(/\bGrok\b/i);
  expect(text).not.toMatch(/gravad/i);
  expect(text).not.toMatch(/being recorded/i);
  expect(text).not.toMatch(/call is recorded/i);
  expect(text).not.toMatch(/esta chamada é gravada/i);
}

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
    expect(text).toMatch(/pessoa ao telefone/);
    expect(text).toMatch(/Responde logo a seguir/);
    assertNoSpokenBranding(text);
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
    expect(gb).toMatch(/Answer as soon as the callee finishes/);
    expect(us).toMatch(/person on the phone/);
    assertNoSpokenBranding(gb);
    assertNoSpokenBranding(us);
  });

  it("maps language_hint to xAI BCP-47 codes", () => {
    expect(languageHint("pt-PT")).toBe("pt-PT");
    expect(languageHint("en-GB")).toBe("en");
    expect(languageHint("en-US")).toBe("en");
  });

  it("provides language-specific greeting defaults with no product name or recording line", () => {
    expect(defaultGreeting("pt-PT")).toBe("Olá.");
    expect(defaultGreeting("en-GB")).toBe("Hello.");
    expect(defaultGreeting("en-US")).toBe("Hello.");
    for (const language of LANGUAGES) {
      const greeting = defaultGreeting(language);
      assertNoSpokenBranding(greeting);
      expect(greeting).not.toMatch(/sou a/i);
      expect(greeting).not.toMatch(/this is Ara/i);
      expect(greeting).not.toMatch(/fala a Ara/i);
    }
  });

  it("immediate greeting flow tells the model the greeting is already being spoken", () => {
    const text = buildSessionInstructions({
      language: "pt-PT",
      greeting: defaultGreeting("pt-PT"),
      objective: "Confirmar a marcação",
    });
    expect(text).toMatch(/já está a ser dita/i);
    expect(text).toMatch(/Saudação já entregue/);
    expect(text).not.toMatch(/Espera em silêncio/);
    assertNoSpokenBranding(text);
  });

  it("waitForCallee flow tells the model to stay silent until the callee speaks", () => {
    const pt = buildSessionInstructions({
      language: "pt-PT",
      greeting: "Olá, fala a secretária.",
      objective: "Confirmar a marcação",
      waitForCallee: true,
    });
    expect(pt).toMatch(/Espera em silêncio até o destinatário falar/i);
    expect(pt).toMatch(/Não fales antes/);
    expect(pt).toMatch(/depois de o destinatário falar/i);
    expect(pt).toMatch(/Uma pergunta de cada vez/);
    expect(pt).not.toMatch(/já está a ser dita/i);
    expect(pt).not.toMatch(/Saudação já entregue/);
    assertNoSpokenBranding(pt);

    const en = buildSessionInstructions({
      language: "en-GB",
      greeting: "Hello, this is the secretary.",
      objective: "Confirm Thursday",
      waitForCallee: true,
    });
    expect(en).toMatch(/Wait silently until the callee speaks/i);
    expect(en).toMatch(/Do not speak before that/);
    expect(en).toMatch(/After the greeting/i);
    expect(en).toMatch(/One question at a time/);
    expect(en).not.toMatch(/already being spoken/i);
    expect(en).not.toMatch(/Greeting already delivered/);
    assertNoSpokenBranding(en);
  });

  it("detects wait-until-callee-speaks intent in extra instructions", () => {
    expect(instructionsRequestWait(undefined)).toBe(false);
    expect(instructionsRequestWait("One question at a time.")).toBe(false);
    expect(instructionsRequestWait("Wait silently until the callee speaks.")).toBe(true);
    expect(instructionsRequestWait("Do not speak until the callee answers.")).toBe(true);
    expect(
      instructionsRequestWait("Espera em silêncio até o destinatário falar, por exemplo Estou."),
    ).toBe(true);
    expect(instructionsRequestWait("Não fales até a pessoa falar.")).toBe(true);
  });

  it("session instructions never name Ara or say the call is recorded", () => {
    const languages: Language[] = ["pt-PT", "en-GB", "en-US"];
    for (const language of languages) {
      const immediate = buildSessionInstructions({
        language,
        greeting: defaultGreeting(language),
        objective: "x",
      });
      const waiting = buildSessionInstructions({
        language,
        greeting: defaultGreeting(language),
        objective: "x",
        waitForCallee: true,
      });
      assertNoSpokenBranding(immediate);
      assertNoSpokenBranding(waiting);
    }
  });
});
