import type { Language } from "./prompt.js";
import type { ElevenLabsConfig } from "./tts.js";

export const ELEVENLABS_API_BASE = "https://api.elevenlabs.io";
export const ELEVENLABS_PCMU_FRAME_BYTES = 160;

export const ELEVENLABS_OUTPUT_FORMATS = ["ulaw_8000", "pcm_8000", "pcm_16000"] as const;
export type ElevenLabsOutputFormat = (typeof ELEVENLABS_OUTPUT_FORMATS)[number];

export type ElevenLabsSpeakInput = {
  text: string;
  language: Language;
  signal: AbortSignal;
};

export type ElevenLabsTts = {
  speakToPcmu: (input: ElevenLabsSpeakInput) => AsyncIterable<string>;
};

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

export function elevenLabsLanguageCode(language: Language): string {
  switch (language) {
    case "pt-PT":
      return "pt";
    case "en-GB":
    case "en-US":
      return "en";
    default: {
      const _never: never = language;
      throw new Error(`unsupported language: ${_never}`);
    }
  }
}

/** ITU-T G.711 μ-law from a 16-bit linear PCM sample. */
export function linearToMulaw(sample: number): number {
  let sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > MULAW_CLIP) sample = MULAW_CLIP;
  sample += MULAW_BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; exponent > 0 && (sample & expMask) === 0; exponent--, expMask >>= 1) {
    /* find MSB */
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

export function consumeSourceToPcmu(
  format: ElevenLabsOutputFormat,
  input: Buffer,
): { pcmu: Buffer; leftover: Buffer } {
  switch (format) {
    case "ulaw_8000":
      return { pcmu: Buffer.from(input), leftover: Buffer.alloc(0) };
    case "pcm_8000": {
      const even = input.length - (input.length % 2);
      const leftover = even < input.length ? Buffer.from(input.subarray(even)) : Buffer.alloc(0);
      const pcmu = Buffer.alloc(even / 2);
      for (let i = 0; i < pcmu.length; i++) {
        pcmu[i] = linearToMulaw(input.readInt16LE(i * 2));
      }
      return { pcmu, leftover };
    }
    case "pcm_16000": {
      const used = input.length - (input.length % 4);
      const leftover = used < input.length ? Buffer.from(input.subarray(used)) : Buffer.alloc(0);
      const pcmu = Buffer.alloc(used / 4);
      for (let i = 0; i < pcmu.length; i++) {
        const a = input.readInt16LE(i * 4);
        const b = input.readInt16LE(i * 4 + 2);
        pcmu[i] = linearToMulaw((a + b) >> 1);
      }
      return { pcmu, leftover };
    }
    default: {
      const _never: never = format;
      throw new Error(`unsupported elevenlabs format: ${_never}`);
    }
  }
}

export class PcmuStreamEncoder {
  private sourceRest: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private pcmuRest: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  constructor(private readonly sourceFormat: ElevenLabsOutputFormat) {}

  push(chunk: Uint8Array): string[] {
    const combined = Buffer.concat([this.sourceRest, Buffer.from(chunk)]);
    const { pcmu, leftover } = consumeSourceToPcmu(this.sourceFormat, combined);
    this.sourceRest = leftover;
    const pending = Buffer.concat([this.pcmuRest, pcmu]);
    const frames: string[] = [];
    let offset = 0;
    while (offset + ELEVENLABS_PCMU_FRAME_BYTES <= pending.length) {
      frames.push(pending.subarray(offset, offset + ELEVENLABS_PCMU_FRAME_BYTES).toString("base64"));
      offset += ELEVENLABS_PCMU_FRAME_BYTES;
    }
    this.pcmuRest = offset < pending.length ? Buffer.from(pending.subarray(offset)) : Buffer.alloc(0);
    return frames;
  }

  flush(): string[] {
    if (this.sourceRest.length > 0) {
      const { pcmu } = consumeSourceToPcmu(this.sourceFormat, this.sourceRest);
      this.sourceRest = Buffer.alloc(0);
      this.pcmuRest = Buffer.concat([this.pcmuRest, pcmu]);
    }
    if (this.pcmuRest.length === 0) return [];
    const tail = this.pcmuRest.toString("base64");
    this.pcmuRest = Buffer.alloc(0);
    return [tail];
  }
}

export function createElevenLabsTts(
  config: ElevenLabsConfig,
  fetchImpl: typeof fetch = fetch,
): ElevenLabsTts {
  return {
    speakToPcmu: (input) => streamElevenLabsPcmu({ config, fetchImpl, ...input }),
  };
}

export async function* streamElevenLabsPcmu(opts: {
  config: ElevenLabsConfig;
  text: string;
  language: Language;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}): AsyncGenerator<string, void, unknown> {
  const text = opts.text.trim();
  if (!text) return;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const { response, format } = await requestElevenLabsAudio({
    config: opts.config,
    text,
    language: opts.language,
    signal: opts.signal,
    fetchImpl,
  });
  const encoder = new PcmuStreamEncoder(format);
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    for (const frame of encoder.push(bytes)) yield frame;
    for (const frame of encoder.flush()) yield frame;
    return;
  }
  const reader = response.body.getReader();
  try {
    while (true) {
      if (opts.signal.aborted) {
        await reader.cancel().catch(() => undefined);
        return;
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      for (const frame of encoder.push(value)) yield frame;
    }
    for (const frame of encoder.flush()) yield frame;
  } finally {
    reader.releaseLock();
  }
}

async function requestElevenLabsAudio(opts: {
  config: ElevenLabsConfig;
  text: string;
  language: Language;
  signal: AbortSignal;
  fetchImpl: typeof fetch;
}): Promise<{ response: Response; format: ElevenLabsOutputFormat }> {
  let lastStatus = 0;
  let lastBody = "";
  for (const format of ELEVENLABS_OUTPUT_FORMATS) {
    if (opts.signal.aborted) {
      throw abortError();
    }
    const url =
      `${ELEVENLABS_API_BASE}/v1/text-to-speech/${encodeURIComponent(opts.config.voiceId)}/stream` +
      `?output_format=${format}`;
    const response = await opts.fetchImpl(url, {
      method: "POST",
      headers: {
        "xi-api-key": opts.config.apiKey,
        "Content-Type": "application/json",
        Accept: "application/octet-stream",
      },
      body: JSON.stringify({
        text: opts.text,
        model_id: opts.config.model,
        language_code: elevenLabsLanguageCode(opts.language),
      }),
      signal: opts.signal,
    });
    if (response.ok) return { response, format };
    lastStatus = response.status;
    lastBody = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      break;
    }
    if (response.status !== 400 && response.status !== 415 && response.status !== 422) {
      break;
    }
  }
  throw new Error(`elevenlabs_tts_failed: HTTP ${lastStatus} ${lastBody.slice(0, 200)}`);
}

function abortError(): Error {
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}
