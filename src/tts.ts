export const TTS_PROVIDERS = ["grok", "elevenlabs"] as const;
export type TtsProvider = (typeof TTS_PROVIDERS)[number];

export const DEFAULT_TTS_PROVIDER: TtsProvider = "grok";
export const DEFAULT_ELEVENLABS_MODEL = "eleven_v3";
/** Benedita. Not a secret — override with ELEVENLABS_VOICE_ID. */
export const DEFAULT_ELEVENLABS_VOICE_ID = "NkpT2jezLnCDRKHkWiX";

export type ElevenLabsConfig = {
  apiKey: string;
  voiceId: string;
  model: string;
  configured: boolean;
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
  };
}

/** True when the HTTP TTS → Telnyx PCMU pipeline can run (API key present). */
export function elevenLabsAudioPathActive(config: ElevenLabsConfig): boolean {
  return config.configured;
}
