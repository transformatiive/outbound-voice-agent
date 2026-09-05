import type { CallRecord, TranscriptLine } from "../calls/types.js";
import type { ElevenLabsTts } from "../elevenlabs.js";
import {
  DEFAULT_OUTPUT_SPEED,
  DEFAULT_TURN_DETECTION,
  sessionUpdatePayload,
  type TurnDetectionSettings,
} from "../grok/session.js";
import type { TelnyxClient } from "../telnyx/client.js";
import {
  DEFAULT_CALLEE_MIN_SPEECH_MS,
  DEFAULT_CALLEE_SPEECH_GRACE_MS,
  createCalleeSpeechGate,
  hasPendingPostGraceUnlock,
  msSinceStreamStart,
  noteStreamStart,
  onPostGraceCheck,
  onOngoingSpeechCheck,
  onSpeechStarted,
  onSpeechStopped,
  onTranscript,
  calleeTranscriptFromEvent,
  type CalleeSpeechDecision,
  type CalleeSpeechGate,
  type CalleeSpeechGateConfig,
} from "./callee-speech.js";

export type JsonObject = Record<string, unknown>;

/** Extra Telnyx playout after Grok `response.done` (Think Fast 2.0 can call end_call mid-sentence). */
export const DEFAULT_HANGUP_PLAYOUT_BUFFER_MS = 1000;
export const DEFAULT_HANGUP_MAX_WAIT_MS = 15_000;
const PCMU_BYTES_PER_MS = 8;

export type MediaBridgeOptions = {
  call: CallRecord;
  sendGrok: (event: JsonObject) => void;
  sendTelnyx: (event: JsonObject) => void;
  telnyx: TelnyxClient;
  hangupDelayMs?: number;
  hangupMaxWaitMs?: number;
  voice?: string;
  model?: string;
  extraInstructions?: string;
  turnDetection?: TurnDetectionSettings;
  outputSpeed?: number;
  calleeSpeechGraceMs?: number;
  calleeMinSpeechMs?: number;
  onEnded?: (call: CallRecord) => void;
  now?: () => string;
  clockMs?: () => number;
  elevenLabsTts?: ElevenLabsTts;
};

export class MediaBridge {
  readonly call: CallRecord;
  private readonly sendGrok: (event: JsonObject) => void;
  private readonly sendTelnyx: (event: JsonObject) => void;
  private readonly telnyx: TelnyxClient;
  private readonly hangupDelayMs: number;
  private readonly hangupMaxWaitMs: number;
  private readonly voice: string;
  private readonly extraInstructions: string | undefined;
  private readonly turnDetection: TurnDetectionSettings;
  private readonly outputSpeed: number;
  private readonly calleeSpeechConfig: CalleeSpeechGateConfig;
  private readonly calleeGate: CalleeSpeechGate;
  private readonly onEnded: ((call: CallRecord) => void) | undefined;
  private readonly now: () => string;
  private readonly clockMs: () => number;
  private greetingSent = false;
  private greetingPlaying = false;
  private suppressUntilNextCalleeSpeech = false;
  private suppressAssistantAudio = false;
  private hangingUp = false;
  private grokResponsePending = false;
  private readonly pendingUser = new Map<string, string>();
  private grokConfigured = false;
  private readonly elevenLabsTts: ElevenLabsTts | undefined;
  private elGeneration = 0;
  private elAbort: AbortController | undefined;
  private elInFlight = false;
  private elExpectingUtterance = false;
  private greetingElDone = true;
  private greetingGrokDone = true;
  private greetingResponseId = "";
  private lastElSpokenText = "";
  private readonly elSpokenResponseIds = new Set<string>();
  private turnAudio: { playMs: number; firstDeltaAtMs: number | undefined; done: boolean } = {
    playMs: 0,
    firstDeltaAtMs: undefined,
    done: true,
  };
  private readonly responseDoneWaiters: Array<() => void> = [];

  constructor(opts: MediaBridgeOptions) {
    this.call = opts.call;
    this.sendGrok = opts.sendGrok;
    this.sendTelnyx = opts.sendTelnyx;
    this.telnyx = opts.telnyx;
    this.hangupDelayMs = opts.hangupDelayMs ?? DEFAULT_HANGUP_PLAYOUT_BUFFER_MS;
    this.hangupMaxWaitMs = opts.hangupMaxWaitMs ?? DEFAULT_HANGUP_MAX_WAIT_MS;
    this.voice = opts.voice ?? opts.call.voice;
    this.extraInstructions = opts.extraInstructions ?? opts.call.extraInstructions;
    this.turnDetection = opts.turnDetection ?? DEFAULT_TURN_DETECTION;
    this.outputSpeed = opts.outputSpeed ?? DEFAULT_OUTPUT_SPEED;
    this.calleeSpeechConfig = {
      graceMs: opts.calleeSpeechGraceMs ?? DEFAULT_CALLEE_SPEECH_GRACE_MS,
      minSpeechMs: opts.calleeMinSpeechMs ?? DEFAULT_CALLEE_MIN_SPEECH_MS,
    };
    this.calleeGate = createCalleeSpeechGate();
    this.onEnded = opts.onEnded;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.clockMs = opts.clockMs ?? Date.now;
    this.elevenLabsTts = opts.elevenLabsTts;
  }

  configureGrokSession(): void {
    const waitForCallee = this.isWaitingForCalleeSpeech();
    const autoRespond = this.greetingSent && !this.greetingPlaying;
    this.sendGrok(
      sessionUpdatePayload({
        voice: this.voice,
        language: this.call.language,
        greeting: this.call.greeting,
        objective: this.call.objective,
        ...(this.extraInstructions !== undefined
          ? { extraInstructions: this.extraInstructions }
          : {}),
        ...(waitForCallee ? { waitForCallee: true } : {}),
        ...(this.call.timezone ? { timezone: this.call.timezone } : {}),
        ...(this.call.botRole ? { botRole: this.call.botRole } : {}),
        ...(this.call.calleeRole ? { calleeRole: this.call.calleeRole } : {}),
        turnDetection: this.turnDetection,
        createResponse: autoRespond,
        includeIdleTimeout: autoRespond,
        outputSpeed: this.outputSpeed,
      }) as unknown as JsonObject,
    );
    this.grokConfigured = true;
  }

  speakGreeting(): void {
    if (this.greetingSent) return;
    const wasWaiting = this.call.waitForCallee === true;
    if (wasWaiting) this.cancelPendingGrokResponse();
    this.greetingSent = true;
    this.greetingPlaying = true;
    if (wasWaiting) this.suppressUntilNextCalleeSpeech = true;
    if (wasWaiting) this.flushUserTranscript();
    this.pushTranscript({ role: "assistant", text: this.call.greeting });
    this.sendGrok({
      type: "conversation.item.create",
      item: {
        type: "force_message",
        role: "assistant",
        interruptible: false,
        content: [{ type: "output_text", text: this.call.greeting }],
      },
    });
    this.suppressAssistantAudio = false;
    this.greetingGrokDone = false;
    this.greetingElDone = !this.usesElevenLabsPlayback();
    if (this.usesElevenLabsPlayback()) {
      void this.playElevenLabs(this.call.greeting, { isGreeting: true });
    }
    // Keep create_response false while the scripted greeting plays so the model
    // cannot immediately re-introduce itself. Instructions switch to "already delivered".
    this.configureGrokSession();
  }

  onTelnyxMessage(message: JsonObject): void {
    const event = String(message.event ?? "");
    switch (event) {
      case "connected":
        return;
      case "start":
        noteStreamStart(this.calleeGate, this.clockMs());
        if (this.call.status === "answered" || this.call.status === "dialing" || this.call.status === "ringing") {
          this.call.status = "in_progress";
        }
        return;
      case "media": {
        // Forward Telnyx PCMU to Grok immediately — no debounce or extra buffer.
        const media = message.media as JsonObject | undefined;
        const payload = media?.payload;
        if (typeof payload === "string" && payload.length > 0) {
          this.sendGrok({ type: "input_audio_buffer.append", audio: payload });
        }
        this.maybeUnlockAfterGrace("media");
        return;
      }
      case "stop":
        return;
      default:
        return;
    }
  }

  async onGrokEvent(event: JsonObject): Promise<void> {
    const type = String(event.type ?? "");
    switch (type) {
      case "session.created":
        if (!this.grokConfigured) this.configureGrokSession();
        return;
      case "session.updated":
        if (this.call.waitForCallee !== true) this.speakGreeting();
        return;
      case "response.created":
        this.onGrokResponseCreated(event);
        return;
      case "response.done":
        this.onGrokResponseDone(event);
        return;
      case "input_audio_buffer.timeout_triggered":
        if (this.isWaitingForCalleeSpeech()) this.cancelPendingGrokResponse(true);
        return;
      case "response.output_audio.delta":
      case "response.audio.delta": {
        this.forwardGrokAudio(event);
        return;
      }
      case "input_audio_buffer.speech_started": {
        if (this.hangingUp) return;
        const waiting = this.isWaitingForCalleeSpeech();
        const decision = onSpeechStarted(this.calleeGate, waiting, this.clockMs(), this.calleeSpeechConfig);
        if (waiting) {
          this.logCalleeGate(decision, "speech_started");
          if (decision.unlock) this.speakGreeting();
          return;
        }
        if (this.greetingPlaying && this.call.waitForCallee === true) return;
        this.bargeIn();
        return;
      }
      case "input_audio_buffer.speech_stopped": {
        const waiting = this.isWaitingForCalleeSpeech();
        const decision = onSpeechStopped(
          this.calleeGate,
          waiting,
          this.clockMs(),
          this.calleeSpeechConfig,
          vadAudioDurationMs(event),
        );
        if (waiting) {
          this.logCalleeGate(decision, "speech_stopped");
          if (decision.unlock) this.speakGreeting();
        }
        return;
      }
      case "conversation.item.input_audio_transcription.completed":
      case "conversation.item.input_audio_transcription.updated":
      case "conversation.item.input_audio_transcription.delta": {
        const itemId = typeof event.item_id === "string" ? event.item_id : "";
        const raw = calleeTranscriptFromEvent(event);
        const transcript = raw.trim();
        if (this.isWaitingForCalleeSpeech()) {
          const decision = onTranscript(true, raw);
          this.logCalleeGate(decision, "transcript", raw);
          if (!decision.unlock) return;
          if (itemId && transcript) this.pendingUser.set(itemId, transcript);
          this.speakGreeting();
          return;
        }
        if (itemId && transcript) this.pendingUser.set(itemId, transcript);
        return;
      }
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done":
      case "response.output_text.done":
      case "response.text.done": {
        if (this.isWaitingForCalleeSpeech()) return;
        this.flushUserTranscript();
        const transcript = assistantTextFromEvent(event);
        if (transcript) this.pushTranscript({ role: "assistant", text: transcript });
        this.maybeSpeakAssistantText(transcript, responseIdFromEvent(event));
        return;
      }
      case "response.function_call_arguments.done":
      case "response.output_item.done": {
        const name = String(event.name ?? (event.item as JsonObject | undefined)?.name ?? "");
        if (name !== "end_call") return;
        const callId = String(event.call_id ?? (event.item as JsonObject | undefined)?.call_id ?? "");
        if (callId) {
          this.sendGrok({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: callId,
              output: JSON.stringify({ ok: true }),
            },
          });
        }
        await this.requestHangup("end_call");
        return;
      }
      case "error":
        console.error(`[bridge ${this.call.id}] grok error`, JSON.stringify(event).slice(0, 400));
        return;
      default:
        return;
    }
  }

  async requestHangup(reason: string): Promise<void> {
    if (this.hangingUp) return;
    this.hangingUp = true;
    this.call.endedReason = this.call.endedReason ?? reason;
    if (reason === "end_call") {
      await this.waitForGoodbyePlayout();
    } else if (this.hangupDelayMs > 0) {
      await delay(this.hangupDelayMs);
    }
    try {
      if (this.call.telnyx.callControlId) {
        await this.telnyx.hangup(this.call.telnyx.callControlId);
      }
    } catch (err) {
      console.error(`[bridge ${this.call.id}] hangup`, err);
    }
    this.markEnded(reason);
  }

  markEnded(reason: string): void {
    this.abortElevenLabsPlayback();
    if (this.call.status === "completed" || this.call.status === "failed" || this.call.status === "no_answer" || this.call.status === "busy") {
      this.onEnded?.(this.call);
      return;
    }
    this.call.status = reason === "error" ? "failed" : "completed";
    this.call.endedReason = this.call.endedReason ?? reason;
    this.call.endedAt = this.now();
    this.flushUserTranscript();
    this.onEnded?.(this.call);
  }

  private isWaitingForCalleeSpeech(): boolean {
    return this.call.waitForCallee === true && !this.greetingSent;
  }

  private onGrokResponseCreated(event: JsonObject): void {
    const responseId = responseIdFromEvent(event);
    if (!this.greetingSent) {
      this.cancelPendingGrokResponse(true);
      return;
    }
    if (this.greetingPlaying) {
      if (this.grokResponsePending) return;
      this.grokResponsePending = true;
      this.suppressAssistantAudio = false;
      if (responseId) this.greetingResponseId = responseId;
      if (!this.usesElevenLabsPlayback()) this.beginTurnAudio();
      return;
    }
    if (this.suppressUntilNextCalleeSpeech) {
      this.cancelPendingGrokResponse(true);
      return;
    }
    this.grokResponsePending = true;
    this.suppressAssistantAudio = false;
    if (this.usesElevenLabsPlayback()) {
      this.elExpectingUtterance = true;
      this.turnAudio.done = false;
    } else {
      this.beginTurnAudio();
    }
  }

  private onGrokResponseDone(event: JsonObject): void {
    this.grokResponsePending = false;
    if (this.usesElevenLabsPlayback()) {
      if (this.elExpectingUtterance && !this.elInFlight) {
        const leftover = assistantTextFromResponse(event);
        if (leftover) {
          this.maybeSpeakAssistantText(leftover, responseIdFromEvent(event));
        } else {
          this.elExpectingUtterance = false;
          this.turnAudio.done = true;
          this.flushResponseDoneWaiters();
        }
      } else if (!this.elInFlight) {
        this.turnAudio.done = true;
        this.flushResponseDoneWaiters();
      }
    } else {
      this.turnAudio.done = true;
      this.flushResponseDoneWaiters();
    }
    if (!this.greetingPlaying) return;
    this.greetingGrokDone = true;
    this.maybeFinishGreetingPlayback();
  }

  private bargeIn(): void {
    this.suppressUntilNextCalleeSpeech = false;
    this.sendTelnyx({ event: "clear" });
    this.cancelPendingGrokResponse(true);
    this.abortElevenLabsPlayback();
    if (this.greetingPlaying) {
      this.greetingPlaying = false;
      this.greetingElDone = true;
      this.greetingGrokDone = true;
      this.configureGrokSession();
    }
  }

  private cancelPendingGrokResponse(force = false): void {
    if (!force && !this.grokResponsePending) return;
    this.sendGrok({ type: "response.cancel" });
    this.grokResponsePending = false;
    this.suppressAssistantAudio = true;
  }

  private forwardGrokAudio(event: JsonObject): void {
    if (this.usesElevenLabsPlayback()) return;
    if (this.isWaitingForCalleeSpeech()) return;
    if (!this.greetingSent) return;
    if (this.suppressAssistantAudio) return;
    const delta =
      typeof event.delta === "string" ? event.delta : typeof event.audio === "string" ? event.audio : undefined;
    if (typeof delta === "string" && delta.length > 0) {
      this.noteTurnAudio(delta);
      this.sendTelnyx({ event: "media", media: { payload: delta } });
    }
  }

  private beginTurnAudio(): void {
    this.turnAudio = { playMs: 0, firstDeltaAtMs: undefined, done: false };
  }

  private noteTurnAudio(base64: string): void {
    this.turnAudio.playMs += pcmuPlayoutMsFromBase64(base64);
    this.turnAudio.firstDeltaAtMs ??= this.clockMs();
    this.turnAudio.done = false;
  }

  private estimateRemainingPlayoutMs(): number {
    const elapsed =
      this.turnAudio.firstDeltaAtMs !== undefined
        ? Math.max(0, this.clockMs() - this.turnAudio.firstDeltaAtMs)
        : 0;
    return Math.max(0, this.turnAudio.playMs - elapsed);
  }

  private async waitForGoodbyePlayout(): Promise<void> {
    const deadline = this.clockMs() + this.hangupMaxWaitMs;
    if (!this.goodbyePlayoutReady()) {
      await this.waitForResponseDone(Math.max(0, deadline - this.clockMs()));
    }
    const waitMs = Math.min(
      Math.max(0, deadline - this.clockMs()),
      this.estimateRemainingPlayoutMs() + this.hangupDelayMs,
    );
    if (waitMs > 0) await delay(waitMs);
  }

  private waitForResponseDone(timeoutMs: number): Promise<void> {
    if (this.goodbyePlayoutReady()) return Promise.resolve();
    if (timeoutMs <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      let finish: () => void = () => undefined;
      const timer = setTimeout(() => {
        this.removeResponseDoneWaiter(finish);
        resolve();
      }, timeoutMs);
      finish = (): void => {
        clearTimeout(timer);
        resolve();
      };
      this.responseDoneWaiters.push(finish);
    });
  }

  private goodbyePlayoutReady(): boolean {
    if (this.grokResponsePending) return false;
    if (!this.turnAudio.done) return false;
    if (this.elInFlight || this.elExpectingUtterance) return false;
    return true;
  }

  private usesElevenLabsPlayback(): boolean {
    return this.call.ttsProvider === "elevenlabs" && this.elevenLabsTts !== undefined;
  }

  private abortElevenLabsPlayback(): void {
    this.elGeneration += 1;
    this.elAbort?.abort();
    this.elAbort = undefined;
    this.elInFlight = false;
    this.elExpectingUtterance = false;
    if (this.usesElevenLabsPlayback()) {
      this.turnAudio.done = true;
    }
    this.flushResponseDoneWaiters();
  }

  private maybeFinishGreetingPlayback(): void {
    if (!this.greetingPlaying) return;
    if (!this.greetingGrokDone || !this.greetingElDone) return;
    this.greetingPlaying = false;
    this.configureGrokSession();
  }

  private maybeSpeakAssistantText(text: string, responseId: string): void {
    if (!this.usesElevenLabsPlayback()) return;
    if (this.isWaitingForCalleeSpeech()) return;
    if (!this.greetingSent) return;
    if (this.greetingPlaying) return;
    if (this.suppressAssistantAudio) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    if (responseId && (responseId === this.greetingResponseId || this.elSpokenResponseIds.has(responseId))) {
      return;
    }
    if (trimmed === this.call.greeting || trimmed === this.lastElSpokenText) return;
    void this.playElevenLabs(trimmed, { responseId });
  }

  private async playElevenLabs(
    text: string,
    opts: { isGreeting?: boolean; responseId?: string } = {},
  ): Promise<void> {
    if (!this.elevenLabsTts) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    const generation = this.elGeneration + 1;
    this.elGeneration = generation;
    this.elAbort?.abort();
    const abort = new AbortController();
    this.elAbort = abort;
    this.elInFlight = true;
    this.elExpectingUtterance = false;
    this.beginTurnAudio();
    if (opts.responseId) this.elSpokenResponseIds.add(opts.responseId);
    this.lastElSpokenText = trimmed;
    try {
      for await (const chunk of this.elevenLabsTts.speakToPcmu({
        text: trimmed,
        language: this.call.language,
        signal: abort.signal,
      })) {
        if (generation !== this.elGeneration || abort.signal.aborted || this.suppressAssistantAudio) {
          return;
        }
        if (chunk.length > 0) {
          this.noteTurnAudio(chunk);
          this.sendTelnyx({ event: "media", media: { payload: chunk } });
        }
      }
    } catch (err) {
      if (abort.signal.aborted || (err instanceof Error && err.name === "AbortError")) return;
      console.error(`[bridge ${this.call.id}] elevenlabs tts`, err);
    } finally {
      if (generation === this.elGeneration) {
        this.elInFlight = false;
        this.turnAudio.done = true;
        this.flushResponseDoneWaiters();
        if (opts.isGreeting === true || this.greetingPlaying) {
          this.greetingElDone = true;
          this.maybeFinishGreetingPlayback();
        }
      }
    }
  }

  private flushResponseDoneWaiters(): void {
    if (!this.goodbyePlayoutReady()) return;
    const waiters = this.responseDoneWaiters.splice(0);
    for (const waiter of waiters) waiter();
  }

  private removeResponseDoneWaiter(waiter: () => void): void {
    const idx = this.responseDoneWaiters.indexOf(waiter);
    if (idx >= 0) this.responseDoneWaiters.splice(idx, 1);
  }

  private maybeUnlockAfterGrace(event: string): void {
    if (!this.isWaitingForCalleeSpeech()) return;
    const atMs = this.clockMs();
    if (hasPendingPostGraceUnlock(this.calleeGate)) {
      const elapsed = msSinceStreamStart(this.calleeGate, atMs);
      if (elapsed !== undefined && elapsed >= this.calleeSpeechConfig.graceMs) {
        const decision = onPostGraceCheck(this.calleeGate, true, atMs, this.calleeSpeechConfig);
        this.logCalleeGate(decision, event);
        if (decision.unlock) this.speakGreeting();
        return;
      }
    }
    if (this.calleeGate.acceptedSpeechStartedAtMs === undefined) return;
    if (atMs - this.calleeGate.acceptedSpeechStartedAtMs < this.calleeSpeechConfig.minSpeechMs) {
      return;
    }
    const decision = onOngoingSpeechCheck(this.calleeGate, true, atMs, this.calleeSpeechConfig);
    if (!decision.unlock) return;
    this.logCalleeGate(decision, event);
    this.speakGreeting();
  }

  private logCalleeGate(decision: CalleeSpeechDecision, event: string, transcript?: string): void {
    if (decision.reason === "not_waiting") return;
    const elapsed = msSinceStreamStart(this.calleeGate, this.clockMs());
    const elapsedLabel =
      elapsed === undefined ? "stream not started" : `${elapsed}ms since stream start`;
    const textLabel =
      transcript !== undefined ? ` text=${JSON.stringify(transcript.slice(0, 80))}` : "";
    if (decision.unlock) {
      console.info(
        `[bridge ${this.call.id}] waitForCallee: unlock via ${decision.reason} (${event}) — ${elapsedLabel}${textLabel}`,
      );
      return;
    }
    console.info(
      `[bridge ${this.call.id}] waitForCallee: greeting blocked (${decision.reason}) on ${event} — ${elapsedLabel}${textLabel}`,
    );
  }

  private flushUserTranscript(): void {
    for (const text of this.pendingUser.values()) {
      if (text) this.pushTranscript({ role: "user", text });
    }
    this.pendingUser.clear();
  }

  private pushTranscript(line: TranscriptLine): void {
    const last = this.call.transcript[this.call.transcript.length - 1];
    if (last && last.role === line.role && last.text === line.text) return;
    this.call.transcript.push(line);
  }
}

function vadAudioDurationMs(event: JsonObject): number | undefined {
  const start = asFiniteNumber(event.audio_start_ms);
  const end = asFiniteNumber(event.audio_end_ms);
  if (start === undefined || end === undefined || end < start) return undefined;
  return end - start;
}

function assistantTextFromEvent(event: JsonObject): string {
  if (typeof event.transcript === "string" && event.transcript.trim()) return event.transcript.trim();
  if (typeof event.text === "string" && event.text.trim()) return event.text.trim();
  return "";
}

function assistantTextFromResponse(event: JsonObject): string {
  const response = event.response as JsonObject | undefined;
  const output = response?.output;
  if (!Array.isArray(output)) return "";
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as JsonObject).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const piece = part as JsonObject;
      if (typeof piece.transcript === "string" && piece.transcript.trim()) {
        parts.push(piece.transcript.trim());
      } else if (typeof piece.text === "string" && piece.text.trim()) {
        parts.push(piece.text.trim());
      }
    }
  }
  return parts.join(" ").trim();
}

function responseIdFromEvent(event: JsonObject): string {
  if (typeof event.response_id === "string" && event.response_id) return event.response_id;
  const response = event.response as JsonObject | undefined;
  if (typeof response?.id === "string" && response.id) return response.id;
  return "";
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function pcmuPlayoutMsFromBase64(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const bytes = Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
  return Math.floor(bytes / PCMU_BYTES_PER_MS);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
