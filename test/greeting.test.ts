import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIMEZONE,
  composeSpokenGreeting,
  isValidTimeZone,
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
    ).toBe("Olá, boa tarde. Confirmar a marcação de quinta-feira às 16h.");
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
    ).toBe("Olá, boa tarde. Confirmar a marcação.");
  });
});
