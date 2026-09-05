export const TTS_PROVIDERS = ["grok", "elevenlabs", "openai"] as const;
export type TtsProvider = (typeof TTS_PROVIDERS)[number];

export const DEFAULT_TTS_PROVIDER: TtsProvider = "grok";
export const DEFAULT_ELEVENLABS_MODEL = "eleven_v3";
/** Benedita. 20-char voice id (`Ten`, not `Ln`). Override with ELEVENLABS_VOICE_ID. */
export const DEFAULT_ELEVENLABS_VOICE_ID = "NkpT2jezTenCDRKHkWiX";
/** ElevenLabs stream URL `optimize_streaming_latency` (0–4). 4 is faster/lower quality. */
export const DEFAULT_ELEVENLABS_OPTIMIZE_STREAMING_LATENCY = 3;
/** Shared server_vad end-of-turn silence for every TTS provider (Grok, ElevenLabs, OpenAI). */
export const DEFAULT_ELEVENLABS_VAD_SILENCE_MS = 130;

export const DEFAULT_OPENAI_REALTIME_MODEL = "gpt-realtime-2.1";
/** Feminine expressive Realtime voice suitable for PT. Override with OPENAI_VOICE=marin for OpenAI's quality pick. */
export const DEFAULT_OPENAI_VOICE = "coral";
export const DEFAULT_OPENAI_BASE = "https://api.openai.com";
export const DEFAULT_OPENAI_PREWARM_TIMEOUT_MS = 8000;

export type ElevenLabsConfig = {
  apiKey: string;
  voiceId: string;
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
    default: {
      return { ok: false };
    }
  }
}

export function elevenlabsConfigFromEnv(env: Record<string, string | undefined>): ElevenLabsConfig {
  const apiKey = env.ELEVENLABS_API_KEY?.trim() ?? "";
  const voiceId = env.ELEVENLABS_VOICE_ID?.trim() || DEFAULT_ELEVENLABS_VOICE_ID;
  const model = env.ELEVENLABS_MODEL?.trim() || DEFAULT_ELEVENLABS_MODEL;
  return {
    apiKey,
    voiceId,
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
  return {
    apiKey,
    baseUrl,
    model,
    voice,
    configured: Boolean(apiKey),
    prewarmTimeoutMs: DEFAULT_OPENAI_PREWARM_TIMEOUT_MS,
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
