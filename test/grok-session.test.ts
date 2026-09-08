import { describe, expect, it } from "vitest";
import { grokRealtimeUrl, sessionUpdatePayload, GROK_REASONING_EFFORT, GROK_TRANSCRIBE_MODEL, parseGrokVoice } from "../src/grok/session.js";

describe("Grok Voice Live 2 session", () => {
  it("targets the xAI realtime websocket with the configured model", () => {
    expect(grokRealtimeUrl("https://api.x.ai", "grok-voice-think-fast-2.0")).toBe(
      "wss://api.x.ai/v1/realtime?model=grok-voice-think-fast-2.0",
    );
  });

  it("pins voice ara, PT-PT, and PCMU for Telnyx PSTN passthrough", () => {
    const payload = sessionUpdatePayload({
      voice: "ara",
      language: "pt-PT",
      greeting: "Olá, fala a secretária.",
      objective: "Confirmar marcação",
    });
    expect(payload.type).toBe("session.update");
    expect(payload.session.voice).toBe("ara");
    expect(payload.session.audio.input.format.type).toBe("audio/pcmu");
    expect(payload.session.audio.output.format.type).toBe("audio/pcmu");
    expect(payload.session.audio.output.speed).toBe(1.05);
    expect(payload.session.tools.some((t) => t.name === "end_call")).toBe(true);
    expect(payload.session.audio.input.transcription.language_hint).toBe("pt-PT");
    expect(payload.session.audio.input.transcription.model).toBe(GROK_TRANSCRIBE_MODEL);
    expect(payload.session.instructions).toMatch(/português europeu/i);
    expect(payload.session.instructions).toMatch(/pt-BR/);
    expect(payload.session.instructions).toMatch(/NUNCA és o restaurante/);
    expect(payload.session.instructions).not.toMatch(/\bAra\b/);
    expect(payload.session.instructions).not.toMatch(/gravad/i);
    expect(payload.session.turn_detection).toEqual({
      type: "server_vad",
      threshold: 0.5,
      silence_duration_ms: 130,
      prefix_padding_ms: 200,
      idle_timeout_ms: 12_000,
      create_response: true,
      interrupt_response: true,
    });
    expect(payload.session.reasoning).toEqual({ effort: GROK_REASONING_EFFORT });
    expect(GROK_REASONING_EFFORT).toBe("none");
    expect(payload.session.tools[0]?.description).toMatch(/thank-you/i);
    expect(payload.session.tools[0]?.description).not.toMatch(/summary/i);
    expect(payload.session.tools[0]?.description).toMatch(/recap/i);
    expect(payload.session.tools.some((t) => t.name === "send_dtmf")).toBe(true);
    expect(payload.session.instructions).toMatch(/send_dtmf/);
    expect(payload.session.instructions).toMatch(/então fica marcado para/);
    expect(payload.session.instructions).toMatch(/Não narres/i);
    expect(payload.session.instructions).not.toMatch(/confirma os detalhes numa frase/);
  });

  it("puts wait-for-callee flow into session instructions when waitForCallee is true", () => {
    const payload = sessionUpdatePayload({
      voice: "ara",
      language: "pt-PT",
      greeting: "Olá, fala a secretária.",
      objective: "Confirmar marcação",
      waitForCallee: true,
    });
    expect(payload.session.instructions).toMatch(/Espera em silêncio até o destinatário falar/i);
    expect(payload.session.instructions).toMatch(/NUNCA inventes factos/);
    expect(payload.session.instructions).toMatch(/exactamente uma vez/);
    expect(payload.session.instructions).not.toMatch(/já está a ser dita/i);
    expect(payload.session.turn_detection.create_response).toBe(false);
    expect(payload.session.turn_detection.idle_timeout_ms).toBeUndefined();
    expect(payload.session.turn_detection.interrupt_response).toBe(true);
  });

  it("locks en-GB session instructions and ASR hint", () => {
    const payload = sessionUpdatePayload({
      voice: "ara",
      language: "en-GB",
      greeting: "Hello, this is the secretary.",
      objective: "Confirm Thursday at 4pm",
    });
    expect(payload.session.voice).toBe("ara");
    expect(payload.session.audio.input.transcription.language_hint).toBe("en");
    expect(payload.session.audio.input.transcription.model).toBe("grok-transcribe");
    expect(payload.session.instructions).toMatch(/British English/i);
    expect(payload.session.instructions).not.toMatch(/português europeu/i);
  });

  it("uses caller turnDetection overrides on session.update", () => {
    const payload = sessionUpdatePayload({
      voice: "ara",
      language: "pt-PT",
      greeting: "Olá.",
      objective: "x",
      turnDetection: {
        threshold: 0.6,
        silenceDurationMs: 300,
        prefixPaddingMs: 180,
        idleTimeoutMs: 10_000,
      },
    });
    expect(payload.session.turn_detection.silence_duration_ms).toBe(300);
    expect(payload.session.turn_detection.threshold).toBe(0.6);
    expect(payload.session.turn_detection.prefix_padding_ms).toBe(180);
  });

  it("keeps voice ara and wires documented audio.output.speed", () => {
    const payload = sessionUpdatePayload({
      voice: "ara",
      language: "pt-PT",
      greeting: "Olá.",
      objective: "x",
      outputSpeed: 1.05,
      createResponse: false,
    });
    expect(payload.session.voice).toBe("ara");
    expect(payload.session.audio.output.speed).toBe(1.05);
    expect(payload.session.turn_detection.create_response).toBe(false);
    expect(payload.session.turn_detection.interrupt_response).toBe(true);
  });

  it("parses grok_voice and rejects unknown names", () => {
    expect(parseGrokVoice(undefined).ok).toBe(true);
    expect(parseGrokVoice("rex")).toEqual({ ok: true, value: "rex" });
    expect(parseGrokVoice("Leo")).toEqual({ ok: true, value: "leo" });
    expect(parseGrokVoice("robot")).toEqual({ ok: false });
  });

  it("applies male voice rex on session.update", () => {
    const payload = sessionUpdatePayload({
      voice: "rex",
      language: "pt-PT",
      greeting: "Olá.",
      objective: "x",
    });
    expect(payload.session.voice).toBe("rex");
  });
});
