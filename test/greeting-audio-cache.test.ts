import { describe, expect, it, vi } from "vitest";
import { GreetingAudioCache } from "../src/bridge/greeting-audio-cache.js";
import type { ElevenLabsTts } from "../src/elevenlabs.js";

const FRAME_A = Buffer.alloc(160, 0xaa).toString("base64");
const FRAME_B = Buffer.alloc(160, 0xbb).toString("base64");

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

describe("GreetingAudioCache", () => {
  it("synthesizes PCMU frames without exposing a second HTTP for the same call text", async () => {
    let calls = 0;
    const tts: ElevenLabsTts = {
      async *speakToPcmu(input) {
        calls += 1;
        input.onHttpStart?.();
        input.onFirstByte?.();
        yield FRAME_A;
        yield FRAME_B;
      },
    };
    const cache = new GreetingAudioCache();
    const first = cache.startIfNeeded({
      callId: "call-1",
      text: "Olá, fala a secretária.",
      language: "pt-PT",
      tts,
    });
    cache.startIfNeeded({
      callId: "call-1",
      text: "Olá, fala a secretária.",
      language: "pt-PT",
      tts,
    });
    await flushMicrotasks();
    expect(calls).toBe(1);
    expect(first.frames).toEqual([FRAME_A, FRAME_B]);
    expect(first.done).toBe(true);
    expect(first.failed).toBe(false);
  });

  it("waitForIndex resolves as frames arrive and after completion", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tts: ElevenLabsTts = {
      async *speakToPcmu(input) {
        input.onHttpStart?.();
        input.onFirstByte?.();
        yield FRAME_A;
        await gate;
        yield FRAME_B;
      },
    };
    const cache = new GreetingAudioCache();
    const entry = cache.startIfNeeded({
      callId: "call-1",
      text: "Olá.",
      language: "pt-PT",
      tts,
    });
    await entry.waitForIndex(0);
    expect(entry.frames[0]).toBe(FRAME_A);
    expect(entry.done).toBe(false);
    release();
    await entry.waitForIndex(1);
    expect(entry.frames[1]).toBe(FRAME_B);
    await entry.waitForIndex(2);
    expect(entry.done).toBe(true);
  });

  it("abort stops further frames", async () => {
    let abortSeen = false;
    const tts: ElevenLabsTts = {
      async *speakToPcmu(input) {
        yield FRAME_A;
        await new Promise<void>((_resolve, reject) => {
          if (input.signal.aborted) {
            abortSeen = true;
            const err = new Error("Aborted");
            err.name = "AbortError";
            reject(err);
            return;
          }
          input.signal.addEventListener("abort", () => {
            abortSeen = true;
            const err = new Error("Aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      },
    };
    const cache = new GreetingAudioCache();
    const entry = cache.startIfNeeded({
      callId: "call-1",
      text: "Olá.",
      language: "pt-PT",
      tts,
    });
    await entry.waitForIndex(0);
    cache.abort("call-1");
    await flushMicrotasks();
    expect(abortSeen).toBe(true);
    expect(entry.frames).toEqual([FRAME_A]);
  });

  it("marks the entry failed when TTS throws so unlock can retry", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const tts: ElevenLabsTts = {
      async *speakToPcmu() {
        throw new Error(
          "elevenlabs_tts_failed: HTTP 400 unsupported_model Providing optimize_streaming_latency is not supported with the 'eleven_v3' model.",
        );
      },
    };
    const cache = new GreetingAudioCache();
    const entry = cache.startIfNeeded({
      callId: "call-1",
      text: "Olá.",
      language: "pt-PT",
      tts,
    });
    await entry.waitForIndex(0);
    expect(entry.failed).toBe(true);
    expect(entry.frames).toEqual([]);
    expect(entry.done).toBe(true);
    expect(spy.mock.calls.some((c) => String(c[0]).includes("greeting prefetch failed"))).toBe(true);
    spy.mockRestore();
  });
});
