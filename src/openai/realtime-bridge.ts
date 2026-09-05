import type { CallRecord, TranscriptLine } from "../calls/types.js";
import type { JsonObject } from "../bridge/media-bridge.js";
import {
  DEFAULT_HANGUP_MAX_WAIT_MS,
  DEFAULT_HANGUP_PLAYOUT_BUFFER_MS,
  pcmuPlayoutMsFromBase64,
} from "../bridge/media-bridge.js";
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
} from "../bridge/callee-speech.js";
import { DEFAULT_TURN_DETECTION, type TurnDetectionSettings } from "../grok/session.js";
import type { TelnyxClient } from "../telnyx/client.js";
import {
  openaiAssistantGreetingItem,
  openaiGreetingResponseCreate,
  openaiSessionUpdatePayload,
} from "./session.js";

export type OpenAIMediaBridgeOptions = {
  call: CallRecord;
  sendOpenAI: (event: JsonObject) => void;
  sendTelnyx: (event: JsonObject) => void;
  telnyx: TelnyxClient;
  hangupDelayMs?: number;
  hangupMaxWaitMs?: number;
  voice?: string;
  model?: string;
  extraInstructions?: string;
  turnDetection?: TurnDetectionSettings;
  calleeSpeechGraceMs?: number;
  calleeMinSpeechMs?: number;
  onEnded?: (call: CallRecord) => void;
  now?: () => string;
  clockMs?: () => number;
};

/**
 * Telnyx ↔ OpenAI Realtime speech-to-speech bridge.
 * Generate-early / speak-late: greeting audio is requested as soon as the
 * session is warm, buffered while muted, and flushed to Telnyx only after
 * waitForCallee unlock (or immediately once Telnyx is attached if not waiting).
 */
export class OpenAIMediaBridge {
  readonly call: CallRecord;
  private sendOpenAI: (event: JsonObject) => void;
  private sendTelnyx: (event: JsonObject) => void;
  private readonly telnyx: TelnyxClient;
  private readonly hangupDelayMs: number;
  private readonly hangupMaxWaitMs: number;
  private readonly voice: string;
  private readonly model: string;
  private readonly extraInstructions: string | undefined;
  private readonly turnDetection: TurnDetectionSettings;
  private readonly calleeSpeechConfig: CalleeSpeechGateConfig;
  private readonly calleeGate: CalleeSpeechGate;
  private onEnded: ((call: CallRecord) => void) | undefined;
  private readonly now: () => string;
  private readonly clockMs: () => number;

  private sessionConfigured = false;
  private sessionReady = false;
  private sessionFailed: Error | undefined;
  private readonly readyWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
  private telnyxAttached = false;
  private greetingSent = false;
  private greetingPlaying = false;
  private greetingRequested = false;
  private greetingResponseId = "";
  private greetingInjected = false;
  private greetingChunks: string[] = [];
  private greetingGeneration = 0;
  private greetingDone = false;
  private suppressUntilNextCalleeSpeech = false;
  private suppressAssistantAudio = false;
  private hangingUp = false;
  private openaiResponsePending = false;
  private readonly pendingUser = new Map<string, string>();
  private turnAudio: { playMs: number; firstDeltaAtMs: number | undefined; done: boolean } = {
    playMs: 0,
    firstDeltaAtMs: undefined,
    done: true,
  };
  private readonly responseDoneWaiters: Array<() => void> = [];
  private closed = false;

  constructor(opts: OpenAIMediaBridgeOptions) {
    this.call = opts.call;
    this.sendOpenAI = opts.sendOpenAI;
    this.sendTelnyx = opts.sendTelnyx;
    this.telnyx = opts.telnyx;
    this.hangupDelayMs = opts.hangupDelayMs ?? DEFAULT_HANGUP_PLAYOUT_BUFFER_MS;
    this.hangupMaxWaitMs = opts.hangupMaxWaitMs ?? DEFAULT_HANGUP_MAX_WAIT_MS;
    this.voice = opts.voice ?? opts.call.voice;
    this.model = opts.model ?? opts.call.model;
    this.extraInstructions = opts.extraInstructions ?? opts.call.extraInstructions;
    this.turnDetection = opts.turnDetection ?? DEFAULT_TURN_DETECTION;
    this.calleeSpeechConfig = {
      graceMs: opts.calleeSpeechGraceMs ?? DEFAULT_CALLEE_SPEECH_GRACE_MS,
      minSpeechMs: opts.calleeMinSpeechMs ?? DEFAULT_CALLEE_MIN_SPEECH_MS,
    };
    this.calleeGate = createCalleeSpeechGate();
    this.onEnded = opts.onEnded;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.clockMs = opts.clockMs ?? Date.now;
  }

  attachTelnyx(sendTelnyx: (event: JsonObject) => void): void {
    this.sendTelnyx = sendTelnyx;
    this.telnyxAttached = true;
    if (this.call.waitForCallee !== true && this.sessionReady) this.speakGreeting();
    else this.flushGreetingIfReady();
  }

  setOnEnded(onEnded: (call: CallRecord) => void): void {
    this.onEnded = onEnded;
  }

  failSession(err: Error): void {
    if (this.sessionReady || this.sessionFailed) return;
    this.sessionFailed = err;
    this.rejectReadyWaiters(err);
  }

  waitUntilReady(timeoutMs: number): Promise<void> {
    if (this.sessionReady) return Promise.resolve();
    if (this.sessionFailed) return Promise.reject(this.sessionFailed);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeReadyWaiter(entry);
        reject(new Error("openai_session_timeout"));
      }, timeoutMs);
      const entry = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      this.readyWaiters.push(entry);
    });
  }

  configureSession(): void {
    const waitForCallee = this.isWaitingForCalleeSpeech();
    const autoRespond = this.greetingSent && !this.greetingPlaying;
    this.sendOpenAI(
      openaiSessionUpdatePayload({
        voice: this.voice,
        model: this.model,
        language: this.call.language,
        greeting: this.call.greeting,
        objective: this.call.objective,
        ...(this.extraInstructions !== undefined ? { extraInstructions: this.extraInstructions } : {}),
        ...(waitForCallee ? { waitForCallee: true } : {}),
        ...(this.call.timezone ? { timezone: this.call.timezone } : {}),
        ...(this.call.botRole ? { botRole: this.call.botRole } : {}),
        ...(this.call.calleeRole ? { calleeRole: this.call.calleeRole } : {}),
        turnDetection: this.turnDetection,
        createResponse: autoRespond,
        includeIdleTimeout: autoRespond,
      }) as unknown as JsonObject,
    );
    this.sessionConfigured = true;
  }

  /** Generate greeting audio now; Telnyx hears it only after speakGreeting / unlock. */
  requestGreetingAudio(): void {
    if (this.greetingRequested || this.greetingDone) return;
    this.greetingRequested = true;
    this.greetingGeneration += 1;
    this.sendOpenAI(openaiGreetingResponseCreate({
      callId: this.call.id,
      language: this.call.language,
      greeting: this.call.greeting,
    }) as unknown as JsonObject);
  }

  speakGreeting(): void {
    if (this.greetingSent) {
      this.flushGreetingIfReady();
      return;
    }
    const wasWaiting = this.call.waitForCallee === true;
    if (wasWaiting) this.cancelPendingOpenAIResponse();
    this.greetingSent = true;
    this.greetingPlaying = true;
    if (wasWaiting) this.suppressUntilNextCalleeSpeech = true;
    if (wasWaiting) this.flushUserTranscript();
    this.pushTranscript({ role: "assistant", text: this.call.greeting });
    this.injectGreetingIntoConversation();
    this.suppressAssistantAudio = false;
    if (!this.greetingRequested) this.requestGreetingAudio();
    this.flushGreetingIfReady();
    if (this.greetingDone) this.maybeFinishGreetingPlayback();
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
        if (this.call.waitForCallee !== true) this.speakGreeting();
        return;
      case "media": {
        const media = message.media as JsonObject | undefined;
        const payload = media?.payload;
        if (typeof payload === "string" && payload.length > 0) {
          this.sendOpenAI({ type: "input_audio_buffer.append", audio: payload });
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

  async onOpenAIEvent(event: JsonObject): Promise<void> {
    const type = String(event.type ?? "");
    switch (type) {
      case "session.created":
        if (!this.sessionConfigured) this.configureSession();
        return;
      case "session.updated":
        this.markSessionReady();
        this.requestGreetingAudio();
        if (this.call.waitForCallee !== true && this.telnyxAttached) this.speakGreeting();
        return;
      case "response.created":
        this.onResponseCreated(event);
        return;
      case "response.done":
        this.onResponseDone(event);
        return;
      case "input_audio_buffer.timeout_triggered":
        if (this.isWaitingForCalleeSpeech()) this.cancelPendingOpenAIResponse(true);
        return;
      case "response.output_audio.delta":
      case "response.audio.delta": {
        this.onAudioDelta(event);
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
        if (this.isGreetingResponse(event)) return;
        this.flushUserTranscript();
        const transcript = assistantTextFromEvent(event);
        if (transcript) this.pushTranscript({ role: "assistant", text: transcript });
        return;
      }
      case "response.function_call_arguments.done":
      case "response.output_item.done": {
        const item = event.item as JsonObject | undefined;
        const name = String(event.name ?? item?.name ?? "");
        if (name !== "end_call") return;
        const callId = String(event.call_id ?? item?.call_id ?? "");
        if (callId) {
          this.sendOpenAI({
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
        this.onSessionErrorEvent(event);
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
      console.error(`[openai-bridge ${this.call.id}] hangup`, err);
    }
    this.markEnded(reason);
  }

  markEnded(reason: string): void {
    if (this.closed) {
      this.onEnded?.(this.call);
      return;
    }
    this.closed = true;
    this.greetingGeneration += 1;
    if (
      this.call.status === "completed" ||
      this.call.status === "failed" ||
      this.call.status === "no_answer" ||
      this.call.status === "busy"
    ) {
      this.onEnded?.(this.call);
      return;
    }
    this.call.status = reason === "error" ? "failed" : "completed";
    this.call.endedReason = this.call.endedReason ?? reason;
    this.call.endedAt = this.now();
    this.flushUserTranscript();
    this.onEnded?.(this.call);
  }

  private markSessionReady(): void {
    if (this.sessionReady) return;
    this.sessionReady = true;
    const waiters = this.readyWaiters.splice(0);
    for (const waiter of waiters) waiter.resolve();
  }

  private rejectReadyWaiters(err: Error): void {
    const waiters = this.readyWaiters.splice(0);
    for (const waiter of waiters) waiter.reject(err);
  }

  private removeReadyWaiter(entry: { resolve: () => void; reject: (err: Error) => void }): void {
    const idx = this.readyWaiters.indexOf(entry);
    if (idx >= 0) this.readyWaiters.splice(idx, 1);
  }

  private onSessionErrorEvent(event: JsonObject): void {
    const snippet = JSON.stringify(event).slice(0, 400);
    console.error(`[openai-bridge ${this.call.id}] openai error`, snippet);
    if (this.sessionReady) return;
    const err = new Error(openaiErrorMessage(event));
    this.failSession(err);
  }

  private isWaitingForCalleeSpeech(): boolean {
    return this.call.waitForCallee === true && !this.greetingSent;
  }

  private onResponseCreated(event: JsonObject): void {
    const responseId = responseIdFromEvent(event);
    const isGreeting = this.isGreetingResponse(event) || (!this.greetingDone && this.greetingRequested && !this.greetingResponseId);
    if (isGreeting) {
      if (responseId) this.greetingResponseId = responseId;
      this.beginTurnAudio();
      return;
    }
    if (!this.greetingSent) {
      this.cancelPendingOpenAIResponse(true);
      return;
    }
    if (this.greetingPlaying) {
      this.cancelPendingOpenAIResponse(true);
      return;
    }
    if (this.suppressUntilNextCalleeSpeech) {
      this.cancelPendingOpenAIResponse(true);
      return;
    }
    this.openaiResponsePending = true;
    this.suppressAssistantAudio = false;
    this.beginTurnAudio();
  }

  private onResponseDone(event: JsonObject): void {
    if (this.isGreetingResponse(event) || (!this.greetingDone && this.greetingRequested)) {
      this.greetingDone = true;
      this.openaiResponsePending = false;
      this.turnAudio.done = true;
      this.flushResponseDoneWaiters();
      if (this.greetingPlaying || this.greetingSent) this.maybeFinishGreetingPlayback();
      return;
    }
    this.openaiResponsePending = false;
    this.turnAudio.done = true;
    this.flushResponseDoneWaiters();
    if (!this.greetingPlaying) return;
    this.maybeFinishGreetingPlayback();
  }

  private onAudioDelta(event: JsonObject): void {
    const delta =
      typeof event.delta === "string" ? event.delta : typeof event.audio === "string" ? event.audio : undefined;
    if (typeof delta !== "string" || delta.length === 0) return;
    const greeting = this.isGreetingResponse(event) || (!this.greetingDone && this.greetingRequested);
    if (greeting) {
      this.greetingChunks.push(delta);
      this.flushGreetingIfReady();
      return;
    }
    if (this.isWaitingForCalleeSpeech()) return;
    if (!this.greetingSent) return;
    if (this.suppressAssistantAudio) return;
    if (!this.telnyxAttached) return;
    this.noteTurnAudio(delta);
    this.sendTelnyx({ event: "media", media: { payload: delta } });
  }

  private flushGreetingIfReady(): void {
    if (!this.telnyxAttached || !this.greetingSent || this.suppressAssistantAudio) return;
    if (this.greetingChunks.length === 0) return;
    const generation = this.greetingGeneration;
    for (const chunk of this.greetingChunks) {
      if (generation !== this.greetingGeneration || this.suppressAssistantAudio) return;
      this.noteTurnAudio(chunk);
      this.sendTelnyx({ event: "media", media: { payload: chunk } });
    }
    this.greetingChunks = [];
    if (this.greetingDone) this.maybeFinishGreetingPlayback();
  }

  private injectGreetingIntoConversation(): void {
    if (this.greetingInjected) return;
    this.greetingInjected = true;
    this.sendOpenAI(openaiAssistantGreetingItem(this.call.greeting) as unknown as JsonObject);
  }

  private bargeIn(): void {
    this.suppressUntilNextCalleeSpeech = false;
    this.greetingChunks = [];
    this.greetingGeneration += 1;
    if (this.telnyxAttached) this.sendTelnyx({ event: "clear" });
    this.sendOpenAI({ type: "output_audio_buffer.clear" });
    this.cancelPendingOpenAIResponse(true);
    if (this.greetingPlaying) {
      this.greetingPlaying = false;
      this.greetingDone = true;
      this.configureSession();
    }
  }

  private cancelPendingOpenAIResponse(force = false): void {
    if (!force && !this.openaiResponsePending) return;
    this.sendOpenAI({ type: "response.cancel" });
    this.openaiResponsePending = false;
    this.suppressAssistantAudio = true;
  }

  private isGreetingResponse(event: JsonObject): boolean {
    const responseId = responseIdFromEvent(event);
    if (this.greetingResponseId && responseId && responseId === this.greetingResponseId) return true;
    const eventId = typeof event.event_id === "string" ? event.event_id : "";
    if (eventId === `greeting-${this.call.id}`) return true;
    const response = event.response as JsonObject | undefined;
    const metadata = response?.metadata as JsonObject | undefined;
    if (metadata?.purpose === "greeting") return true;
    return false;
  }

  private maybeFinishGreetingPlayback(): void {
    if (!this.greetingPlaying) return;
    if (!this.greetingDone) return;
    this.greetingPlaying = false;
    this.configureSession();
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
      this.turnAudio.firstDeltaAtMs !== undefined ? Math.max(0, this.clockMs() - this.turnAudio.firstDeltaAtMs) : 0;
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
    if (this.openaiResponsePending) return false;
    if (!this.turnAudio.done) return false;
    return true;
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
    const elapsedLabel = elapsed === undefined ? "stream not started" : `${elapsed}ms since stream start`;
    const textLabel = transcript !== undefined ? ` text=${JSON.stringify(transcript.slice(0, 80))}` : "";
    if (decision.unlock) {
      console.info(
        `[openai-bridge ${this.call.id}] waitForCallee: unlock via ${decision.reason} (${event}) — ${elapsedLabel}${textLabel}`,
      );
      return;
    }
    console.info(
      `[openai-bridge ${this.call.id}] waitForCallee: greeting blocked (${decision.reason}) on ${event} — ${elapsedLabel}${textLabel}`,
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

function responseIdFromEvent(event: JsonObject): string {
  if (typeof event.response_id === "string" && event.response_id) return event.response_id;
  const response = event.response as JsonObject | undefined;
  if (typeof response?.id === "string" && response.id) return response.id;
  return "";
}

function openaiErrorMessage(event: JsonObject): string {
  const error = event.error;
  if (error && typeof error === "object") {
    const rec = error as JsonObject;
    if (typeof rec.message === "string" && rec.message.trim()) return rec.message;
    if (typeof rec.code === "string" && rec.code.trim()) return rec.code;
  }
  if (typeof event.message === "string" && event.message.trim()) return event.message;
  return "openai_session_error";
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
