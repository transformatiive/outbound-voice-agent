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
    expect(text).toMatch(/NUNCA português do Brasil \(pt-BR\)|nunca «pt-BR»/i);
    expect(text).toMatch(/Oi, tudo bem/i);
    expect(text).toMatch(/bem-vindo ao restaurante/i);
    expect(text).toMatch(/NUNCA és o restaurante/i);
    expect(text).toMatch(/caller_booking/);
    expect(text).toMatch(/venue_staff/);
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
        expect(text).toMatch(/ementas/);
        expect(text).toMatch(/políticas/);
        expect(text).toMatch(/horário de abertura/);
        expect(text).toMatch(/só abre às/);
        expect(text).toMatch(/DO QUE ELE DISSE/);
        expect(text).toMatch(/pergunta curta/);
      } else {
        expect(text).toMatch(/exactly once/);
        expect(text).toMatch(/paraphrase it/);
        expect(text).toMatch(/Brief empathy/);
        expect(text).toMatch(/Answer the instant/);
        expect(text).toMatch(/NEVER invent facts/);
        expect(text).toMatch(/headcount/);
        expect(text).toMatch(/prices/);
        expect(text).toMatch(/menus/);
        expect(text).toMatch(/policies/);
        expect(text).toMatch(/opening hours/);
        expect(text).toMatch(/only opens at/);
        expect(text).toMatch(/THEIR statement/);
        expect(text).toMatch(/clarifying question/);
      }
      assertNoSpokenBranding(text);
    }
  });

  it("tracks booking/roleplay state from the interlocutor and never contradicts it", () => {
    const pt = buildSessionInstructions({
      language: "pt-PT",
      greeting: "Olá, boa tarde. Fala a secretária.",
      objective: "ROLEPLAY: quem atende. Reservar mesa no restaurante.",
      waitForCallee: true,
    });
    expect(pt).toMatch(/Foste tu a ligar/i);
    expect(pt).toMatch(/NUNCA és o restaurante/i);
    expect(pt).toMatch(/bem-vindo ao restaurante/i);
    expect(pt).toMatch(/fazer|confirmar|reserva|marcação/i);
    expect(pt).toMatch(/já estava marcado/i);
    expect(pt).toMatch(/NUNCA inventes nem desmintas|nunca desmintas/i);
    expect(pt).toMatch(/último turno/i);
    expect(pt).toMatch(/NUNCA leias[\s\S]*ROLEPLAY/);
    expect(pt).toMatch(/exactamente uma vez/);
    expect(pt).toMatch(/certo/);
    expect(pt).toMatch(/perfeito/);
    assertNoSpokenBranding(pt);

    const en = buildSessionInstructions({
      language: "en-GB",
      greeting: "Hello, good morning.",
      objective: "Book a table at the restaurant.",
      waitForCallee: true,
    });
    expect(en).toMatch(/You placed this call/i);
    expect(en).toMatch(/NEVER the restaurant/i);
    expect(en).toMatch(/welcome to the restaurant/i);
    expect(en).toMatch(/make, confirm, or handle a booking|booking/i);
    expect(en).toMatch(/already booked|already confirmed/i);
    expect(en).toMatch(/NEVER invent or deny/i);
    expect(en).toMatch(/last turn/i);
    expect(en).toMatch(/exactly once/);
    expect(en).toMatch(/Spoken word only/);
    assertNoSpokenBranding(en);
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

  it("asks only secretary booking questions and never venue headcount after they confirm", () => {
    const pt = buildSessionInstructions({
      language: "pt-PT",
      greeting: "Olá, boa tarde. Sou a secretária do Nuno Barreto.",
      objective: "Marcar um jantar para 2, nome Nuno Barreto, hoje à noite.",
      waitForCallee: true,
    });
    expect(pt).toMatch(/Perguntas \(és quem liga/);
    expect(pt).toMatch(/para quantas pessoas\?/);
    expect(pt).toMatch(/tá marcado/);
    expect(pt).toMatch(/mesa para 2, nome Nuno Barreto/);
    expect(pt).toMatch(/confirma os detalhes numa frase/);
    expect(pt).toMatch(/end_call/);
    assertNoSpokenBranding(pt);

    const en = buildSessionInstructions({
      language: "en-GB",
      greeting: "Hello, good evening. I'm calling from the secretary.",
      objective: "Book dinner for 2, name Nuno Barreto, tonight.",
      waitForCallee: true,
    });
    expect(en).toMatch(/you are the caller — never the house/i);
    expect(en).toMatch(/NEVER ask headcount/);
    expect(en).toMatch(/table for 2, name Nuno Barreto/);
    expect(en).toMatch(/After the venue confirms/);
    expect(en).toMatch(/thank them/i);
    assertNoSpokenBranding(en);
  });

  it("forbids inventing restaurant opening hours or other venue facts the callee did not state", () => {
    const pt = buildSessionInstructions({
      language: "pt-PT",
      greeting: "Olá, boa tarde. Fala a secretária.",
      objective: "Reservar mesa para 2 hoje à noite.",
      waitForCallee: true,
    });
    expect(pt).toMatch(/NUNCA inventes factos/);
    expect(pt).toMatch(/horário de abertura/);
    expect(pt).toMatch(/disponibilidade/);
    expect(pt).toMatch(/preços/);
    expect(pt).toMatch(/ementas/);
    expect(pt).toMatch(/políticas/);
    expect(pt).toMatch(/facto do estabelecimento/);
    expect(pt).toMatch(/só abre às 19h/);
    expect(pt).toMatch(/só abre às X/);
    expect(pt).toMatch(/Se propuser uma hora/);
    expect(pt).toMatch(/DO QUE ELE DISSE/);
    expect(pt).toMatch(/uma pergunta curta só se estiver ambíguo/);
    assertNoSpokenBranding(pt);

    const en = buildSessionInstructions({
      language: "en-GB",
      greeting: "Hello, good evening. I'm calling from the secretary.",
      objective: "Book a table for 2 tonight.",
      waitForCallee: true,
    });
    expect(en).toMatch(/NEVER invent facts/);
    expect(en).toMatch(/opening hours/);
    expect(en).toMatch(/availability/);
    expect(en).toMatch(/prices/);
    expect(en).toMatch(/menus/);
    expect(en).toMatch(/policies/);
    expect(en).toMatch(/venue fact/);
    expect(en).toMatch(/only opens at 7pm/);
    expect(en).toMatch(/only opens at X/);
    expect(en).toMatch(/If they propose a time/);
    expect(en).toMatch(/THEIR statement/);
    expect(en).toMatch(/one short clarifying question/);
    assertNoSpokenBranding(en);

    const us = buildSessionInstructions({
      language: "en-US",
      greeting: "Hello.",
      objective: "Book a table.",
    });
    expect(us).toMatch(/opening hours/);
    expect(us).toMatch(/only opens at/);
    expect(us).toMatch(/THEIR statement/);
    assertNoSpokenBranding(us);
  });
});
