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
    expect(pt.value.greeting).toBe("Olá, boa tarde. Confirmar a marcação.");
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
    expect(gb.value.greeting).toBe("Hello, good morning. Confirm the booking.");

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
    expect(us.value.greeting).toBe("Hello, good morning. Confirm the booking.");
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
    expect(explicit.value.greeting).toBe("Olá, boa tarde. Confirmar a marcação.");

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
    expect(inferred.value.greeting).toBe("Olá, boa tarde. Confirmar a marcação.");
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
