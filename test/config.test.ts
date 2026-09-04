import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("config", () => {
  it("defaults caller ID, Grok voice ara, Live 2 model, and Telnyx app/OVP ids", () => {
    const cfg = loadConfig({
      API_KEY: "k",
      TELNYX_API_KEY: "t",
      XAI_API_KEY: "x",
      PUBLIC_BASE_URL: "https://example.up.railway.app",
    });
    expect(cfg.fromNumber).toBe("+351210210260");
    expect(cfg.grokVoice).toBe("ara");
    expect(cfg.grokModel).toBe("grok-voice-think-fast-2.0");
    expect(cfg.telnyxConnectionId).toBe("3041732714274227469");
    expect(cfg.telnyxOutboundVoiceProfileId).toBe("3041732644774610184");
    expect(cfg.publicBaseUrl).toBe("https://example.up.railway.app");
    expect(cfg.turnDetection).toEqual({
      threshold: 0.5,
      silenceDurationMs: 350,
      prefixPaddingMs: 200,
      idleTimeoutMs: 12_000,
    });
  });

  it("honors GROK_VAD_* env overrides and clamps them", () => {
    const cfg = loadConfig({
      API_KEY: "k",
      TELNYX_API_KEY: "t",
      XAI_API_KEY: "x",
      PUBLIC_BASE_URL: "https://example.up.railway.app",
      GROK_VAD_THRESHOLD: "0.7",
      GROK_VAD_SILENCE_MS: "400",
      GROK_VAD_PREFIX_PADDING_MS: "150",
      GROK_VAD_IDLE_TIMEOUT_MS: "8000",
    });
    expect(cfg.turnDetection).toEqual({
      threshold: 0.7,
      silenceDurationMs: 400,
      prefixPaddingMs: 150,
      idleTimeoutMs: 8000,
    });

    const clamped = loadConfig({
      API_KEY: "k",
      TELNYX_API_KEY: "t",
      XAI_API_KEY: "x",
      PUBLIC_BASE_URL: "https://example.up.railway.app",
      GROK_VAD_THRESHOLD: "9",
      GROK_VAD_SILENCE_MS: "50",
    });
    expect(clamped.turnDetection.threshold).toBe(0.9);
    expect(clamped.turnDetection.silenceDurationMs).toBe(100);
  });

  it("treats outbound as unready when Telnyx API key is missing", () => {
    const cfg = loadConfig({
      API_KEY: "k",
      XAI_API_KEY: "x",
      PUBLIC_BASE_URL: "https://example.up.railway.app",
    });
    expect(cfg.ready.telnyx).toBe(false);
    expect(cfg.ready.outbound).toBe(false);
  });

  it("builds webhook and media stream URLs from PUBLIC_BASE_URL", () => {
    const cfg = loadConfig({
      API_KEY: "k",
      TELNYX_API_KEY: "t",
      XAI_API_KEY: "x",
      PUBLIC_BASE_URL: "https://voice.example.com/",
    });
    expect(cfg.webhookUrl).toBe("https://voice.example.com/webhooks/telnyx");
    expect(cfg.mediaStreamUrl("call-1", "tok")).toBe(
      "wss://voice.example.com/media-stream?callId=call-1&token=tok",
    );
  });
});
