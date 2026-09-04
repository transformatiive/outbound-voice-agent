import { describe, expect, it } from "vitest";
import { grokRealtimeUrl, sessionUpdatePayload } from "../src/grok/session.js";

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
      greeting: "Olá, fala a Ara.",
      objective: "Confirmar marcação",
    });
    expect(payload.type).toBe("session.update");
    expect(payload.session.voice).toBe("ara");
    expect(payload.session.audio.input.format.type).toBe("audio/pcmu");
    expect(payload.session.audio.output.format.type).toBe("audio/pcmu");
    expect(payload.session.tools.some((t) => t.name === "end_call")).toBe(true);
    expect(payload.session.audio.input.transcription.language_hint).toBe("pt-PT");
    expect(payload.session.instructions).toMatch(/português europeu/i);
  });

  it("locks en-GB session instructions and ASR hint", () => {
    const payload = sessionUpdatePayload({
      voice: "ara",
      language: "en-GB",
      greeting: "Hello, this is Ara.",
      objective: "Confirm Thursday at 4pm",
    });
    expect(payload.session.voice).toBe("ara");
    expect(payload.session.audio.input.transcription.language_hint).toBe("en");
    expect(payload.session.instructions).toMatch(/British English/i);
    expect(payload.session.instructions).not.toMatch(/português europeu/i);
  });
});
