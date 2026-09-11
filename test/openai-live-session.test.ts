import { describe, expect, it } from "vitest";
import {
  GPT_LIVE_BRAZILIAN_VOICES,
  buildGptLiveBackendInstructions,
  buildGptLiveInstructions,
  gptLiveGreetingSpeakInstructions,
  gptLiveSessionStartPayload,
  openaiLiveUrl,
  parseGptLiveVoice,
} from "../src/openai/live-session.js";
import { DEFAULT_GPT_LIVE_MODEL, DEFAULT_GPT_LIVE_VOICE } from "../src/tts.js";

describe("GPT-Live session", () => {
  it("targets the Live websocket without a model query string", () => {
    expect(openaiLiveUrl("https://api.openai.com")).toBe("wss://api.openai.com/v1/live/sessions");
    expect(openaiLiveUrl("https://api.openai.com/")).toBe("wss://api.openai.com/v1/live/sessions");
  });

  it("starts gpt-live-1 with Telnyx PCMU, marin, Responses tools, and a pt-PT lock", () => {
    const payload = gptLiveSessionStartPayload({
      language: "pt-PT",
      greeting: "Boa tarde, sou a secretária da empresa. Confirmar quinta às 16h.",
      objective: "Confirmar marcação",
      ivr: true,
    });
    expect(payload.type).toBe("session.start");
    expect(payload.session.model).toBe(DEFAULT_GPT_LIVE_MODEL);
    expect(payload.session.audio.format).toEqual({ type: "audio/pcmu", rate: 8000 });
    expect(payload.session.audio.output.voice).toBe(DEFAULT_GPT_LIVE_VOICE);
    expect(GPT_LIVE_BRAZILIAN_VOICES).not.toContain(payload.session.audio.output.voice);
    expect(payload.session.instructions).toMatch(/português europeu/i);
    expect(payload.session.instructions).toMatch(/NUNCA português do Brasil/);
    expect(payload.session.instructions).toMatch(/você/);
    expect(payload.session.instructions).toMatch(/Oi/);
    expect(payload.session.instructions).not.toMatch(/\bAra\b/);
    expect(payload.session.delegation.type).toBe("responses");
    expect(payload.session.delegation.responses.tools.some((t) => t.name === "end_call")).toBe(true);
    expect(payload.session.delegation.responses.tools.some((t) => t.name === "send_dtmf")).toBe(true);
    expect(payload.session.delegation.responses.instructions).toMatch(/português europeu/i);
    expect(payload.session.delegation.responses.instructions).toMatch(/Confirmar marcação/);
    expect(payload.session.instructions).toMatch(/IVR/);
  });

  it("writes the live prompt in European Portuguese and never defaults to bossa/tempo", () => {
    const live = buildGptLiveInstructions({
      language: "pt-PT",
      greeting: "Boa tarde, sou a secretária.",
      objective: "Marcar mesa",
    });
    expect(live).toMatch(/português europeu de Portugal/);
    expect(live).toMatch(/telemóvel nunca celular/);
    expect(live.startsWith("You are")).toBe(false);
    const backend = buildGptLiveBackendInstructions({
      language: "pt-PT",
      greeting: "Boa tarde, sou a secretária.",
      objective: "Marcar mesa",
    });
    expect(backend).toMatch(/então fica marcado para|recap/i);
    expect(gptLiveGreetingSpeakInstructions("pt-PT", "Boa tarde.")).toMatch(/português europeu/i);
  });

  it("parses GPT-Live voices including marin and rejects unknown names", () => {
    expect(parseGptLiveVoice(undefined)).toEqual({ ok: true, value: "marin" });
    expect(parseGptLiveVoice("coral")).toEqual({ ok: true, value: "coral" });
    expect(parseGptLiveVoice("vesper")).toEqual({ ok: true, value: "vesper" });
    expect(parseGptLiveVoice("robot")).toEqual({ ok: false });
  });
});
