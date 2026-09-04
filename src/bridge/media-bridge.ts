import type { CallRecord, TranscriptLine } from "../calls/types.js";
import {
  DEFAULT_TURN_DETECTION,
  sessionUpdatePayload,
  type TurnDetectionSettings,
} from "../grok/session.js";
import type { TelnyxClient } from "../telnyx/client.js";
import {
  DEFAULT_CALLEE_MIN_SPEECH_MS,
  DEFAULT_CALLEE_SPEECH_GRACE_MS,
  createCalleeSpeechGate,
  noteStreamStart,
  onSpeechStarted,
  onSpeechStopped,
  onTranscript,
  type CalleeSpeechDecision,
  type CalleeSpeechGate,
  type CalleeSpeechGateConfig,
} from "./callee-speech.js";

export type JsonObject = Record<string, unknown>;

export type MediaBridgeOptions = {
  call: CallRecord;
  sendGrok: (event: JsonObject) => void;
  sendTelnyx: (event: JsonObject) => void;
  telnyx: TelnyxClient;
  hangupDelayMs?: number;
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

export class MediaBridge {
  readonly call: CallRecord;
  private readonly sendGrok: (event: JsonObject) => void;
  private readonly sendTelnyx: (event: JsonObject) => void;
  private readonly telnyx: TelnyxClient;
  private readonly hangupDelayMs: number;
  private readonly voice: string;
  private readonly extraInstructions: string | undefined;
  private readonly turnDetection: TurnDetectionSettings;
  private readonly calleeSpeechConfig: CalleeSpeechGateConfig;
  private readonly calleeGate: CalleeSpeechGate;
  private readonly onEnded: ((call: CallRecord) => void) | undefined;
  private readonly now: () => string;
  private readonly clockMs: () => number;
  private greetingSent = false;
  private hangingUp = false;
  private grokResponsePending = false;
  private readonly pendingUser = new Map<string, string>();
  private grokConfigured = false;

  constructor(opts: MediaBridgeOptions) {
    this.call = opts.call;
    this.sendGrok = opts.sendGrok;
    this.sendTelnyx = opts.sendTelnyx;
    this.telnyx = opts.telnyx;
    this.hangupDelayMs = opts.hangupDelayMs ?? 1200;
    this.voice = opts.voice ?? opts.call.voice;
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

  configureGrokSession(): void {
    const waitForCallee = this.isWaitingForCalleeSpeech();
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
        turnDetection: this.turnDetection,
      }) as unknown as JsonObject,
    );
    this.grokConfigured = true;
  }

  speakGreeting(): void {
    if (this.greetingSent) return;
    const wasWaiting = this.call.waitForCallee === true;
    if (wasWaiting) this.cancelPendingGrokResponse();
    this.greetingSent = true;
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
    // Re-enable server_vad auto-response only after the scripted greeting is queued.
    if (wasWaiting) this.configureGrokSession();
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
        this.grokResponsePending = true;
        if (this.isWaitingForCalleeSpeech()) this.cancelPendingGrokResponse();
        return;
      case "response.done":
        this.grokResponsePending = false;
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
        const waiting = this.isWaitingForCalleeSpeech();
        const decision = onSpeechStarted(this.calleeGate, waiting, this.clockMs(), this.calleeSpeechConfig);
        if (waiting) {
          this.logCalleeGate(decision, "speech_started");
          return;
        }
        this.sendTelnyx({ event: "clear" });
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
      case "conversation.item.input_audio_transcription.updated": {
        const itemId = typeof event.item_id === "string" ? event.item_id : "";
        const raw = typeof event.transcript === "string" ? event.transcript : "";
        const transcript = raw.trim();
        if (this.isWaitingForCalleeSpeech()) {
          const decision = onTranscript(true, raw);
          this.logCalleeGate(decision, "transcript");
          if (!decision.unlock) return;
          if (itemId && transcript) this.pendingUser.set(itemId, transcript);
          this.speakGreeting();
          return;
        }
        if (itemId && transcript) this.pendingUser.set(itemId, transcript);
        return;
      }
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done": {
        if (this.isWaitingForCalleeSpeech()) return;
        this.flushUserTranscript();
        const transcript = typeof event.transcript === "string" ? event.transcript.trim() : "";
        if (transcript) this.pushTranscript({ role: "assistant", text: transcript });
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
    if (this.hangupDelayMs > 0) {
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

  private cancelPendingGrokResponse(force = false): void {
    if (!force && !this.grokResponsePending) return;
    this.sendGrok({ type: "response.cancel" });
    this.grokResponsePending = false;
  }

  private forwardGrokAudio(event: JsonObject): void {
    if (this.isWaitingForCalleeSpeech()) return;
    const delta =
      typeof event.delta === "string" ? event.delta : typeof event.audio === "string" ? event.audio : undefined;
    if (typeof delta === "string" && delta.length > 0) {
      this.sendTelnyx({ event: "media", media: { payload: delta } });
    }
  }

  private logCalleeGate(decision: CalleeSpeechDecision, event: string): void {
    if (decision.unlock) {
      console.info(`[bridge ${this.call.id}] waitForCallee: unlock via ${decision.reason} (${event})`);
      return;
    }
    if (decision.reason === "not_waiting") return;
    console.info(`[bridge ${this.call.id}] waitForCallee: greeting blocked (${decision.reason}) on ${event}`);
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

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
