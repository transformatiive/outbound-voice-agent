import { firstSentenceAndRest } from "./speakable-text.js";

/** Human pause after the time-of-day opening before identity / ask. Not a speed-up. */
export const DEFAULT_POST_OPENING_PAUSE_MS = 550;
export const PCMU_FRAME_MS = 20;
export const PCMU_BYTES_PER_FRAME = 160;

export type SpokenGreetingBeats = {
  opening: string;
  intro: string;
};

/** Split a composed greeting so Telnyx can play opening, pause, then intro. */
export function spokenGreetingBeats(greeting: string): SpokenGreetingBeats {
  const { first, rest } = firstSentenceAndRest(greeting);
  return { opening: first.trim(), intro: rest.trim() };
}

export function greetingIntroCacheKey(callId: string): string {
  return `${callId}::intro`;
}

/** One 20ms G.711 μ-law silence frame (0xFF). Shared; do not mutate. */
export const PCMU_SILENCE_FRAME = Buffer.alloc(PCMU_BYTES_PER_FRAME, 0xff).toString("base64");

/** G.711 μ-law silence frames (0xFF) for a post-opening listen pause. */
export function pcmuSilenceFrames(durationMs: number): string[] {
  if (durationMs <= 0) return [];
  const frames = Math.max(1, Math.round(durationMs / PCMU_FRAME_MS));
  return Array.from({ length: frames }, () => PCMU_SILENCE_FRAME);
}
