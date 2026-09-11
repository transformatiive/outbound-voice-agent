import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { CallRuntime } from "../src/bridge/call-runtime.js";
import { GreetingAudioCache } from "../src/bridge/greeting-audio-cache.js";
import { DEFAULT_TURN_DETECTION } from "../src/grok/session.js";
import type { AppConfig } from "../src/config.js";
import type { CallRecord } from "../src/calls/types.js";

const config: AppConfig = {
  port: 0,
  apiKey: "test-api-key",
  telnyxApiKey: "telnyx-key",
  telnyxConnectionId: "3041732714274227469",
  telnyxOutboundVoiceProfileId: "3041732644774610184",
  telnyxApiBase: "https://api.telnyx.com",
  telnyxPublicKey: undefined,
  fromNumber: "+351210210260",
  xaiApiKey: "xai-key",
  xaiBaseUrl: "https://api.x.ai",
  grokVoice: "ara",
  grokModel: "grok-voice-think-fast-2.0",
  grokVoiceSpeed: 1.05,
  elevenlabs: { apiKey: "", voiceId: "", model: "eleven_v3", configured: false },
  openai: {
    apiKey: "",
    baseUrl: "https://api.openai.com",
    model: "gpt-realtime-2.1",
    voice: "coral",
    configured: false,
    prewarmTimeoutMs: 2000,
    liveModel: "gpt-live-1",
    liveVoice: "marin",
    delegateModel: "gpt-5.6-terra",
  },
  turnDetection: DEFAULT_TURN_DETECTION,
  calleeSpeechGraceMs: 350,
  calleeMinSpeechMs: 80,
  hangupPlayoutBufferMs: 1000,
  elevenlabsVadSilenceMs: 130,
  publicBaseUrl: "https://example.up.railway.app",
  resultWebhook: undefined,
  maxCallSeconds: 600,
  webhookUrl: "https://example.up.railway.app/webhooks/telnyx",
  mediaStreamUrl: (callId, token) =>
    `wss://example.up.railway.app/media-stream?callId=${callId}&token=${token}`,
  ready: { api: true, telnyx: true, xai: true, outbound: true, elevenlabs: false, openai: false },
};

function sampleCall(): CallRecord {
  return {
    id: "call-rex",
    status: "dialing",
    to: "+351912345678",
    from: "+351210210260",
    language: "pt-PT",
    greeting: "Boa tarde, sou o secretário.",
    objective: "Navegar o IVR.",
    voice: "rex",
    model: "grok-voice-think-fast-2.0",
    ttsProvider: "grok",
    streamToken: "tok",
    telnyx: { callControlId: "v2:control-id" },
    transcript: [],
    createdAt: new Date().toISOString(),
  };
}

describe("CallRuntime Grok voice", () => {
  it("sends session.update with call.voice rex, not env GROK_VOICE ara", () => {
    const sent: Array<{ type?: string; session?: { voice?: string } }> = [];
    const grokWs = new EventEmitter();
    Object.assign(grokWs, {
      readyState: WebSocket.OPEN,
      send(data: string) {
        sent.push(JSON.parse(data) as { type?: string; session?: { voice?: string } });
      },
      close() {
        /* noop */
      },
      terminate() {
        /* noop */
      },
    });
    const runtime = new CallRuntime({
      call: sampleCall(),
      config,
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
      connectGrok: () => grokWs as unknown as WebSocket,
      onEnded: () => undefined,
      greetingAudioCache: new GreetingAudioCache(),
    });
    grokWs.emit("open");
    const update = sent.find((e) => e.type === "session.update");
    expect(update?.session?.voice).toBe("rex");
    runtime.close();
  });
});
