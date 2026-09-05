import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  DEFAULT_ELEVENLABS_MODEL,
  DEFAULT_ELEVENLABS_OPTIMIZE_STREAMING_LATENCY,
  DEFAULT_ELEVENLABS_VAD_SILENCE_MS,
  DEFAULT_ELEVENLABS_VOICE_ID,
  elevenLabsAudioPathActive,
  openaiAudioPathActive,
} from "../src/tts.js";

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
    expect(cfg.grokVoiceSpeed).toBe(1.05);
    expect(cfg.telnyxConnectionId).toBe("3041732714274227469");
    expect(cfg.telnyxOutboundVoiceProfileId).toBe("3041732644774610184");
    expect(cfg.publicBaseUrl).toBe("https://example.up.railway.app");
    expect(cfg.turnDetection).toEqual({
      threshold: 0.5,
      silenceDurationMs: 130,
      prefixPaddingMs: 200,
      idleTimeoutMs: 12_000,
    });
    expect(cfg.calleeSpeechGraceMs).toBe(350);
    expect(cfg.calleeMinSpeechMs).toBe(80);
    expect(cfg.hangupPlayoutBufferMs).toBe(1000);
    expect(cfg.elevenlabsVadSilenceMs).toBe(130);
    expect(cfg.elevenlabs).toEqual({
      apiKey: "",
      voiceId: DEFAULT_ELEVENLABS_VOICE_ID,
      model: DEFAULT_ELEVENLABS_MODEL,
      configured: false,
      optimizeStreamingLatency: DEFAULT_ELEVENLABS_OPTIMIZE_STREAMING_LATENCY,
    });
    expect(cfg.ready.elevenlabs).toBe(false);
    expect(elevenLabsAudioPathActive(cfg.elevenlabs)).toBe(false);
    expect(cfg.openai).toEqual({
      apiKey: "",
      baseUrl: "https://api.openai.com",
      model: "gpt-realtime-2.1",
      voice: "coral",
      configured: false,
      prewarmTimeoutMs: 8000,
    });
    expect(cfg.ready.openai).toBe(false);
    expect(openaiAudioPathActive(cfg.openai)).toBe(false);
    expect(DEFAULT_ELEVENLABS_VOICE_ID).toBe("NkpT2jezTenCDRKHkWiX");
    expect(DEFAULT_ELEVENLABS_VOICE_ID).toHaveLength(20);
    expect(DEFAULT_ELEVENLABS_MODEL).toBe("eleven_v3");
    expect(DEFAULT_ELEVENLABS_OPTIMIZE_STREAMING_LATENCY).toBe(3);
    expect(DEFAULT_ELEVENLABS_VAD_SILENCE_MS).toBe(130);
  });

  it("honors GROK_VAD_* env overrides and clamps them", () => {
    const cfg = loadConfig({
      API_KEY: "k",
      TELNYX_API_KEY: "t",
      XAI_API_KEY: "x",
      PUBLIC_BASE_URL: "https://example.up.railway.app",
      GROK_VAD_THRESHOLD: "0.7",
      GROK_VAD_SILENCE_MS: "200",
      GROK_VAD_PREFIX_PADDING_MS: "150",
      GROK_VAD_IDLE_TIMEOUT_MS: "8000",
      GROK_VOICE_SPEED: "1.05",
      GROK_CALLEE_SPEECH_GRACE_MS: "1200",
      GROK_CALLEE_MIN_SPEECH_MS: "300",
      GROK_HANGUP_PLAYOUT_MS: "1500",
    });
    expect(cfg.turnDetection).toEqual({
      threshold: 0.7,
      silenceDurationMs: 200,
      prefixPaddingMs: 150,
      idleTimeoutMs: 8000,
    });
    expect(cfg.grokVoiceSpeed).toBe(1.05);
    expect(cfg.grokVoice).toBe("ara");
    expect(cfg.calleeSpeechGraceMs).toBe(1200);
    expect(cfg.calleeMinSpeechMs).toBe(300);
    expect(cfg.hangupPlayoutBufferMs).toBe(1500);

    const clamped = loadConfig({
      API_KEY: "k",
      TELNYX_API_KEY: "t",
      XAI_API_KEY: "x",
      PUBLIC_BASE_URL: "https://example.up.railway.app",
      GROK_VAD_THRESHOLD: "9",
      GROK_VAD_SILENCE_MS: "50",
      GROK_VOICE_SPEED: "9",
      GROK_CALLEE_SPEECH_GRACE_MS: "99999",
      GROK_CALLEE_MIN_SPEECH_MS: "1",
      GROK_HANGUP_PLAYOUT_MS: "99999",
    });
    expect(clamped.turnDetection.threshold).toBe(0.9);
    expect(clamped.turnDetection.silenceDurationMs).toBe(100);
    expect(clamped.grokVoiceSpeed).toBe(1.5);
    expect(clamped.calleeSpeechGraceMs).toBe(5000);
    expect(clamped.calleeMinSpeechMs).toBe(50);
    expect(clamped.hangupPlayoutBufferMs).toBe(8000);
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

  it("marks ElevenLabs ready when ELEVENLABS_API_KEY is set (voice id defaults to Benedita)", () => {
    const withKey = loadConfig({
      API_KEY: "k",
      TELNYX_API_KEY: "t",
      XAI_API_KEY: "x",
      PUBLIC_BASE_URL: "https://example.up.railway.app",
      ELEVENLABS_API_KEY: "el-key",
    });
    expect(withKey.elevenlabs.configured).toBe(true);
    expect(withKey.ready.elevenlabs).toBe(true);
    expect(elevenLabsAudioPathActive(withKey.elevenlabs)).toBe(true);
    expect(withKey.elevenlabs.voiceId).toBe(DEFAULT_ELEVENLABS_VOICE_ID);
    expect(withKey.elevenlabs.model).toBe(DEFAULT_ELEVENLABS_MODEL);
    expect(withKey.grokVoice).toBe("ara");
    expect(withKey.grokVoiceSpeed).toBe(1.05);

    const overridden = loadConfig({
      API_KEY: "k",
      TELNYX_API_KEY: "t",
      XAI_API_KEY: "x",
      PUBLIC_BASE_URL: "https://example.up.railway.app",
      ELEVENLABS_API_KEY: "el-key",
      ELEVENLABS_VOICE_ID: "el-voice",
      ELEVENLABS_MODEL: "multilingual_v2",
    });
    expect(overridden.elevenlabs).toEqual({
      apiKey: "el-key",
      voiceId: "el-voice",
      model: "multilingual_v2",
      configured: true,
      optimizeStreamingLatency: DEFAULT_ELEVENLABS_OPTIMIZE_STREAMING_LATENCY,
    });
    expect(overridden.ready.elevenlabs).toBe(true);
    expect(overridden.grokVoice).toBe("ara");
    expect(overridden.grokVoiceSpeed).toBe(1.05);

    const elLatency = loadConfig({
      API_KEY: "k",
      TELNYX_API_KEY: "t",
      XAI_API_KEY: "x",
      PUBLIC_BASE_URL: "https://example.up.railway.app",
      ELEVENLABS_API_KEY: "el-key",
      ELEVENLABS_OPTIMIZE_STREAMING_LATENCY: "4",
      ELEVENLABS_VAD_SILENCE_MS: "120",
      ELEVENLABS_MODEL: "eleven_flash_v2_5",
    });
    expect(elLatency.elevenlabs.model).toBe("eleven_flash_v2_5");
    expect(elLatency.elevenlabs.optimizeStreamingLatency).toBe(4);
    expect(elLatency.elevenlabsVadSilenceMs).toBe(120);
    expect(elLatency.turnDetection.silenceDurationMs).toBe(130);
    expect(elLatency.grokVoiceSpeed).toBe(1.05);
  });

  it("marks OpenAI ready when OPENAI_API_KEY is set (voice defaults to coral)", () => {
    const withKey = loadConfig({
      API_KEY: "k",
      TELNYX_API_KEY: "t",
      XAI_API_KEY: "x",
      PUBLIC_BASE_URL: "https://example.up.railway.app",
      OPENAI_API_KEY: "sk-test",
    });
    expect(withKey.openai.configured).toBe(true);
    expect(withKey.ready.openai).toBe(true);
    expect(openaiAudioPathActive(withKey.openai)).toBe(true);
    expect(withKey.openai.voice).toBe("coral");
    expect(withKey.openai.model).toBe("gpt-realtime-2.1");
    expect(withKey.openai.baseUrl).toBe("https://api.openai.com");
    expect(withKey.grokVoice).toBe("ara");

    const overridden = loadConfig({
      API_KEY: "k",
      TELNYX_API_KEY: "t",
      XAI_API_KEY: "x",
      PUBLIC_BASE_URL: "https://example.up.railway.app",
      OPENAI_API_KEY: "sk-test",
      OPENAI_VOICE: "marin",
      OPENAI_REALTIME_MODEL: "gpt-realtime",
      OPENAI_BASE: "https://example.openai.internal/",
    });
    expect(overridden.openai).toEqual({
      apiKey: "sk-test",
      baseUrl: "https://example.openai.internal",
      model: "gpt-realtime",
      voice: "marin",
      configured: true,
      prewarmTimeoutMs: 8000,
    });
    expect(overridden.ready.openai).toBe(true);
    expect(overridden.grokVoice).toBe("ara");
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
