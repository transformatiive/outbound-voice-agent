import type { CallRecord, TranscriptLine } from "../calls/types.js";
import {
  DEFAULT_HANGUP_MAX_WAIT_MS,
  DEFAULT_HANGUP_PLAYOUT_BUFFER_MS,
  DEFAULT_WAIT_FOR_CALLEE_STALL_MS,
  pcmuPlayoutMsFromBase64,
  type JsonObject,
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
  onTranscript,
  pcmuPayloadLooksLikeSpeech,
  type CalleeSpeechDecision,
  type CalleeSpeechGate,
  type CalleeSpeechGateConfig,
} from "../bridge/callee-speech.js";
import { handleRealtimeToolCall } from "../dtmf.js";
import type { TelnyxClient } from "../telnyx/client.js";
import {
  gptLiveGreetingCommentaryAppend,
  gptLiveGreetingDeliveredThinkingAppend,
  gptLiveGreetingInstructionsAppend,
  gptLiveSessionStartPayload,
} from "./live-session.js";

export type GptLiveMediaBridgeOptions = {
  call: CallRecord;
  sendLive: (event: JsonObject) => void;
  sendTelnyx: (event: JsonObject) => void;
  telnyx: TelnyxClient;
  hangupDelayMs?: number;
  hangupMaxWaitMs?: number;
  voice?: string;
  model?: string;
  delegateModel?: string;
  extraInstructions?: string;
  calleeSpeechGraceMs?: number;
  calleeMinSpeechMs?: number;
  onEnded?: (call: CallRecord) => void;
  now?: () => string;
  clockMs?: () => number;
};

/**
 * Telnyx ↔ GPT-Live (`gpt-live-1`) speech-to-speech bridge.
 * Generate-early / speak-late: greeting audio is requested on `session.started`,
 * buffered while muted, and flushed to Telnyx only after waitForCallee unlock
 * (or immediately once Telnyx is attached if not waiting).
 */
export class GptLiveMediaBridge {
  readonly call: CallRecord;
  private sendLive: (event: JsonObject) => void;
  private sendTelnyx: (event: JsonObject) => void;
  private readonly telnyx: TelnyxClient;
  private readonly hangupDelayMs: number;
  private readonly hangupMaxWaitMs: number;
  private readonly voice: string;
  private readonly model: string;
  private readonly delegateModel: string | undefined;
  private readonly extraInstructions: string | undefined;
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
  private greetingChunks: string[] = [];
  private greetingGeneration = 0;
  private hangingUp = false;
  private readonly pendingUser = new Map<string, string>();
  private pendingInputTranscript = "";
  private pendingOutputTranscript = "";
  private turnAudio: { playMs: number; firstDeltaAtMs: number | undefined; done: boolean } = {
    playMs: 0,
    firstDeltaAtMs: undefined,
    done: true,
  };
  private readonly handledToolCalls = new Set<string>();
  private closed = false;
  private inboundMediaFrames = 0;
  private waitForCalleeStallLogged = false;
  private waitForCalleeNeverUnlockedLogged = false;

  constructor(opts: GptLiveMediaBridgeOptions) {
    this.call = opts.call;
    this.sendLive = opts.sendLive;
    this.sendTelnyx = opts.sendTelnyx;
    this.telnyx = opts.telnyx;
    this.hangupDelayMs = opts.hangupDelayMs ?? DEFAULT_HANGUP_PLAYOUT_BUFFER_MS;
    this.hangupMaxWaitMs = opts.hangupMaxWaitMs ?? DEFAULT_HANGUP_MAX_WAIT_MS;
    this.voice = opts.voice ?? opts.call.voice;
    this.model = opts.model ?? opts.call.model;
    this.delegateModel = opts.delegateModel;
    this.extraInstructions = opts.extraInstructions ?? opts.call.extraInstructions;
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
    if (this.sessionConfigured) return;
    this.sendLive(
      gptLiveSessionStartPayload({
        voice: this.voice,
        model: this.model,
        language: this.call.language,
        greeting: this.call.greeting,
        objective: this.call.objective,
        ...(this.delegateModel ? { delegateModel: this.delegateModel } : {}),
        ...(this.extraInstructions !== undefined ? { extraInstructions: this.extraInstructions } : {}),
        ...(this.call.timezone ? { timezone: this.call.timezone } : {}),
        ...(this.call.botRole ? { botRole: this.call.botRole } : {}),
        ...(this.call.calleeRole ? { calleeRole: this.call.calleeRole } : {}),
        ...(this.call.ivr ? { ivr: true } : {}),
      }) as unknown as JsonObject,
    );
    this.sessionConfigured = true;
  }

  requestGreetingAudio(): void {
    if (this.greetingRequested) return;
    this.greetingRequested = true;
    this.greetingGeneration += 1;
    this.beginTurnAudio();
    this.sendLive(
      gptLiveGreetingInstructionsAppend({
        callId: this.call.id,
        language: this.call.language,
        greeting: this.call.greeting,
      }) as unknown as JsonObject,
    );
    this.sendLive(
      gptLiveGreetingCommentaryAppend({
        callId: this.call.id,
        language: this.call.language,
      }) as unknown as JsonObject,
    );
  }

  speakGreeting(): void {
    if (this.greetingSent) {
      this.flushGreetingIfReady();
      return;
    }
    this.greetingSent = true;
    this.greetingPlaying = true;
    this.flushUserTranscript();
    this.pushTranscript({ role: "assistant", text: this.call.greeting });
    if (!this.greetingRequested) this.requestGreetingAudio();
    this.sendLive(
      gptLiveGreetingDeliveredThinkingAppend({
        callId: this.call.id,
        language: this.call.language,
        greeting: this.call.greeting,
      }) as unknown as JsonObject,
    );
    this.flushGreetingIfReady();
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
          this.inboundMediaFrames += 1;
          if (this.sessionReady) {
            this.sendLive({ type: "session.input_audio.append", audio: payload });
          }
          if (this.isWaitingForCalleeSpeech() && pcmuPayloadLooksLikeSpeech(payload)) {
            const decision = onSpeechStarted(
              this.calleeGate,
              true,
              this.clockMs(),
              this.calleeSpeechConfig,
            );
            this.logCalleeGate(decision, "speech_started");
            if (decision.unlock) this.speakGreeting();
          }
        }
        this.maybeUnlockAfterGrace("media");
        this.maybeLogWaitForCalleeStall();
        return;
      }
      case "stop":
        return;
      default:
        return;
    }
  }

  async onLiveEvent(event: JsonObject): Promise<void> {
    const type = String(event.type ?? "");
    switch (type) {
      case "session.started":
        this.markSessionReady();
        this.requestGreetingAudio();
        if (this.call.waitForCallee !== true && this.telnyxAttached) this.speakGreeting();
        return;
      case "session.output_audio.delta": {
        this.onAudioDelta(event);
        return;
      }
      case "session.input_transcript.delta":
      case "session.input_transcript.done": {
        this.onInputTranscript(event);
        return;
      }
      case "session.output_transcript.delta":
      case "session.output_transcript.done": {
        this.onOutputTranscript(event);
        return;
      }
      case "response.event": {
        const inner = event.event;
        if (inner && typeof inner === "object") {
          await this.onDelegatedResponseEvent(inner as JsonObject);
        }
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
      console.error(`[gpt-live-bridge ${this.call.id}] hangup`, err);
    }
    this.sendLive({ type: "session.close" });
    this.markEnded(reason);
  }

  markEnded(reason: string): void {
    if (this.closed) {
      this.flushUserTranscript();
      this.flushAssistantTranscript();
      this.logWaitForCalleeNeverUnlocked("hangup");
      this.onEnded?.(this.call);
      return;
    }
    this.closed = true;
    this.greetingGeneration += 1;
    this.flushUserTranscript();
    this.flushAssistantTranscript();
    this.logWaitForCalleeNeverUnlocked("hangup");
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
    this.onEnded?.(this.call);
  }

  flushTranscript(): void {
    this.flushUserTranscript();
    this.flushAssistantTranscript();
    this.logWaitForCalleeNeverUnlocked("hangup");
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
    console.error(`[gpt-live-bridge ${this.call.id}] openai live error`, snippet);
    if (this.sessionReady) return;
    const err = new Error(openaiLiveErrorMessage(event));
    this.failSession(err);
  }

  private isWaitingForCalleeSpeech(): boolean {
    return this.call.waitForCallee === true && !this.greetingSent;
  }

  private onAudioDelta(event: JsonObject): void {
    const delta =
      typeof event.delta === "string" ? event.delta : typeof event.audio === "string" ? event.audio : undefined;
    if (typeof delta !== "string" || delta.length === 0) return;
    const greeting = !this.greetingSent || this.greetingPlaying;
    if (greeting && !this.greetingSent) {
      this.greetingChunks.push(delta);
      this.flushGreetingIfReady();
      return;
    }
    if (this.isWaitingForCalleeSpeech()) {
      this.greetingChunks.push(delta);
      return;
    }
    if (!this.greetingSent) return;
    if (!this.telnyxAttached) {
      this.greetingChunks.push(delta);
      this.flushGreetingIfReady();
      return;
    }
    this.noteTurnAudio(delta);
    this.sendTelnyx({ event: "media", media: { payload: delta } });
  }

  private flushGreetingIfReady(): void {
    if (!this.telnyxAttached || !this.greetingSent) return;
    if (this.greetingChunks.length === 0) return;
    const generation = this.greetingGeneration;
    for (const chunk of this.greetingChunks) {
      if (generation !== this.greetingGeneration) return;
      this.noteTurnAudio(chunk);
      this.sendTelnyx({ event: "media", media: { payload: chunk } });
    }
    this.greetingChunks = [];
  }

  private onInputTranscript(event: JsonObject): void {
    const delta = transcriptDelta(event);
    if (delta) this.pendingInputTranscript += delta;
    const transcript = this.pendingInputTranscript.trim();
    if (this.isWaitingForCalleeSpeech()) {
      const decision = onTranscript(true, transcript);
      this.logCalleeGate(decision, "transcript", transcript);
      if (!decision.unlock) return;
      this.storePendingUser("live-input", transcript);
      this.pendingInputTranscript = "";
      this.speakGreeting();
      return;
    }
    if (this.greetingPlaying) {
      this.greetingPlaying = false;
      if (this.telnyxAttached) this.sendTelnyx({ event: "clear" });
    } else if (this.greetingSent && this.telnyxAttached) {
      this.sendTelnyx({ event: "clear" });
    }
    this.flushAssistantTranscript();
    if (transcript) this.storePendingUser("live-input", transcript);
    if (String(event.type ?? "").endsWith(".done")) {
      this.flushUserTranscript();
      this.pendingInputTranscript = "";
    }
  }

  private onOutputTranscript(event: JsonObject): void {
    if (this.isWaitingForCalleeSpeech()) return;
    if (!this.greetingSent) return;
    const delta = transcriptDelta(event);
    if (this.greetingPlaying) return;
    if (delta) this.pendingOutputTranscript += delta;
    if (String(event.type ?? "").endsWith(".done")) this.flushAssistantTranscript();
  }

  private async onDelegatedResponseEvent(inner: JsonObject): Promise<void> {
    const innerType = String(inner.type ?? "");
    if (innerType !== "response.output_item.done" && innerType !== "response.function_call_arguments.done") {
      return;
    }
    const item = inner.item && typeof inner.item === "object" ? (inner.item as JsonObject) : undefined;
    if (item && item.type === "function_call" && item.status && item.status !== "completed") return;
    await handleRealtimeToolCall({
      event: inner,
      alreadyHandled: this.handledToolCalls,
      telnyx: this.telnyx,
      callControlId: this.call.telnyx.callControlId,
      callId: this.call.id,
      sendOutput: (toolCallId, output) => {
        this.sendLive({
          type: "response.item.create",
          item: {
            type: "function_call_output",
            call_id: toolCallId,
            output,
          },
        });
      },
      onEndCall: () => this.requestHangup("end_call"),
      onDtmfContinue: () => {
        this.sendLive({ type: "response.create" });
      },
      clearPlayback: () => {
        this.sendTelnyx({ event: "clear" });
      },
    });
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
    const waitMs = Math.min(this.hangupMaxWaitMs, this.estimateRemainingPlayoutMs() + this.hangupDelayMs);
    if (waitMs > 0) await delay(waitMs);
  }

  private maybeUnlockAfterGrace(event: string): void {
    if (!this.isWaitingForCalleeSpeech()) return;
    const atMs = this.clockMs();
    const elapsed = msSinceStreamStart(this.calleeGate, atMs);
    if (elapsed === undefined || elapsed < this.calleeSpeechConfig.graceMs) return;
    if (hasPendingPostGraceUnlock(this.calleeGate)) {
      const decision = onPostGraceCheck(this.calleeGate, true, atMs, this.calleeSpeechConfig);
      this.logCalleeGate(decision, event);
      if (decision.unlock) this.speakGreeting();
      return;
    }
    if (
      this.calleeGate.lastSpeechStartedAtMs === undefined &&
      this.calleeGate.acceptedSpeechStartedAtMs === undefined
    ) {
      return;
    }
    const decision = onOngoingSpeechCheck(this.calleeGate, true, atMs, this.calleeSpeechConfig);
    if (!decision.unlock) return;
    this.logCalleeGate(decision, event);
    this.speakGreeting();
  }

  private maybeLogWaitForCalleeStall(): void {
    if (!this.isWaitingForCalleeSpeech() || this.waitForCalleeStallLogged) return;
    if (this.inboundMediaFrames === 0) return;
    const elapsed = msSinceStreamStart(this.calleeGate, this.clockMs());
    if (elapsed === undefined || elapsed < DEFAULT_WAIT_FOR_CALLEE_STALL_MS) return;
    this.waitForCalleeStallLogged = true;
    console.error(
      `[gpt-live-bridge ${this.call.id}] waitForCallee stall: inbound media flowing but greeting never unlocked after ${elapsed}ms (frames=${this.inboundMediaFrames}); agent stayed muted; not inventing speech`,
    );
  }

  private logWaitForCalleeNeverUnlocked(phase: string): void {
    if (!this.isWaitingForCalleeSpeech() || this.waitForCalleeNeverUnlockedLogged) return;
    this.waitForCalleeNeverUnlockedLogged = true;
    const elapsed = msSinceStreamStart(this.calleeGate, this.clockMs());
    const elapsedLabel =
      elapsed === undefined ? "stream not started" : `${elapsed}ms since stream start`;
    console.error(
      `[gpt-live-bridge ${this.call.id}] waitForCallee never unlocked (${phase}): ${elapsedLabel}, inbound_media_frames=${this.inboundMediaFrames}, greetingSent=false; not inventing speech`,
    );
  }

  private storePendingUser(itemId: string, transcript: string): void {
    if (!transcript) return;
    this.pendingUser.set(itemId || "anon", transcript);
  }

  private logCalleeGate(decision: CalleeSpeechDecision, event: string, transcript?: string): void {
    if (decision.reason === "not_waiting") return;
    const elapsed = msSinceStreamStart(this.calleeGate, this.clockMs());
    const elapsedLabel = elapsed === undefined ? "stream not started" : `${elapsed}ms since stream start`;
    const textLabel = transcript !== undefined ? ` text=${JSON.stringify(transcript.slice(0, 80))}` : "";
    if (decision.unlock) {
      console.info(
        `[gpt-live-bridge ${this.call.id}] waitForCallee: unlock via ${decision.reason} (${event}) — ${elapsedLabel}${textLabel}`,
      );
      return;
    }
    console.info(
      `[gpt-live-bridge ${this.call.id}] waitForCallee: greeting blocked (${decision.reason}) on ${event} — ${elapsedLabel}${textLabel}`,
    );
  }

  private flushUserTranscript(): void {
    for (const text of this.pendingUser.values()) {
      if (text) this.pushTranscript({ role: "user", text });
    }
    this.pendingUser.clear();
    const leftover = this.pendingInputTranscript.trim();
    if (leftover) this.pushTranscript({ role: "user", text: leftover });
    this.pendingInputTranscript = "";
  }

  private flushAssistantTranscript(): void {
    const text = this.pendingOutputTranscript.trim();
    this.pendingOutputTranscript = "";
    if (!text) return;
    if (text === this.call.greeting) return;
    this.pushTranscript({ role: "assistant", text });
  }

  private pushTranscript(line: TranscriptLine): void {
    const last = this.call.transcript[this.call.transcript.length - 1];
    if (last && last.role === line.role && last.text === line.text) return;
    this.call.transcript.push(line);
  }
}

function transcriptDelta(event: JsonObject): string {
  if (typeof event.delta === "string" && event.delta) return event.delta;
  if (typeof event.transcript === "string" && event.transcript.trim()) return event.transcript.trim();
  if (typeof event.text === "string" && event.text.trim()) return event.text.trim();
  return "";
}

function openaiLiveErrorMessage(event: JsonObject): string {
  const error = event.error;
  if (error && typeof error === "object") {
    const rec = error as JsonObject;
    if (typeof rec.message === "string" && rec.message.trim()) return rec.message;
    if (typeof rec.code === "string" && rec.code.trim()) return rec.code;
  }
  if (typeof event.message === "string" && event.message.trim()) return event.message;
  return "gpt_live_session_error";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
