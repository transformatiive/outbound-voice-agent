export const TTS_PROVIDERS = ["grok", "elevenlabs", "openai", "gpt-live"] as const;
export type TtsProvider = (typeof TTS_PROVIDERS)[number];

export const DEFAULT_TTS_PROVIDER: TtsProvider = "grok";
export const DEFAULT_ELEVENLABS_MODEL = "eleven_v3";
/**
 * Benedita - PT-PT (Alfa teste). 20-char voice id.
 * Letters **Ten** (not `Tn`, not `Ln`). Verified against the ElevenLabs API:
 * `NkpT2jezTenCDRKHkWiX` returns the voice; `NkpT2jezTnCDRKHkWiX` is voice_not_found.
 * Override the active voice with `ELEVENLABS_VOICE_ID`.
 */
export const DEFAULT_ELEVENLABS_VOICE_ID = "NkpT2jezTenCDRKHkWiX";
/**
 * A/B candidate: Joana — Natural and gentle, warm European Portuguese conversational
 * feminine voice (`nJ5NFqyKb8kn9JBPmo6i`). Does not replace Benedita unless
 * `ELEVENLABS_VOICE_ID` is set to this id. `ELEVENLABS_VOICE_ID_ALT` documents it.
 */
export const RECOMMENDED_ELEVENLABS_VOICE_ID_ALT = "nJ5NFqyKb8kn9JBPmo6i";
export const RECOMMENDED_ELEVENLABS_VOICE_ALT_NAME = "Joana";
/** ElevenLabs stream URL `optimize_streaming_latency` (0–4). Used only on models that accept it. */
export const DEFAULT_ELEVENLABS_OPTIMIZE_STREAMING_LATENCY = 3;
/** Shared server_vad end-of-turn silence for every TTS provider (Grok, ElevenLabs, OpenAI). */
export const DEFAULT_ELEVENLABS_VAD_SILENCE_MS = 130;

export const DEFAULT_OPENAI_REALTIME_MODEL = "gpt-realtime-2.1";
/** Feminine expressive Realtime voice suitable for PT. Override with OPENAI_VOICE=marin for OpenAI's quality pick. */
export const DEFAULT_OPENAI_VOICE = "coral";
export const DEFAULT_OPENAI_BASE = "https://api.openai.com";
export const DEFAULT_OPENAI_PREWARM_TIMEOUT_MS = 8000;
/** ChatGPT Voice speech-to-speech model (`tts_provider=gpt-live` / aliases chatgpt-live-1). */
export const DEFAULT_GPT_LIVE_MODEL = "gpt-live-1";
/**
 * GPT-Live quality default. Multilingual — pt-PT is locked in instructions.
 * Do **not** default to `bossa` / `tempo` (Brazilian Portuguese voices).
 */
export const DEFAULT_GPT_LIVE_VOICE = "marin";
/** Responses-delegation reasoning model for GPT-Live tools (`end_call`, `send_dtmf`). */
export const DEFAULT_GPT_LIVE_DELEGATE_MODEL = "gpt-5.6-terra";
export const GPT_LIVE_USER_AGENT = "alfaseguros/outbound-voice-agent Node";

export type ElevenLabsConfig = {
  apiKey: string;
  voiceId: string;
  /** Documented A/B candidate (Joana). Not the live voice unless copied into voiceId. */
  voiceIdAlt?: string;
  model: string;
  configured: boolean;
  optimizeStreamingLatency?: number;
};

export type OpenAIConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  voice: string;
  configured: boolean;
  prewarmTimeoutMs: number;
  /** `gpt-live-1` (ChatGPT Voice). */
  liveModel: string;
  /** Default GPT-Live voice (`marin`). Not `bossa`/`tempo` (Brazilian). */
  liveVoice: string;
  /** Responses backend for GPT-Live tool calls. */
  delegateModel: string;
};

export function parseTtsProvider(value: unknown): { ok: true; value: TtsProvider } | { ok: false } {
  if (value === undefined || value === null || value === "") {
    return { ok: true, value: DEFAULT_TTS_PROVIDER };
  }
  if (typeof value !== "string") return { ok: false };
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "grok":
      return { ok: true, value: "grok" };
    case "elevenlabs":
      return { ok: true, value: "elevenlabs" };
    case "openai":
      return { ok: true, value: "openai" };
    case "gpt-live":
    case "gpt-live-1":
    case "chatgpt-live":
    case "chatgpt-live-1":
      return { ok: true, value: "gpt-live" };
    default: {
      return { ok: false };
    }
  }
}

/** Prewarmed OpenAI WebSocket owns Telnyx speech-to-speech (Realtime or GPT-Live). */
export function ttsProviderUsesOpenAISession(provider: TtsProvider): boolean {
  switch (provider) {
    case "openai":
    case "gpt-live":
      return true;
    case "grok":
    case "elevenlabs":
      return false;
    default: {
      const _never: never = provider;
      throw new Error(`unsupported tts provider: ${_never}`);
    }
  }
}

/** Public `grokVoice` echo — Grok still speaks or still does STT. */
export function ttsProviderUsesGrokVoice(provider: TtsProvider): boolean {
  switch (provider) {
    case "grok":
    case "elevenlabs":
      return true;
    case "openai":
    case "gpt-live":
      return false;
    default: {
      const _never: never = provider;
      throw new Error(`unsupported tts provider: ${_never}`);
    }
  }
}

/**
 * `optimize_streaming_latency` is accepted on flash / turbo / multilingual_v2.
 * `eleven_v3` and `eleven_v3_conversational` reject it with HTTP 400
 * `unsupported_model`, which emptied the greeting cache and muted unlock.
 */
export function elevenLabsModelSupportsOptimizeStreamingLatency(model: string): boolean {
  const m = model.trim().toLowerCase();
  if (!m) return false;
  if (elevenLabsModelIsV3(m)) return false;
  if (m.includes("flash") || m.includes("turbo")) return true;
  if (m.includes("multilingual_v2")) return true;
  return false;
}

/** `eleven_v3` and any `eleven_v3_*` (including `eleven_v3_conversational`). */
export function elevenLabsModelIsV3(model: string): boolean {
  const m = model.trim().toLowerCase();
  return m === "eleven_v3" || m.startsWith("eleven_v3_");
}

/** Audio tags are v3-only; flash/turbo would speak `[warmly]` as words. */
export function elevenLabsModelSupportsAudioTags(model: string): boolean {
  return elevenLabsModelIsV3(model);
}

export function elevenlabsConfigFromEnv(env: Record<string, string | undefined>): ElevenLabsConfig {
  const apiKey = env.ELEVENLABS_API_KEY?.trim() ?? "";
  const voiceId = env.ELEVENLABS_VOICE_ID?.trim() || DEFAULT_ELEVENLABS_VOICE_ID;
  const voiceIdAlt = env.ELEVENLABS_VOICE_ID_ALT?.trim() || RECOMMENDED_ELEVENLABS_VOICE_ID_ALT;
  const model = env.ELEVENLABS_MODEL?.trim() || DEFAULT_ELEVENLABS_MODEL;
  return {
    apiKey,
    voiceId,
    voiceIdAlt,
    model,
    configured: Boolean(apiKey),
    optimizeStreamingLatency: clampEnvInt(
      env.ELEVENLABS_OPTIMIZE_STREAMING_LATENCY,
      DEFAULT_ELEVENLABS_OPTIMIZE_STREAMING_LATENCY,
      0,
      4,
    ),
  };
}

/** True when the HTTP TTS → Telnyx PCMU pipeline can run (API key present). */
export function elevenLabsAudioPathActive(config: ElevenLabsConfig): boolean {
  return config.configured;
}

export function openaiConfigFromEnv(env: Record<string, string | undefined>): OpenAIConfig {
  const apiKey = env.OPENAI_API_KEY?.trim() ?? "";
  const baseUrl = (env.OPENAI_BASE?.trim() || DEFAULT_OPENAI_BASE).replace(/\/+$/, "");
  const model = env.OPENAI_REALTIME_MODEL?.trim() || DEFAULT_OPENAI_REALTIME_MODEL;
  const voice = env.OPENAI_VOICE?.trim().toLowerCase() || DEFAULT_OPENAI_VOICE;
  const liveModel = env.OPENAI_LIVE_MODEL?.trim() || DEFAULT_GPT_LIVE_MODEL;
  const liveVoice = env.OPENAI_LIVE_VOICE?.trim().toLowerCase() || DEFAULT_GPT_LIVE_VOICE;
  const delegateModel = env.OPENAI_LIVE_DELEGATE_MODEL?.trim() || DEFAULT_GPT_LIVE_DELEGATE_MODEL;
  return {
    apiKey,
    baseUrl,
    model,
    voice,
    configured: Boolean(apiKey),
    prewarmTimeoutMs: DEFAULT_OPENAI_PREWARM_TIMEOUT_MS,
    liveModel,
    liveVoice,
    delegateModel,
  };
}

/** True when OpenAI Realtime can own the PSTN speech-to-speech leg (API key present). */
export function openaiAudioPathActive(config: OpenAIConfig): boolean {
  return config.configured;
}

function clampEnvInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}
