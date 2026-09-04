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
    expect(text).toMatch(/Responde no instante/);
    expect(text).toMatch(/NUNCA inventes factos/);
    expect(text).toMatch(/número de pessoas/);
    expect(text).toMatch(/calorosa/);
    expect(text).toMatch(/exactamente uma vez/);
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
    expect(gb).toMatch(/Answer the instant the callee finishes/);
    expect(us).toMatch(/person on a live phone call/);
    expect(gb).toMatch(/NEVER invent facts/);
    expect(us).toMatch(/headcount/);
    expect(gb).toMatch(/exactly once/);
    expect(gb).toMatch(/warm, attentive, natural/);
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
    expect(text).toMatch(/Saudação já entregue \(uma vez/);
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
    expect(pt).toMatch(/exactamente uma vez/);
    expect(pt).toMatch(/Uma pergunta de cada vez/);
    expect(pt).toMatch(/NUNCA inventes factos/);
    expect(pt).not.toMatch(/já está a ser dita/i);
    expect(pt).not.toMatch(/Saudação já entregue \(uma vez/);
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
    expect(en).toMatch(/exactly once/);
    expect(en).toMatch(/One question at a time/);
    expect(en).toMatch(/NEVER invent facts/);
    expect(en).not.toMatch(/already being spoken/i);
    expect(en).not.toMatch(/Greeting already delivered \(once/);
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

  it("tells the model to go straight to the objective after the greeting", () => {
    const pt = buildSessionInstructions({
      language: "pt-PT",
      greeting: "Olá, boa tarde. Fala a secretária. Confirmar a marcação.",
      objective: "Confirmar a marcação",
      waitForCallee: true,
      timezone: "Europe/Lisbon",
      timeGreeting: "Boa tarde",
    });
    expect(pt).toMatch(/vai direto ao objetivo/i);
    expect(pt).toMatch(/primeira pergunta curta/);
    expect(pt).toMatch(/Não alongues o nome/);
    expect(pt).toMatch(/Hora local \(Europe\/Lisbon\)/);
    expect(pt).toMatch(/boa tarde/i);
    expect(pt).toMatch(/tom plano|não plana|expressiva/i);
    expect(pt).toMatch(/Espera em silêncio até o destinatário falar/i);
    assertNoSpokenBranding(pt);

    const en = buildSessionInstructions({
      language: "en-GB",
      greeting: "Hello, good morning. This is the secretary. Confirm Thursday.",
      objective: "Confirm Thursday",
      waitForCallee: true,
      timezone: "Europe/Lisbon",
      timeGreeting: "Good morning",
    });
    expect(en).toMatch(/go straight to the objective/i);
    expect(en).toMatch(/short first (ask|question)/i);
    expect(en).toMatch(/Do not linger on (the )?(name|title)/i);
    expect(en).toMatch(/Local time \(Europe\/Lisbon\)/);
    expect(en).toMatch(/good morning/i);
    expect(en).toMatch(/not flat|expressive/i);
    expect(en).toMatch(/Wait silently until the callee speaks/i);
    assertNoSpokenBranding(en);
  });

  it("hardens greeting-once, phone empathy, instant replies, and no invented facts", () => {
    const languages: Language[] = ["pt-PT", "en-GB", "en-US"];
    for (const language of languages) {
      const text = buildSessionInstructions({
        language,
        greeting: defaultGreeting(language),
        objective: "x",
        waitForCallee: true,
      });
      if (language === "pt-PT") {
        expect(text).toMatch(/exactamente uma vez/);
        expect(text).toMatch(/não a parafraseies/i);
        expect(text).toMatch(/Empatia breve/);
        expect(text).toMatch(/Responde no instante/);
        expect(text).toMatch(/NUNCA inventes factos/);
        expect(text).toMatch(/número de pessoas/);
        expect(text).toMatch(/preços/);
        expect(text).toMatch(/pergunta curta/);
      } else {
        expect(text).toMatch(/exactly once/);
        expect(text).toMatch(/paraphrase it/);
        expect(text).toMatch(/Brief empathy/);
        expect(text).toMatch(/Answer the instant/);
        expect(text).toMatch(/NEVER invent facts/);
        expect(text).toMatch(/headcount/);
        expect(text).toMatch(/prices/);
        expect(text).toMatch(/clarifying question/);
      }
      assertNoSpokenBranding(text);
    }
  });

  it("asks for a human phone voice: warmth, certo/perfeito, no numbered lists, no ROLEPLAY dump", () => {
    const pt = buildSessionInstructions({
      language: "pt-PT",
      greeting: "Olá, boa tarde. Fala a secretária.",
      objective: "ROLEPLAY: quem atende. Confirmar a consulta.",
      waitForCallee: true,
    });
    expect(pt).toMatch(/certo/);
    expect(pt).toMatch(/perfeito/);
    expect(pt).toMatch(/assistente de chat/);
    expect(pt).toMatch(/NUNCA leias listas numeradas/);
    expect(pt).toMatch(/Palavra falada/);
    expect(pt).toMatch(/NUNCA leias[\s\S]*ROLEPLAY/);
    assertNoSpokenBranding(pt);

    const en = buildSessionInstructions({
      language: "en-GB",
      greeting: "Hello, good morning.",
      objective: "Confirm Thursday",
    });
    expect(en).toMatch(/chat assistant/);
    expect(en).toMatch(/numbered lists/);
    expect(en).toMatch(/natural confirmations/);
    expect(en).toMatch(/perfect/);
    expect(en).toMatch(/full goodbye/);
    expect(en).toMatch(/Spoken word only/);
    assertNoSpokenBranding(en);
  });
});
