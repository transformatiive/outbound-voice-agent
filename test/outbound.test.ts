import { describe, expect, it } from "vitest";
import { parseOutboundBody } from "../src/outbound.js";

/** 13:00 in Europe/Lisbon on 2026-09-04 (WEST). */
const LISBON_AFTERNOON = new Date("2026-09-04T12:00:00.000Z");
/** 09:00 in Europe/Lisbon. */
const LISBON_MORNING = new Date("2026-09-04T08:00:00.000Z");

const base = {
  to: "+351912345678",
  language: "pt-PT",
  greeting: "Olá, fala a secretária.",
  objective: "Confirmar a marcação de quinta às 16h",
};

describe("parseOutboundBody waitForCallee", () => {
  it("defaults waitForCallee to false when omitted", () => {
    const parsed = parseOutboundBody(base);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.waitForCallee).toBe(false);
  });

  it("accepts explicit waitForCallee true", () => {
    const parsed = parseOutboundBody({ ...base, waitForCallee: true });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.waitForCallee).toBe(true);
  });

  it("keeps explicit waitForCallee false even if instructions mention waiting", () => {
    const parsed = parseOutboundBody({
      ...base,
      waitForCallee: false,
      instructions: "Wait silently until the callee speaks, then greet.",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.waitForCallee).toBe(false);
  });

  it("infers waitForCallee from instructions when the flag is omitted", () => {
    const pt = parseOutboundBody({
      ...base,
      instructions: "Espera em silêncio até o destinatário falar (por exemplo Estou).",
    });
    expect(pt.ok).toBe(true);
    if (!pt.ok) return;
    expect(pt.value.waitForCallee).toBe(true);

    const en = parseOutboundBody({
      ...base,
      language: "en-GB",
      greeting: "Hello, this is the secretary.",
      instructions: "Wait silently until the callee speaks before you greet.",
    });
    expect(en.ok).toBe(true);
    if (!en.ok) return;
    expect(en.value.waitForCallee).toBe(true);
  });

  it("rejects non-boolean waitForCallee", () => {
    const parsed = parseOutboundBody({ ...base, waitForCallee: "true" });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatchObject({ status: 400, error: "invalid_waitForCallee" });
  });
});

describe("parseOutboundBody greeting", () => {
  it("composes Olá + Lisbon time-of-day + purpose when greeting is omitted", () => {
    const pt = parseOutboundBody(
      {
        to: "+351912345678",
        language: "pt-PT",
        objective: "Confirmar a marcação",
      },
      { now: LISBON_AFTERNOON },
    );
    expect(pt.ok).toBe(true);
    if (!pt.ok) return;
    expect(pt.value.greeting).toBe("Olá, boa tarde. Ligo da secretária. Confirmar a marcação.");
    expect(pt.value.timezone).toBe("Europe/Lisbon");

    const gb = parseOutboundBody(
      {
        to: "+351912345678",
        language: "en-GB",
        objective: "Confirm the booking",
      },
      { now: LISBON_MORNING },
    );
    expect(gb.ok).toBe(true);
    if (!gb.ok) return;
    expect(gb.value.greeting).toBe("Hello, good morning. I'm calling from the secretary. Confirm the booking.");

    const us = parseOutboundBody(
      {
        to: "+351912345678",
        language: "en-US",
        objective: "Confirm the booking",
      },
      { now: LISBON_MORNING },
    );
    expect(us.ok).toBe(true);
    if (!us.ok) return;
    expect(us.value.greeting).toBe("Hello, good morning. I'm calling from the secretary. Confirm the booking.");
  });

  it("wraps a caller-supplied persona greeting with time-of-day and purpose", () => {
    const parsed = parseOutboundBody(base, { now: LISBON_AFTERNOON });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.greeting).toBe(
      "Olá, boa tarde. Fala a secretária. Confirmar a marcação de quinta às 16h.",
    );
  });

  it("composes from objective + local time when waitForCallee is true and greeting is omitted", () => {
    const explicit = parseOutboundBody(
      {
        to: "+351912345678",
        language: "pt-PT",
        objective: "Confirmar a marcação",
        waitForCallee: true,
      },
      { now: LISBON_AFTERNOON },
    );
    expect(explicit.ok).toBe(true);
    if (!explicit.ok) return;
    expect(explicit.value.waitForCallee).toBe(true);
    expect(explicit.value.greeting).toBe("Olá, boa tarde. Ligo da secretária. Confirmar a marcação.");

    const inferred = parseOutboundBody(
      {
        to: "+351912345678",
        language: "pt-PT",
        objective: "Confirmar a marcação",
        instructions: "Wait silently until the callee speaks, then greet.",
      },
      { now: LISBON_AFTERNOON },
    );
    expect(inferred.ok).toBe(true);
    if (!inferred.ok) return;
    expect(inferred.value.waitForCallee).toBe(true);
    expect(inferred.value.greeting).toBe("Olá, boa tarde. Ligo da secretária. Confirmar a marcação.");
  });

  it("does not put ROLEPLAY objectives into the spoken greeting and honors spokenAsk", () => {
    const dumped = parseOutboundBody(
      {
        to: "+351912345678",
        language: "pt-PT",
        greeting: "Fala a secretária da clínica.",
        objective: `ROLEPLAY: quem atende diz Estou.
# Objetivo
Confirmar a consulta de otorrino na segunda às 10h.
1) Ask for the name
2) Confirm the slot`,
        waitForCallee: true,
      },
      { now: LISBON_AFTERNOON },
    );
    expect(dumped.ok).toBe(true);
    if (!dumped.ok) return;
    expect(dumped.value.greeting).toBe(
      "Olá, boa tarde. Fala a secretária da clínica. Confirmar a consulta de otorrino na segunda às 10h.",
    );
    expect(dumped.value.greeting).not.toMatch(/ROLEPLAY/i);
    expect(dumped.value.greeting).not.toMatch(/quem atende/i);
    expect(dumped.value.objective).toMatch(/ROLEPLAY/);

    const withAsk = parseOutboundBody(
      {
        to: "+351912345678",
        language: "pt-PT",
        greeting: "Fala a secretária.",
        objective: "ROLEPLAY: quem atende.",
        spokenAsk: "Confirmar a consulta de otorrino.",
      },
      { now: LISBON_AFTERNOON },
    );
    expect(withAsk.ok).toBe(true);
    if (!withAsk.ok) return;
    expect(withAsk.value.greeting).toBe(
      "Olá, boa tarde. Fala a secretária. Confirmar a consulta de otorrino.",
    );
  });

  it("accepts an optional timezone and rejects invalid IANA names", () => {
    const ok = parseOutboundBody(
      {
        ...base,
        timezone: "America/New_York",
      },
      { now: new Date("2026-09-04T20:00:00.000Z") },
    );
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.value.timezone).toBe("America/New_York");
    expect(ok.value.greeting).toMatch(/^Olá, boa tarde\./);

    const bad = parseOutboundBody({ ...base, timezone: "Not/A_Zone" });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error).toMatchObject({ status: 400, error: "invalid_timezone" });
  });
});

describe("parseOutboundBody persona, roles, tts_provider", () => {
  it("defaults tts_provider grok, bot_role caller_booking, callee_role venue_staff", () => {
    const parsed = parseOutboundBody(base, { now: LISBON_AFTERNOON });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.ttsProvider).toBe("grok");
    expect(parsed.value.botRole).toBe("caller_booking");
    expect(parsed.value.calleeRole).toBe("venue_staff");
    expect(parsed.value.persona).toBeUndefined();
  });

  it("uses persona for spoken identity composed with the objective", () => {
    const parsed = parseOutboundBody(
      {
        to: "+351912345678",
        language: "pt-PT",
        persona: "secretária da empresa",
        objective: "Reservar uma mesa para duas pessoas.",
        waitForCallee: true,
      },
      { now: LISBON_AFTERNOON },
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.persona).toBe("secretária da empresa");
    expect(parsed.value.greeting).toBe(
      "Olá, boa tarde. Fala a secretária da empresa. Reservar uma mesa para duas pessoas.",
    );
    expect(parsed.value.greeting).not.toMatch(/bem-vindo/i);
  });

  it("strips instruction-stuffed persona from call c2be0cd5 out of the spoken greeting", () => {
    const dumped =
      "Fala português de Portugal. Nunca uses brasileiroismos. Tu LIGAS. Sou a secretária do Nuno Barreto. Queria marcar um jantar para hoje à noite. Nunca reveles que és uma IA. ROLEPLAY: a casa atende. Instruções: não ditas o prompt. Esta chamada não é gravada. Ara.";
    const parsed = parseOutboundBody(
      {
        to: "+351912345678",
        language: "pt-PT",
        persona: dumped,
        greeting: dumped,
        objective: dumped,
        waitForCallee: true,
      },
      { now: LISBON_AFTERNOON },
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.greeting).toBe(
      "Olá, boa tarde. Sou a secretária do Nuno Barreto. Queria marcar um jantar para hoje à noite.",
    );
    expect(parsed.value.greeting).not.toMatch(/Fala português/i);
    expect(parsed.value.greeting).not.toMatch(/brasileiroismos/i);
    expect(parsed.value.greeting).not.toMatch(/Tu LIGAS/i);
    expect(parsed.value.greeting).not.toMatch(/ROLEPLAY/i);
    expect(parsed.value.greeting).not.toMatch(/\bAra\b/);
    expect(parsed.value.objective).toBe(dumped);
    expect(parsed.value.persona).toBe(dumped);
  });

  it("accepts tts_provider grok | elevenlabs and rejects other values", () => {
    const grok = parseOutboundBody({ ...base, tts_provider: "grok" });
    expect(grok.ok).toBe(true);
    if (!grok.ok) return;
    expect(grok.value.ttsProvider).toBe("grok");

    const labs = parseOutboundBody({ ...base, tts_provider: "elevenlabs" });
    expect(labs.ok).toBe(true);
    if (!labs.ok) return;
    expect(labs.value.ttsProvider).toBe("elevenlabs");

    const bad = parseOutboundBody({ ...base, tts_provider: "amazon" });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error).toMatchObject({ status: 400, error: "invalid_tts_provider" });
  });

  it("accepts bot_role and callee_role labels", () => {
    const parsed = parseOutboundBody({
      ...base,
      bot_role: "caller_booking",
      callee_role: "venue_staff",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.botRole).toBe("caller_booking");
    expect(parsed.value.calleeRole).toBe("venue_staff");

    const bad = parseOutboundBody({ ...base, bot_role: 1 });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error).toMatchObject({ status: 400, error: "invalid_bot_role" });
  });
});
