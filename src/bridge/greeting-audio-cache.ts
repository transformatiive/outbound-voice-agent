import type { Language } from "../prompt.js";
import type { ElevenLabsTts } from "../elevenlabs.js";

export class PcmuFrameBuffer {
  readonly frames: string[] = [];
  done = false;
  failed = false;
  httpStartAtMs: number | undefined;
  firstByteAtMs: number | undefined;
  readonly abort = new AbortController();
  private readonly waiters: Array<() => void> = [];

  waitForIndex(index: number): Promise<void> {
    return new Promise((resolve) => {
      const check = (): void => {
        if (this.done || this.failed || this.frames.length > index) {
          resolve();
          return;
        }
        this.waiters.push(check);
      };
      check();
    });
  }

  push(frame: string): void {
    if (frame.length === 0) return;
    this.frames.push(frame);
    this.notify();
  }

  finish(failed = false): void {
    if (this.done) return;
    this.failed = failed;
    this.done = true;
    this.notify();
  }

  private notify(): void {
    const pending = this.waiters.splice(0);
    for (const waiter of pending) waiter();
  }
}

export async function fillPcmuFrameBuffer(
  buffer: PcmuFrameBuffer,
  opts: {
    tts: ElevenLabsTts;
    text: string;
    language: Language;
    callId?: string;
    onHttpStart?: () => void;
    onFirstByte?: () => void;
  },
): Promise<void> {
  try {
    for await (const chunk of opts.tts.speakToPcmu({
      text: opts.text,
      language: opts.language,
      signal: buffer.abort.signal,
      ...(opts.onHttpStart ? { onHttpStart: opts.onHttpStart } : {}),
      ...(opts.onFirstByte ? { onFirstByte: opts.onFirstByte } : {}),
    })) {
      if (buffer.abort.signal.aborted) {
        buffer.finish(false);
        return;
      }
      buffer.push(chunk);
    }
    buffer.finish(false);
  } catch (err) {
    if (buffer.abort.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
      buffer.finish(false);
      return;
    }
    buffer.finish(true);
    const call = opts.callId ? ` call=${opts.callId}` : "";
    console.error(`[elevenlabs] greeting prefetch failed${call}`, err);
  }
}

export class GreetingAudioEntry {
  constructor(
    readonly text: string,
    readonly buffer: PcmuFrameBuffer,
  ) {}

  waitForIndex(index: number): Promise<void> {
    return this.buffer.waitForIndex(index);
  }

  get frames(): string[] {
    return this.buffer.frames;
  }

  get done(): boolean {
    return this.buffer.done;
  }

  get failed(): boolean {
    return this.buffer.failed;
  }
}

export type GreetingCacheStart = {
  callId: string;
  text: string;
  language: Language;
  tts: ElevenLabsTts;
  onHttpStart?: () => void;
  onFirstByte?: () => void;
};

export class GreetingAudioCache {
  private readonly entries = new Map<string, GreetingAudioEntry>();

  get(callId: string): GreetingAudioEntry | undefined {
    return this.entries.get(callId);
  }

  startIfNeeded(opts: GreetingCacheStart): GreetingAudioEntry {
    const existing = this.entries.get(opts.callId);
    if (
      existing &&
      existing.text === opts.text &&
      !existing.failed &&
      !existing.buffer.abort.signal.aborted
    ) {
      return existing;
    }
    if (existing) this.abort(opts.callId);
    const buffer = new PcmuFrameBuffer();
    const entry = new GreetingAudioEntry(opts.text, buffer);
    this.entries.set(opts.callId, entry);
    void fillPcmuFrameBuffer(buffer, {
      tts: opts.tts,
      text: opts.text,
      language: opts.language,
      callId: opts.callId,
      ...(opts.onHttpStart ? { onHttpStart: opts.onHttpStart } : {}),
      ...(opts.onFirstByte ? { onFirstByte: opts.onFirstByte } : {}),
    });
    return entry;
  }

  abort(callId: string): void {
    const entry = this.entries.get(callId);
    if (!entry) return;
    entry.buffer.abort.abort();
    entry.buffer.finish(false);
  }

  drop(callId: string): void {
    this.abort(callId);
    this.entries.delete(callId);
  }
}
