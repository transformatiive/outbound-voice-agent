import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import type { AppConfig } from "../config.js";
import type { CallRecord } from "../calls/types.js";
import type { ElevenLabsTts } from "../elevenlabs.js";
import { grokRealtimeUrl } from "../grok/session.js";
import type { TelnyxClient } from "../telnyx/client.js";
import { DEFAULT_ELEVENLABS_VAD_SILENCE_MS } from "../tts.js";
import type { GreetingAudioCache } from "./greeting-audio-cache.js";
import { MediaBridge, type JsonObject } from "./media-bridge.js";

export type ConnectGrokFn = (url: string, apiKey: string) => WebSocket;

export function defaultConnectGrok(url: string, apiKey: string): WebSocket {
  return new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } });
}

/** Test double: never connects and never sends. */
export function inertConnectGrok(_url: string, _apiKey: string): WebSocket {
  const ws = new EventEmitter();
  Object.assign(ws, {
    readyState: WebSocket.CLOSED,
    send(): void {
      /* inert */
    },
    close(): void {
      /* inert */
    },
    terminate(): void {
      /* inert */
    },
  });
  return ws as unknown as WebSocket;
}

export function resolveConnectGrok(explicit?: ConnectGrokFn): ConnectGrokFn {
  if (explicit) return explicit;
  return process.env.VITEST ? inertConnectGrok : defaultConnectGrok;
}

export type CallRuntimeDeps = {
  call: CallRecord;
  config: AppConfig;
  telnyx: TelnyxClient;
  connectGrok: ConnectGrokFn;
  onEnded: (call: CallRecord) => void;
  greetingAudioCache: GreetingAudioCache;
  elevenLabsTts?: ElevenLabsTts;
  onClosed?: () => void;
};

export class CallRuntime {
  readonly bridge: MediaBridge;
  readonly grokWs: WebSocket;
  private telnyxWs: WebSocket | undefined;
  private closed = false;
  private hangupTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly onClosed: (() => void) | undefined;

  constructor(deps: CallRuntimeDeps) {
    const grokUrl = grokRealtimeUrl(deps.config.xaiBaseUrl, deps.config.grokModel);
    this.grokWs = deps.connectGrok(grokUrl, deps.config.xaiApiKey);

    const sendGrok = (event: JsonObject) => {
      if (this.grokWs.readyState === WebSocket.OPEN) this.grokWs.send(JSON.stringify(event));
    };
    const sendTelnyx = (event: JsonObject) => {
      if (this.telnyxWs?.readyState === WebSocket.OPEN) {
        this.telnyxWs.send(JSON.stringify(event));
      }
    };

    const elevenLabsRequested = deps.call.ttsProvider === "elevenlabs";
    const turnDetection = elevenLabsRequested
      ? {
          ...deps.config.turnDetection,
          silenceDurationMs: deps.config.elevenlabsVadSilenceMs || DEFAULT_ELEVENLABS_VAD_SILENCE_MS,
        }
      : deps.config.turnDetection;

    this.bridge = new MediaBridge({
      call: deps.call,
      sendGrok,
      sendTelnyx,
      telnyx: deps.telnyx,
      voice: deps.config.grokVoice,
      turnDetection,
      outputSpeed: deps.config.grokVoiceSpeed,
      calleeSpeechGraceMs: deps.config.calleeSpeechGraceMs,
      calleeMinSpeechMs: deps.config.calleeMinSpeechMs,
      hangupDelayMs: deps.config.hangupPlayoutBufferMs,
      onEnded: deps.onEnded,
      outputReady: false,
      greetingAudioCache: deps.greetingAudioCache,
      ...(deps.elevenLabsTts ? { elevenLabsTts: deps.elevenLabsTts } : {}),
    });
    this.onClosed = deps.onClosed;

    this.grokWs.on("open", () => {
      const provider = elevenLabsRequested ? "elevenlabs" : "grok";
      console.info(
        `[bridge ${deps.call.id}] turn_latency provider=${provider} stage=prefetch_start turn=greeting source=dial`,
      );
      this.bridge.configureGrokSession();
    });
    this.grokWs.on("message", (data) => {
      const raw = typeof data === "string" ? data : data.toString();
      try {
        const event = JSON.parse(raw) as JsonObject;
        void this.bridge.onGrokEvent(event);
      } catch {
        /* ignore non-JSON */
      }
    });
    this.grokWs.on("error", (err) => {
      console.error(`[media ${deps.call.id}] grok ws`, err);
    });
  }

  attachTelnyx(ws: WebSocket, maxCallSeconds: number): void {
    if (this.telnyxWs && this.telnyxWs !== ws) {
      try {
        this.telnyxWs.close();
      } catch {
        /* already closed */
      }
    }
    this.telnyxWs = ws;
    if (this.hangupTimer) clearTimeout(this.hangupTimer);
    this.hangupTimer = setTimeout(() => {
      void this.bridge.requestHangup("timeout");
    }, maxCallSeconds * 1000);
    this.bridge.markOutputReady();

    ws.on("message", (data) => {
      const raw = typeof data === "string" ? data : data.toString();
      try {
        const event = JSON.parse(raw) as JsonObject;
        this.bridge.onTelnyxMessage(event);
      } catch {
        /* ignore */
      }
    });
    ws.on("close", () => {
      if (this.telnyxWs === ws) this.close();
    });
    ws.on("error", (err) => {
      console.error(`[media ${this.bridge.call.id}] telnyx ws`, err);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.hangupTimer) clearTimeout(this.hangupTimer);
    try {
      this.telnyxWs?.close();
    } catch {
      /* already closed */
    }
    try {
      this.grokWs.close();
    } catch {
      /* already closed */
    }
    this.onClosed?.();
  }
}

export class CallRuntimeRegistry {
  private readonly runtimes = new Map<string, CallRuntime>();

  start(callId: string, create: () => CallRuntime): CallRuntime {
    const existing = this.runtimes.get(callId);
    if (existing) return existing;
    const runtime = create();
    this.runtimes.set(callId, runtime);
    return runtime;
  }

  get(callId: string): CallRuntime | undefined {
    return this.runtimes.get(callId);
  }

  drop(callId: string): void {
    const runtime = this.runtimes.get(callId);
    if (!runtime) return;
    this.runtimes.delete(callId);
    runtime.close();
  }
}
