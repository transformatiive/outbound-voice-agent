import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_GENDER,
  defaultClosingRule,
  genderedThanks,
  inferAgentGender,
  spokenCallClosing,
} from "../src/closing.js";
import { DEFAULT_TIMEZONE, timeOfDayGreeting } from "../src/greeting.js";
import { DEFAULT_ELEVENLABS_VOICE_ID, RECOMMENDED_ELEVENLABS_VOICE_ID_ALT } from "../src/tts.js";

/** 09:00 in Europe/Lisbon (WEST, UTC+1 on 2026-09-04). */
const LISBON_MORNING = new Date("2026-09-04T08:00:00.000Z");
/** 13:00 in Europe/Lisbon. */
const LISBON_AFTERNOON = new Date("2026-09-04T12:00:00.000Z");
/** 21:00 in Europe/Lisbon. */
const LISBON_EVENING = new Date("2026-09-04T20:00:00.000Z");
/** 12:00 in Europe/Lisbon in winter (WET, UTC+0). */
const LISBON_WINTER_NOON = new Date("2026-01-15T12:00:00.000Z");

describe("inferAgentGender", () => {
  it("defaults to feminine when persona, greeting, and voice are unknown", () => {
    expect(DEFAULT_AGENT_GENDER).toBe("feminine");
    expect(inferAgentGender({})).toBe("feminine");
    expect(inferAgentGender({ greeting: "Olá.", persona: "", voice: "unknown" })).toBe("feminine");
  });

  it("reads sou a / fala a as feminine and sou o / fala o as masculine", () => {
    expect(inferAgentGender({ greeting: "Boa tarde. Sou a secretária do Nuno." })).toBe("feminine");
    expect(inferAgentGender({ persona: "sou a assistente do André Barreto" })).toBe("feminine");
    expect(inferAgentGender({ greeting: "Fala a secretária da Alfaseguros." })).toBe("feminine");
    expect(inferAgentGender({ greeting: "Boa tarde. Sou o secretário da Alfaseguros." })).toBe(
      "masculine",
    );
    expect(inferAgentGender({ persona: "secretário da empresa" })).toBe("masculine");
  });

  it("does not treat «do Nuno» as a masculine speaker", () => {
    expect(inferAgentGender({ persona: "secretária do Nuno Barreto" })).toBe("feminine");
  });

  it("uses known feminine/masculine TTS voices only when identity is silent", () => {
    expect(inferAgentGender({ voice: "marin" })).toBe("feminine");
    expect(inferAgentGender({ voice: "coral" })).toBe("feminine");
    expect(inferAgentGender({ voice: "ara" })).toBe("feminine");
    expect(inferAgentGender({ voice: DEFAULT_ELEVENLABS_VOICE_ID })).toBe("feminine");
    expect(inferAgentGender({ voice: RECOMMENDED_ELEVENLABS_VOICE_ID_ALT })).toBe("feminine");
    expect(inferAgentGender({ voice: "rex" })).toBe("masculine");
    expect(inferAgentGender({ voice: "leo" })).toBe("masculine");
    expect(inferAgentGender({ voice: "echo" })).toBe("masculine");
    expect(inferAgentGender({ greeting: "Sou a secretária.", voice: "rex" })).toBe("feminine");
  });
});

describe("genderedThanks", () => {
  it("uses muito obrigada by default and muito obrigado for a masculine agent", () => {
    expect(genderedThanks("pt-PT")).toBe("muito obrigada");
    expect(genderedThanks("pt-PT", "feminine")).toBe("muito obrigada");
    expect(genderedThanks("pt-PT", "masculine")).toBe("muito obrigado");
    expect(genderedThanks("en-GB", "feminine")).toBe("thank you");
    expect(genderedThanks("en-US", "masculine")).toBe("thank you");
  });

  it("never emits Brazilian obrigado(a) as a spoken form", () => {
    expect(genderedThanks("pt-PT")).not.toMatch(/obrigado\(a\)/i);
    expect(genderedThanks("pt-PT", "masculine")).not.toMatch(/obrigado\(a\)/i);
  });
});

describe("spokenCallClosing", () => {
  it("thanks then farewells with Lisbon time-of-day from timeOfDayGreeting", () => {
    expect(DEFAULT_TIMEZONE).toBe("Europe/Lisbon");
    expect(timeOfDayGreeting("pt-PT", "Europe/Lisbon", LISBON_MORNING)).toBe("Bom dia");
    expect(timeOfDayGreeting("pt-PT", "Europe/Lisbon", LISBON_AFTERNOON)).toBe("Boa tarde");
    expect(timeOfDayGreeting("pt-PT", "Europe/Lisbon", LISBON_EVENING)).toBe("Boa noite");
    expect(timeOfDayGreeting("pt-PT", "Europe/Lisbon", LISBON_WINTER_NOON)).toBe("Boa tarde");

    expect(
      spokenCallClosing({ language: "pt-PT", timezone: "Europe/Lisbon", now: LISBON_MORNING }),
    ).toBe("Muito obrigada. Bom dia.");
    expect(
      spokenCallClosing({ language: "pt-PT", timezone: "Europe/Lisbon", now: LISBON_AFTERNOON }),
    ).toBe("Muito obrigada. Boa tarde.");
    expect(
      spokenCallClosing({ language: "pt-PT", timezone: "Europe/Lisbon", now: LISBON_EVENING }),
    ).toBe("Muito obrigada. Boa noite.");
    expect(
      spokenCallClosing({ language: "pt-PT", timezone: "Europe/Lisbon", now: LISBON_WINTER_NOON }),
    ).toBe("Muito obrigada. Boa tarde.");
  });

  it("switches to muito obrigado when the greeting identity is masculine", () => {
    expect(
      spokenCallClosing({
        language: "pt-PT",
        greeting: "Boa tarde. Sou o secretário da Alfaseguros.",
        now: LISBON_AFTERNOON,
      }),
    ).toBe("Muito obrigado. Boa tarde.");
  });

  it("uses an explicit timeGreeting instead of recomputing the hour", () => {
    expect(
      spokenCallClosing({
        language: "pt-PT",
        timeGreeting: "Boa noite",
        now: LISBON_MORNING,
      }),
    ).toBe("Muito obrigada. Boa noite.");
  });

  it("pairs English thank-you with the same Lisbon hour cutoffs as greetings", () => {
    expect(
      spokenCallClosing({ language: "en-GB", timezone: "Europe/Lisbon", now: LISBON_MORNING }),
    ).toBe("Thank you. Good morning.");
    expect(
      spokenCallClosing({ language: "en-GB", timezone: "Europe/Lisbon", now: LISBON_AFTERNOON }),
    ).toBe("Thank you. Good afternoon.");
    expect(
      spokenCallClosing({ language: "en-US", timezone: "Europe/Lisbon", now: LISBON_EVENING }),
    ).toBe("Thank you. Good evening.");
  });
});

describe("defaultClosingRule", () => {
  it("bakes the spoken thank-you and Lisbon farewell into the instruction snippet", () => {
    const rule = defaultClosingRule({
      language: "pt-PT",
      greeting: "Boa tarde. Sou a secretária do Nuno.",
      timezone: "Europe/Lisbon",
      now: LISBON_AFTERNOON,
    });
    expect(rule).toMatch(/Encerramento/);
    expect(rule).toMatch(/muito obrigada/i);
    expect(rule).toMatch(/Boa tarde/);
    expect(rule).toMatch(/Europe\/Lisbon/);
    expect(rule).toMatch(/end_call/);
    expect(rule).not.toMatch(/obrigado\(a\)/);
    expect(rule).not.toMatch(/\bAra\b/);
    expect(rule).not.toMatch(/gravad/i);
    expect(rule).toMatch(/Muito obrigada\. Boa tarde\./);
  });

  it("uses muito obrigado in the snippet when gender is masculine", () => {
    const rule = defaultClosingRule({
      language: "pt-PT",
      persona: "secretário da Alfaseguros",
      now: LISBON_EVENING,
    });
    expect(rule).toMatch(/muito obrigado/i);
    expect(rule).not.toMatch(/muito obrigada/i);
    expect(rule).toMatch(/Boa noite/);
  });
});
