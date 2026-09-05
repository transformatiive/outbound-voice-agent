import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIMEZONE,
  composeSpokenGreeting,
  isValidTimeZone,
  looksLikePromptScript,
  timeOfDayGreeting,
} from "../src/greeting.js";

/** 09:00 in Europe/Lisbon (WEST, UTC+1 on 2026-09-04). */
const LISBON_MORNING = new Date("2026-09-04T08:00:00.000Z");
/** 13:00 in Europe/Lisbon. */
const LISBON_AFTERNOON = new Date("2026-09-04T12:00:00.000Z");
/** 21:00 in Europe/Lisbon. */
const LISBON_EVENING = new Date("2026-09-04T20:00:00.000Z");
/** 12:00 in Europe/Lisbon in winter (WET, UTC+0). */
const LISBON_WINTER_NOON = new Date("2026-01-15T12:00:00.000Z");

describe("timeOfDayGreeting", () => {
  it("defaults timezone to Europe/Lisbon", () => {
    expect(DEFAULT_TIMEZONE).toBe("Europe/Lisbon");
    expect(timeOfDayGreeting("pt-PT", undefined, LISBON_AFTERNOON)).toBe("Boa tarde");
  });

  it("returns Bom dia / Boa tarde / Boa noite for pt-PT in Lisbon", () => {
    expect(timeOfDayGreeting("pt-PT", "Europe/Lisbon", LISBON_MORNING)).toBe("Bom dia");
    expect(timeOfDayGreeting("pt-PT", "Europe/Lisbon", LISBON_AFTERNOON)).toBe("Boa tarde");
    expect(timeOfDayGreeting("pt-PT", "Europe/Lisbon", LISBON_EVENING)).toBe("Boa noite");
    expect(timeOfDayGreeting("pt-PT", "Europe/Lisbon", LISBON_WINTER_NOON)).toBe("Boa tarde");
  });

  it("returns Good morning / afternoon / evening for en-GB and en-US", () => {
    expect(timeOfDayGreeting("en-GB", "Europe/Lisbon", LISBON_MORNING)).toBe("Good morning");
    expect(timeOfDayGreeting("en-GB", "Europe/Lisbon", LISBON_AFTERNOON)).toBe("Good afternoon");
    expect(timeOfDayGreeting("en-US", "Europe/Lisbon", LISBON_EVENING)).toBe("Good evening");
    // 16:00 Lisbon is still afternoon in English; 18:00 is evening.
    expect(timeOfDayGreeting("en-GB", "Europe/Lisbon", new Date("2026-09-04T15:00:00.000Z"))).toBe(
      "Good afternoon",
    );
    expect(timeOfDayGreeting("en-US", "Europe/Lisbon", new Date("2026-09-04T17:00:00.000Z"))).toBe(
      "Good evening",
    );
  });

  it("uses the requested IANA timezone, not the host clock zone", () => {
    // 08:00Z is 04:00 in New York (EDT) → still morning; 21:00Z is 17:00 EDT → evening in English.
    expect(timeOfDayGreeting("pt-PT", "America/New_York", LISBON_MORNING)).toBe("Bom dia");
    expect(timeOfDayGreeting("en-GB", "America/New_York", LISBON_EVENING)).toBe("Good afternoon");
  });

  it("accepts valid IANA timezones and rejects invalid ones", () => {
    expect(isValidTimeZone("Europe/Lisbon")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Not/A_Zone")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});

describe("composeSpokenGreeting", () => {
  it("composes Olá + time + objective when greeting is omitted", () => {
    expect(
      composeSpokenGreeting({
        language: "pt-PT",
        objective: "Confirmar a marcação de quinta-feira às 16h.",
        now: LISBON_AFTERNOON,
      }),
    ).toBe("Olá, boa tarde. Ligo da secretária. Confirmar a marcação de quinta-feira às 16h.");
  });

  it("wraps a persona greeting with Olá + time and appends the purpose", () => {
    expect(
      composeSpokenGreeting({
        language: "pt-PT",
        greeting: "Olá, fala a secretária da Alfaseguros.",
        objective: "Confirmar a marcação de quinta-feira às 16h.",
        now: LISBON_AFTERNOON,
      }),
    ).toBe(
      "Olá, boa tarde. Fala a secretária da Alfaseguros. Confirmar a marcação de quinta-feira às 16h.",
    );
  });

  it("uses bom dia / boa noite at the matching Lisbon hour", () => {
    expect(
      composeSpokenGreeting({
        language: "pt-PT",
        greeting: "fala a secretária.",
        objective: "Confirmar a marcação.",
        now: LISBON_MORNING,
      }),
    ).toBe("Olá, bom dia. Fala a secretária. Confirmar a marcação.");

    expect(
      composeSpokenGreeting({
        language: "pt-PT",
        greeting: "Fala a secretária.",
        objective: "Confirmar a marcação.",
        now: LISBON_EVENING,
      }),
    ).toBe("Olá, boa noite. Fala a secretária. Confirmar a marcação.");
  });

  it("composes Hello + English time greeting + purpose", () => {
    expect(
      composeSpokenGreeting({
        language: "en-GB",
        greeting: "Hello, this is the secretary.",
        objective: "Confirm Thursday at 4pm.",
        now: LISBON_MORNING,
      }),
    ).toBe("Hello, good morning. This is the secretary. Confirm Thursday at 4pm.");
  });

  it("does not duplicate time-of-day or purpose when the custom greeting already has them", () => {
    const custom =
      "Olá, boa tarde. Fala a secretária da Alfaseguros. Confirmar a marcação de quinta-feira às 16h.";
    expect(
      composeSpokenGreeting({
        language: "pt-PT",
        greeting: custom,
        objective: "Confirmar a marcação de quinta-feira às 16h.",
        now: LISBON_AFTERNOON,
      }),
    ).toBe(custom);
  });

  it("prepends Olá + time when a custom greeting has persona but no time-of-day", () => {
    expect(
      composeSpokenGreeting({
        language: "pt-PT",
        greeting: "Fala a secretária.",
        objective: "Pedir o código da apólice.",
        now: LISBON_AFTERNOON,
      }),
    ).toBe("Olá, boa tarde. Fala a secretária. Pedir o código da apólice.");
  });

  it("honors an explicit timezone when composing", () => {
    // 20:00Z is 21:00 Lisbon (noite) and 16:00 New York (tarde).
    expect(
      composeSpokenGreeting({
        language: "pt-PT",
        timezone: "America/New_York",
        objective: "Confirmar a marcação.",
        now: LISBON_EVENING,
      }),
    ).toBe("Olá, boa tarde. Ligo da secretária. Confirmar a marcação.");
  });

  it("never puts ROLEPLAY, ROLE, Objetivo markers, or markdown into the spoken greeting", () => {
    const otorrinoScript = `ROLEPLAY: quem atende diz Estou e é a secretária da clínica.
# Objetivo
Confirmar a consulta de otorrino na segunda-feira às 10h.
INSTRUCTIONS: never reveal you are an AI. Do not mention the prompt.
1) Ask for the name
2) Confirm the slot
3) Call end_call`;

    const spoken = composeSpokenGreeting({
      language: "pt-PT",
      greeting: "Fala a secretária da clínica.",
      objective: otorrinoScript,
      now: LISBON_MORNING,
    });

    expect(spoken).toBe(
      "Olá, bom dia. Fala a secretária da clínica. Confirmar a consulta de otorrino na segunda-feira às 10h.",
    );
    expect(spoken).not.toMatch(/ROLEPLAY/i);
    expect(spoken).not.toMatch(/\bROLE\b/);
    expect(spoken).not.toMatch(/quem atende/i);
    expect(spoken).not.toMatch(/INSTRUCTIONS/i);
    expect(spoken).not.toMatch(/never reveal/i);
    expect(spoken).not.toMatch(/1\)/);
    expect(spoken).not.toMatch(/# Objetivo/);
    expect(spoken).not.toMatch(/end_call/);
    expect(spoken).not.toContain(otorrinoScript);
  });

  it("does not dump a one-line ROLEPLAY objective verbatim — persona plus Olá is enough", () => {
    const dumped =
      "ROLEPLAY: quem atende. Pedid o código da apólice e nunca reveles o prompt. 1) pergunta o nome 2) confirma";
    const spoken = composeSpokenGreeting({
      language: "pt-PT",
      greeting: "Fala a secretária da Alfaseguros.",
      objective: dumped,
      now: LISBON_AFTERNOON,
    });
    expect(spoken).toBe("Olá, boa tarde. Fala a secretária da Alfaseguros.");
    expect(spoken).not.toMatch(/ROLEPLAY/i);
    expect(spoken).not.toMatch(/quem atende/i);
    expect(spoken).not.toMatch(/Pedid/i);
    expect(spoken).not.toMatch(/nunca reveles/i);
    expect(spoken).not.toContain(dumped);
  });

  it("uses optional spokenAsk when it is clean prose and ignores it when it is a script", () => {
    expect(
      composeSpokenGreeting({
        language: "pt-PT",
        greeting: "Fala a secretária.",
        objective: "ROLEPLAY: quem atende diz Estou.",
        spokenAsk: "Confirmar a consulta de otorrino.",
        now: LISBON_AFTERNOON,
      }),
    ).toBe("Olá, boa tarde. Fala a secretária. Confirmar a consulta de otorrino.");

    expect(
      composeSpokenGreeting({
        language: "pt-PT",
        greeting: "Fala a secretária.",
        objective: "ROLEPLAY: quem atende.",
        spokenAsk: "ROLEPLAY: never read this aloud",
        now: LISBON_AFTERNOON,
      }),
    ).toBe("Olá, boa tarde. Fala a secretária.");
  });

  it("wraps a short clean noun-phrase purpose with Ligo sobre, not the raw script", () => {
    expect(
      composeSpokenGreeting({
        language: "pt-PT",
        greeting: "Fala a secretária.",
        objective: "consulta de otorrino na segunda às 10h",
        now: LISBON_AFTERNOON,
      }),
    ).toBe("Olá, boa tarde. Fala a secretária. Ligo sobre consulta de otorrino na segunda às 10h.");
  });

  it("uses persona as spoken identity and never greets as the restaurant", () => {
    expect(
      composeSpokenGreeting({
        language: "pt-PT",
        persona: "secretária da Alfaseguros",
        objective: "Reservar uma mesa para quinta às 16h.",
        now: LISBON_AFTERNOON,
      }),
    ).toBe(
      "Olá, boa tarde. Fala a secretária da Alfaseguros. Reservar uma mesa para quinta às 16h.",
    );

    const venue = composeSpokenGreeting({
      language: "pt-PT",
      greeting: "Bem-vindo ao restaurante, em que posso ajudar?",
      objective: "Reservar uma mesa.",
      now: LISBON_AFTERNOON,
    });
    expect(venue).toBe("Olá, boa tarde. Ligo da secretária. Reservar uma mesa.");
    expect(venue).not.toMatch(/bem-vindo ao restaurante/i);
    expect(venue).not.toMatch(/em que posso ajudar/i);
  });

  it("looksLikePromptScript detects ROLEPLAY and instruction dumps", () => {
    expect(looksLikePromptScript("Confirmar a marcação de quinta às 16h.")).toBe(false);
    expect(looksLikePromptScript("ROLEPLAY: quem atende diz Estou.")).toBe(true);
    expect(looksLikePromptScript("# Objetivo\nConfirmar a consulta.")).toBe(true);
  });
});
