import { describe, expect, it, vi } from "vitest";
import {
  ELEVENLABS_API_BASE,
  PcmuStreamEncoder,
  consumeSourceToPcmu,
  createElevenLabsTts,
  elevenLabsLanguageCode,
  linearToMulaw,
  streamElevenLabsPcmu,
} from "../src/elevenlabs.js";
import { DEFAULT_ELEVENLABS_MODEL, DEFAULT_ELEVENLABS_VOICE_ID } from "../src/tts.js";

function pcm16(samples: number[]): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => buf.writeInt16LE(s, i * 2));
  return buf;
}

describe("ElevenLabs PCMU conversion", () => {
  it("encodes silence as μ-law 0xff", () => {
    expect(linearToMulaw(0)).toBe(0xff);
  });

  it("maps pcm_8000 16-bit frames to one μ-law byte per sample", () => {
    const { pcmu, leftover } = consumeSourceToPcmu("pcm_8000", pcm16([0, 0]));
    expect(leftover.length).toBe(0);
    expect([...pcmu]).toEqual([0xff, 0xff]);
  });

  it("downsamples pcm_16000 pairs then μ-law encodes", () => {
    const { pcmu, leftover } = consumeSourceToPcmu("pcm_16000", pcm16([0, 0, 0, 0]));
    expect(leftover.length).toBe(0);
    expect([...pcmu]).toEqual([0xff, 0xff]);
  });

  it("passes ulaw_8000 through unchanged", () => {
    const raw = Buffer.from([0x7f, 0x80, 0xff]);
    const { pcmu, leftover } = consumeSourceToPcmu("ulaw_8000", raw);
    expect(leftover.length).toBe(0);
    expect(pcmu.equals(raw)).toBe(true);
  });

  it("chunks streaming ulaw into 20ms Telnyx frames", () => {
    const encoder = new PcmuStreamEncoder("ulaw_8000");
    const first = encoder.push(Buffer.alloc(160, 0xaa));
    expect(first).toEqual([Buffer.alloc(160, 0xaa).toString("base64")]);
    expect(encoder.push(Buffer.alloc(80, 0xbb))).toEqual([]);
    const flushed = encoder.flush();
    expect(flushed).toEqual([Buffer.alloc(80, 0xbb).toString("base64")]);
  });
});

describe("ElevenLabs HTTP TTS", () => {
  it("maps language to ISO 639-1", () => {
    expect(elevenLabsLanguageCode("pt-PT")).toBe("pt");
    expect(elevenLabsLanguageCode("en-GB")).toBe("en");
    expect(elevenLabsLanguageCode("en-US")).toBe("en");
  });

  it("streams ulaw_8000 from the HTTP stream endpoint as base64 PCMU", async () => {
    const payload = Buffer.alloc(160, 0x7f);
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe(
        `${ELEVENLABS_API_BASE}/v1/text-to-speech/${DEFAULT_ELEVENLABS_VOICE_ID}/stream?output_format=ulaw_8000&optimize_streaming_latency=3`,
      );
      expect((init?.headers as Record<string, string>)["xi-api-key"]).toBe("el-key");
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({
        text: "Olá, boa tarde.",
        model_id: DEFAULT_ELEVENLABS_MODEL,
        language_code: "pt",
      });
      return new Response(payload, { status: 200 });
    });
    const frames: string[] = [];
    for await (const frame of streamElevenLabsPcmu({
      config: {
        apiKey: "el-key",
        voiceId: DEFAULT_ELEVENLABS_VOICE_ID,
        model: DEFAULT_ELEVENLABS_MODEL,
        configured: true,
      },
      text: "Olá, boa tarde.",
      language: "pt-PT",
      signal: new AbortController().signal,
      fetchImpl,
    })) {
      frames.push(frame);
    }
    expect(frames).toEqual([payload.toString("base64")]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("falls back to pcm_16000 and resamples when ulaw_8000 is rejected", async () => {
    const pcm = pcm16(Array.from({ length: 320 }, () => 0));
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      const u = String(url);
      if (u.includes("ulaw_8000") || u.includes("pcm_8000")) {
        return new Response("unsupported format", { status: 400 });
      }
      expect(u).toContain("output_format=pcm_16000");
      return new Response(pcm, { status: 200 });
    });
    const frames: string[] = [];
    for await (const frame of streamElevenLabsPcmu({
      config: {
        apiKey: "el-key",
        voiceId: DEFAULT_ELEVENLABS_VOICE_ID,
        model: "eleven_v3",
        configured: true,
      },
      text: "Hello.",
      language: "en-GB",
      signal: new AbortController().signal,
      fetchImpl,
    })) {
      frames.push(frame);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(Buffer.from(frames.join(""), "base64").length).toBe(160);
  });

  it("emits a Telnyx frame as soon as the first ulaw bytes arrive", () => {
    const encoder = new PcmuStreamEncoder("ulaw_8000");
    const first = encoder.push(Buffer.alloc(40, 0xaa));
    expect(first).toEqual([Buffer.alloc(40, 0xaa).toString("base64")]);
    expect(encoder.push(Buffer.alloc(80, 0xbb))).toEqual([]);
    const next = encoder.push(Buffer.alloc(80, 0xcc));
    expect(next).toEqual([Buffer.concat([Buffer.alloc(80, 0xbb), Buffer.alloc(80, 0xcc)]).toString("base64")]);
  });

  it("notifies onHttpStart then onFirstByte as soon as the HTTP body has audio", async () => {
    const stages: string[] = [];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from(Buffer.alloc(40, 0x7f)));
        controller.close();
      },
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(stream, { status: 200 }));
    const frames: string[] = [];
    for await (const frame of streamElevenLabsPcmu({
      config: {
        apiKey: "el-key",
        voiceId: DEFAULT_ELEVENLABS_VOICE_ID,
        model: DEFAULT_ELEVENLABS_MODEL,
        configured: true,
      },
      text: "Olá.",
      language: "pt-PT",
      signal: new AbortController().signal,
      fetchImpl,
      onHttpStart: () => stages.push("http"),
      onFirstByte: () => stages.push("byte"),
    })) {
      frames.push(frame);
    }
    expect(stages).toEqual(["http", "byte"]);
    expect(frames.length).toBeGreaterThan(0);
  });

  it("caches the first successful output format for later utterances", async () => {
    const pcm = pcm16(Array.from({ length: 160 }, () => 0));
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      const u = String(url);
      if (u.includes("ulaw_8000")) return new Response("unsupported format", { status: 400 });
      if (u.includes("pcm_8000")) return new Response(pcm, { status: 200 });
      return new Response("unsupported format", { status: 400 });
    });
    const tts = createElevenLabsTts(
      {
        apiKey: "el-key",
        voiceId: DEFAULT_ELEVENLABS_VOICE_ID,
        model: DEFAULT_ELEVENLABS_MODEL,
        configured: true,
      },
      fetchImpl,
    );
    async function speakOnce(): Promise<void> {
      for await (const _frame of tts.speakToPcmu({
        text: "Olá.",
        language: "pt-PT",
        signal: new AbortController().signal,
      })) {
        /* drain */
      }
    }
    await speakOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("output_format=ulaw_8000");
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain("output_format=pcm_8000");
    fetchImpl.mockClear();
    await speakOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("output_format=pcm_8000");
    expect(String(fetchImpl.mock.calls[0]?.[0])).not.toContain("ulaw_8000");
  });

  it("createElevenLabsTts speaks via speakToPcmu", async () => {
    const payload = Buffer.from([0xff, 0xfe]);
    const tts = createElevenLabsTts(
      {
        apiKey: "el-key",
        voiceId: "voice",
        model: "eleven_v3",
        configured: true,
      },
      async () => new Response(payload, { status: 200 }),
    );
    const frames: string[] = [];
    for await (const frame of tts.speakToPcmu({
      text: "Ok.",
      language: "pt-PT",
      signal: new AbortController().signal,
    })) {
      frames.push(frame);
    }
    expect(frames).toEqual([payload.toString("base64")]);
  });
});
