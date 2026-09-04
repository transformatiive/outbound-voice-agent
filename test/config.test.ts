import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("config", () => {
  it("defaults caller ID, Grok voice ara, and Live 2 model", () => {
    const cfg = loadConfig({
      API_KEY: "k",
      TELNYX_API_KEY: "t",
      TELNYX_CONNECTION_ID: "3041732714274227469",
      XAI_API_KEY: "x",
      PUBLIC_BASE_URL: "https://example.up.railway.app",
    });
    expect(cfg.fromNumber).toBe("+351210210260");
    expect(cfg.grokVoice).toBe("ara");
    expect(cfg.grokModel).toBe("grok-voice-think-fast-2.0");
    expect(cfg.telnyxConnectionId).toBe("3041732714274227469");
    expect(cfg.publicBaseUrl).toBe("https://example.up.railway.app");
  });

  it("treats outbound as unready when Telnyx connection id is missing", () => {
    const cfg = loadConfig({
      API_KEY: "k",
      TELNYX_API_KEY: "t",
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
      TELNYX_CONNECTION_ID: "3041732714274227469",
      XAI_API_KEY: "x",
      PUBLIC_BASE_URL: "https://voice.example.com/",
    });
    expect(cfg.webhookUrl).toBe("https://voice.example.com/webhooks/telnyx");
    expect(cfg.mediaStreamUrl("call-1", "tok")).toBe(
      "wss://voice.example.com/media-stream?callId=call-1&token=tok",
    );
  });
});
