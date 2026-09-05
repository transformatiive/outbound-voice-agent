import {
  DEFAULT_OUTPUT_SPEED,
  DEFAULT_TURN_DETECTION,
  type TurnDetectionSettings,
} from "./grok/session.js";
import {
  DEFAULT_CALLEE_MIN_SPEECH_MS,
  DEFAULT_CALLEE_SPEECH_GRACE_MS,
} from "./bridge/callee-speech.js";
import { elevenlabsConfigFromEnv, DEFAULT_ELEVENLABS_VAD_SILENCE_MS, type ElevenLabsConfig } from "./tts.js";

export type ReadyFlags = {
  api: boolean;
  telnyx: boolean;
  xai: boolean;
  outbound: boolean;
  elevenlabs: boolean;
};

export type AppConfig = {
  port: number;
  apiKey: string;
  telnyxApiKey: string;
  telnyxConnectionId: string;
  telnyxOutboundVoiceProfileId: string;
  telnyxApiBase: string;
  telnyxPublicKey: string | undefined;
  fromNumber: string;
  xaiApiKey: string;
  xaiBaseUrl: string;
  grokVoice: string;
  grokModel: string;
  grokVoiceSpeed: number;
  elevenlabs: ElevenLabsConfig;
  turnDetection: TurnDetectionSettings;
  calleeSpeechGraceMs: number;
  calleeMinSpeechMs: number;
  hangupPlayoutBufferMs: number;
  elevenlabsVadSilenceMs: number;
  publicBaseUrl: string;
  resultWebhook: string | undefined;
  maxCallSeconds: number;
  webhookUrl: string;
  mediaStreamUrl: (callId: string, token: string) => string;
  ready: ReadyFlags;
};

type Env = Record<string, string | undefined>;

function envNumber(env: Env, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function toWssOrigin(httpsOrigin: string): string {
  const trimmed = trimSlash(httpsOrigin);
  if (trimmed.startsWith("wss://") || trimmed.startsWith("ws://")) return trimmed;
  if (trimmed.startsWith("https://")) return `wss://${trimmed.slice("https://".length)}`;
  if (trimmed.startsWith("http://")) return `ws://${trimmed.slice("http://".length)}`;
  return `wss://${trimmed}`;
}

export function loadConfig(env: Env = process.env): AppConfig {
  const apiKey = env.API_KEY?.trim() ?? "";
  const telnyxApiKey = env.TELNYX_API_KEY?.trim() ?? "";
  const telnyxConnectionId = env.TELNYX_CONNECTION_ID?.trim() || "3041732714274227469";
  const telnyxOutboundVoiceProfileId =
    env.TELNYX_OUTBOUND_VOICE_PROFILE_ID?.trim() || "3041732644774610184";
  const xaiApiKey = env.XAI_API_KEY?.trim() ?? "";
  const publicBaseUrl = trimSlash(env.PUBLIC_BASE_URL?.trim() ?? "");
  const fromNumber = env.FROM_NUMBER?.trim() || "+351210210260";
  const grokVoice = env.GROK_VOICE?.trim() || "ara";
  const grokModel = env.GROK_MODEL?.trim() || "grok-voice-think-fast-2.0";
  const grokVoiceSpeed =
    Math.round(envNumber(env, "GROK_VOICE_SPEED", DEFAULT_OUTPUT_SPEED, 0.7, 1.5) * 100) / 100;
  const turnDetection: TurnDetectionSettings = {
    threshold: envNumber(env, "GROK_VAD_THRESHOLD", DEFAULT_TURN_DETECTION.threshold, 0.1, 0.9),
    silenceDurationMs: Math.round(
      envNumber(env, "GROK_VAD_SILENCE_MS", DEFAULT_TURN_DETECTION.silenceDurationMs, 100, 2000),
    ),
    prefixPaddingMs: Math.round(
      envNumber(
        env,
        "GROK_VAD_PREFIX_PADDING_MS",
        DEFAULT_TURN_DETECTION.prefixPaddingMs,
        0,
        1000,
      ),
    ),
    idleTimeoutMs: Math.round(
      envNumber(
        env,
        "GROK_VAD_IDLE_TIMEOUT_MS",
        DEFAULT_TURN_DETECTION.idleTimeoutMs,
        1000,
        60_000,
      ),
    ),
  };
  const calleeSpeechGraceMs = Math.round(
    envNumber(env, "GROK_CALLEE_SPEECH_GRACE_MS", DEFAULT_CALLEE_SPEECH_GRACE_MS, 0, 5000),
  );
  const calleeMinSpeechMs = Math.round(
    envNumber(env, "GROK_CALLEE_MIN_SPEECH_MS", DEFAULT_CALLEE_MIN_SPEECH_MS, 50, 2000),
  );
  const hangupPlayoutBufferMs = Math.round(
    envNumber(env, "GROK_HANGUP_PLAYOUT_MS", 1000, 0, 8000),
  );
  const elevenlabsVadSilenceMs = Math.round(
    envNumber(env, "ELEVENLABS_VAD_SILENCE_MS", DEFAULT_ELEVENLABS_VAD_SILENCE_MS, 100, 2000),
  );
  const elevenlabs = elevenlabsConfigFromEnv(env);
  const resultWebhook = env.RESULT_WEBHOOK?.trim() || undefined;
  const telnyxPublicKey = env.TELNYX_PUBLIC_KEY?.trim() || undefined;
  const xaiBaseUrl = trimSlash(env.XAI_BASE_URL?.trim() || "https://api.x.ai");
  const telnyxApiBase = trimSlash(env.TELNYX_API_BASE?.trim() || "https://api.telnyx.com");
  const port = Number(env.PORT) || 3000;
  const maxCallSeconds = Number(env.MAX_CALL_SECONDS) || 600;

  const ready: ReadyFlags = {
    api: Boolean(apiKey),
    telnyx: Boolean(telnyxApiKey && telnyxConnectionId),
    xai: Boolean(xaiApiKey),
    outbound: false,
    elevenlabs: elevenlabs.configured,
  };
  ready.outbound = ready.api && ready.telnyx && ready.xai && Boolean(publicBaseUrl);

  const httpsOrigin = publicBaseUrl || "http://localhost";
  const wssOrigin = toWssOrigin(httpsOrigin);

  return {
    port,
    apiKey,
    telnyxApiKey,
    telnyxConnectionId,
    telnyxOutboundVoiceProfileId,
    telnyxApiBase,
    telnyxPublicKey,
    fromNumber,
    xaiApiKey,
    xaiBaseUrl,
    grokVoice,
    grokModel,
    grokVoiceSpeed,
    elevenlabs,
    turnDetection,
    calleeSpeechGraceMs,
    calleeMinSpeechMs,
    hangupPlayoutBufferMs,
    elevenlabsVadSilenceMs,
    publicBaseUrl,
    resultWebhook,
    maxCallSeconds,
    webhookUrl: publicBaseUrl ? `${trimSlash(publicBaseUrl)}/webhooks/telnyx` : "",
    mediaStreamUrl: (callId, token) =>
      `${wssOrigin}/media-stream?callId=${encodeURIComponent(callId)}&token=${encodeURIComponent(token)}`,
    ready,
  };
}
