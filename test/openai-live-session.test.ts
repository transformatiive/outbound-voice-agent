import { describe, expect, it } from "vitest";
import {
  GPT_LIVE_BRAZILIAN_VOICES,
  buildGptLiveBackendInstructions,
  buildGptLiveInstructions,
  gptLiveExpressiveVoiceInstructions,
  gptLiveGreetingCommentary,
  gptLiveGreetingCommentaryAppend,
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
    expect(payload.session.audio.output).toEqual({ voice: DEFAULT_GPT_LIVE_VOICE });
    expect(payload.session.audio.output).not.toHaveProperty("speed");
    expect(JSON.stringify(payload.session.audio)).not.toMatch(/"speed"/);
    expect(payload.session.instructions).toMatch(/ChatGPT Voice/);
    expect(payload.session.instructions).toMatch(/«hmm»/);
    expect(payload.session.instructions).toMatch(/IVR/);
    expect(payload.session.instructions).toMatch(/uma frase/i);
    expect(payload.session.instructions).toMatch(/PARA e escuta/);
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
    expect(payload.session.delegation.responses.instructions).toMatch(/nunca inventes/i);
    expect(payload.session.instructions).toMatch(/IVR/);
    expect(payload.session.instructions).toMatch(/Confirmar marcação/);
    expect(payload.session.instructions).toMatch(/nunca inventes/i);
    expect(payload.session.instructions).toMatch(/Objetivo \(interno/);
    expect(payload.session.instructions).toMatch(/simulação/);
    expect(payload.session.instructions).toMatch(/isto é um teste/);
    expect(payload.session.delegation.responses.instructions).toMatch(/simulação/);
    expect(payload.session.instructions).toMatch(/muito obrigada/i);
    expect(payload.session.delegation.responses.instructions).toMatch(/muito obrigada/i);
  });

  it("injects the shared Lisbon thank-you + time-of-day close into live and backend prompts", () => {
    const afternoon = new Date("2026-09-04T12:00:00.000Z");
    const payload = gptLiveSessionStartPayload({
      language: "pt-PT",
      greeting: "Boa tarde. Sou a secretária do Nuno.",
      objective: "Reservar mesa na Capricciosa.",
      timezone: "Europe/Lisbon",
      now: afternoon,
    });
    expect(payload.session.instructions).toMatch(/Muito obrigada\. Boa tarde\./);
    expect(payload.session.instructions).toMatch(/Europe\/Lisbon/);
    expect(payload.session.instructions).not.toMatch(/obrigado\(a\)/);
    expect(payload.session.delegation.responses.instructions).toMatch(/Muito obrigada\. Boa tarde\./);
    expect(payload.session.delegation.responses.instructions).toMatch(/Europe\/Lisbon/);

    const masculine = buildGptLiveInstructions({
      language: "pt-PT",
      greeting: "Boa noite. Sou o secretário da Alfaseguros.",
      objective: "Confirmar a marcação.",
      now: new Date("2026-09-04T20:00:00.000Z"),
    });
    expect(masculine).toMatch(/Muito obrigado\. Boa noite\./);
    expect(masculine).not.toMatch(/muito obrigada/i);
  });

  it("writes the live prompt in European Portuguese and never defaults to bossa/tempo", () => {
    const live = buildGptLiveInstructions({
      language: "pt-PT",
      greeting: "Boa tarde, sou a secretária.",
      objective: "Marcar mesa",
    });
    expect(live).toMatch(/português europeu de Portugal/);
    expect(live).toMatch(/telemóvel nunca celular/);
    expect(live).toMatch(/ChatGPT Voice/);
    expect(live).toMatch(/«certo»/);
    expect(live).toMatch(/PROIBIDO tom de menu automático/);
    expect(live.startsWith("You are")).toBe(false);
    const backend = buildGptLiveBackendInstructions({
      language: "pt-PT",
      greeting: "Boa tarde, sou a secretária.",
      objective: "Marcar mesa",
    });
    expect(backend).toMatch(/então fica marcado para|recap/i);
    expect(gptLiveGreetingSpeakInstructions("pt-PT", "Boa tarde.")).toMatch(/português europeu/i);
    expect(gptLiveGreetingSpeakInstructions("pt-PT", "Boa tarde.")).toMatch(/AGORA/);
    expect(gptLiveGreetingSpeakInstructions("pt-PT", "Boa tarde.")).toMatch(/imediatamente/);
    expect(gptLiveGreetingSpeakInstructions("en-GB", "Good afternoon.")).toMatch(/Greet the caller now/i);
    expect(gptLiveGreetingSpeakInstructions("en-GB", "Good afternoon.")).toMatch(/Begin speaking immediately/);
  });

  it("keeps ChatGPT Voice delivery in session.instructions only — no persona field, no audio.output.speed", () => {
    const expressive = gptLiveExpressiveVoiceInstructions("pt-PT");
    expect(expressive).toMatch(/«hmm»/);
    expect(expressive).toMatch(/«certo»/);
    expect(expressive).toMatch(/PROIBIDO tom de menu automático/);
    expect(expressive).toMatch(/uma frase/i);
    expect(expressive).toMatch(/PARA e escuta/);
    expect(expressive).toMatch(/pt-PT/);
    expect(expressive).toMatch(/Zero português do Brasil/);
    const payload = gptLiveSessionStartPayload({
      language: "pt-PT",
      greeting: "Boa tarde. Sou a secretária do Nuno Barreto.",
      objective: "Marcar mesa",
    });
    expect(payload.session.instructions).toContain(expressive);
    expect(payload.session).not.toHaveProperty("persona");
    expect(JSON.stringify(payload)).not.toMatch(/"persona"/);
    expect(payload.session.audio.output).toEqual({ voice: DEFAULT_GPT_LIVE_VOICE });
    expect(payload.session.audio.output).not.toHaveProperty("speed");
    expect(JSON.stringify(payload.session.audio.output)).not.toMatch(/speed/);
    expect(payload.session.delegation.responses.instructions).not.toContain(expressive);
  });

  it("parses GPT-Live voices including marin and rejects unknown names", () => {
    expect(parseGptLiveVoice(undefined)).toEqual({ ok: true, value: "marin" });
    expect(parseGptLiveVoice("coral")).toEqual({ ok: true, value: "coral" });
    expect(parseGptLiveVoice("vesper")).toEqual({ ok: true, value: "vesper" });
    expect(parseGptLiveVoice("robot")).toEqual({ ok: false });
  });

  it("uses commentary.append for the spoken line; greeting itself is instructions.append", () => {
    const opening = "Boa tarde. Sou a secretária do Nuno.";
    expect(gptLiveGreetingCommentary("pt-PT", opening)).toBe(opening);
    expect(gptLiveGreetingCommentary("pt-PT", opening)).not.toMatch(/Começa agora/);
    const event = gptLiveGreetingCommentaryAppend({
      callId: "call-1",
      language: "pt-PT",
      greeting: opening,
    });
    expect(event.type).toBe("session.commentary.append");
    expect(event.delegation_id).toBeNull();
    expect(event.content).toBe(opening);
  });
});
