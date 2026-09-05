import { describe, expect, it } from "vitest";
import {
  openaiGreetingResponseCreate,
  openaiGreetingSpeakInstructions,
  openaiRealtimeUrl,
  openaiSessionUpdatePayload,
  parseOpenAIVoice,
} from "../src/openai/session.js";

describe("OpenAI Realtime session", () => {
  it("targets the OpenAI realtime websocket with the configured model", () => {
    expect(openaiRealtimeUrl("https://api.openai.com", "gpt-realtime-2.1")).toBe(
      "wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1",
    );
    expect(openaiRealtimeUrl("https://api.openai.com/", "gpt-realtime-2.1")).toBe(
      "wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1",
    );
  });

  it("uses GA session shape with audio/pcmu for Telnyx PCMU passthrough and pt-PT lock", () => {
    const payload = openaiSessionUpdatePayload({
      voice: "coral",
      model: "gpt-realtime-2.1",
      language: "pt-PT",
      greeting: "Olá, fala a secretária.",
      objective: "Confirmar marcação",
      waitForCallee: true,
    });
    expect(payload.type).toBe("session.update");
    expect(payload.session.type).toBe("realtime");
    expect(payload.session.model).toBe("gpt-realtime-2.1");
    expect(payload.session.output_modalities).toEqual(["audio"]);
    expect(payload.session.audio.output.voice).toBe("coral");
    expect(payload.session.audio.input.format.type).toBe("audio/pcmu");
    expect(payload.session.audio.output.format.type).toBe("audio/pcmu");
    expect(payload.session.audio.input.transcription.language).toBe("pt");
    expect(payload.session.audio.input.transcription.prompt).toMatch(/pt-PT/);
    expect(payload.session.instructions).toMatch(/português europeu/i);
    expect(payload.session.instructions).toMatch(/pt-BR/);
    expect(payload.session.instructions).toMatch(/NUNCA és o restaurante/);
    expect(payload.session.instructions).toMatch(/Espera em silêncio até o destinatário falar/i);
    expect(payload.session.instructions).not.toMatch(/\bAra\b/);
    expect(payload.session.instructions).not.toMatch(/gravad/i);
    expect(payload.session.audio.input.turn_detection).toEqual({
      type: "server_vad",
      threshold: 0.5,
      silence_duration_ms: 160,
      prefix_padding_ms: 200,
      create_response: false,
      interrupt_response: true,
    });
    expect(payload.session.tools.some((t) => t.name === "end_call")).toBe(true);
  });

  it("pre-generates greeting audio out of band (generate early, not in conversation)", () => {
    const event = openaiGreetingResponseCreate({
      callId: "call-1",
      language: "pt-PT",
      greeting: "Olá, fala a secretária.",
    });
    expect(event.type).toBe("response.create");
    expect(event.response.conversation).toBe("none");
    expect(event.response.output_modalities).toEqual(["audio"]);
    expect(event.response.metadata.purpose).toBe("greeting");
    expect(event.response.instructions).toContain("Olá, fala a secretária.");
    expect(openaiGreetingSpeakInstructions("pt-PT", "Olá.")).toMatch(/português europeu/i);
  });

  it("parses openai_voice and rejects unknown names", () => {
    expect(parseOpenAIVoice(undefined).ok).toBe(true);
    expect(parseOpenAIVoice("marin")).toEqual({ ok: true, value: "marin" });
    expect(parseOpenAIVoice("Coral")).toEqual({ ok: true, value: "coral" });
    expect(parseOpenAIVoice("robot")).toEqual({ ok: false });
  });
});
