import { WebSocket, WebSocketServer } from "ws";
import type { IncomingMessage } from "node:http";
import type { Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import type { AppConfig } from "../config.js";
import type { CallStore } from "../calls/store.js";
import type { TelnyxClient } from "../telnyx/client.js";
import { grokRealtimeUrl } from "../grok/session.js";
import { MediaBridge, type JsonObject } from "./media-bridge.js";
import { createElevenLabsTts } from "../elevenlabs.js";
import type { GreetingAudioCache } from "./greeting-audio-cache.js";
import { DEFAULT_ELEVENLABS_VAD_SILENCE_MS } from "../tts.js";
import type { CallRecord } from "../calls/types.js";

export type MediaStreamDeps = {
  config: AppConfig;
  store: CallStore;
  telnyx: TelnyxClient;
  onCallEnded: (call: CallRecord) => void;
  connectGrok?: (url: string, apiKey: string) => WebSocket;
  fetchImpl?: typeof fetch;
  greetingAudioCache?: GreetingAudioCache;
};

export function attachMediaStream(server: HttpServer, deps: MediaStreamDeps): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const host = req.headers.host ?? "localhost";
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (url.pathname !== "/media-stream") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      void handleMediaConnection(ws, url, deps);
    });
  });
  return wss;
}

async function handleMediaConnection(
  telnyxWs: WebSocket,
  url: URL,
  deps: MediaStreamDeps,
): Promise<void> {
  const callId = url.searchParams.get("callId") ?? "";
  const token = url.searchParams.get("token") ?? "";
  const call = deps.store.get(callId);
  if (!call || token !== call.streamToken) {
    telnyxWs.close(1008, "unauthorized");
    return;
  }

  const grokUrl = grokRealtimeUrl(deps.config.xaiBaseUrl, deps.config.grokModel);
  const grokWs = (deps.connectGrok ?? defaultConnectGrok)(grokUrl, deps.config.xaiApiKey);

  const sendGrok = (event: JsonObject) => {
    if (grokWs.readyState === WebSocket.OPEN) grokWs.send(JSON.stringify(event));
  };
  const sendTelnyx = (event: JsonObject) => {
    if (telnyxWs.readyState === WebSocket.OPEN) telnyxWs.send(JSON.stringify(event));
  };

  const elevenLabsRequested = call.ttsProvider === "elevenlabs";
  if (elevenLabsRequested && !deps.config.elevenlabs.configured) {
    console.error(
      `[media ${call.id}] tts_provider=elevenlabs but ELEVENLABS_API_KEY missing; not falling back to Grok ara`,
    );
  }
  const elevenLabsTts =
    elevenLabsRequested && deps.config.elevenlabs.configured
      ? createElevenLabsTts(deps.config.elevenlabs, deps.fetchImpl ?? fetch)
      : undefined;

  const turnDetection = elevenLabsRequested
    ? {
        ...deps.config.turnDetection,
        silenceDurationMs:
          deps.config.elevenlabsVadSilenceMs ?? DEFAULT_ELEVENLABS_VAD_SILENCE_MS,
      }
    : deps.config.turnDetection;

  const bridge = new MediaBridge({
    call,
    sendGrok,
    sendTelnyx,
    telnyx: deps.telnyx,
    voice: deps.config.grokVoice,
    turnDetection,
    outputSpeed: deps.config.grokVoiceSpeed,
    calleeSpeechGraceMs: deps.config.calleeSpeechGraceMs,
    calleeMinSpeechMs: deps.config.calleeMinSpeechMs,
    hangupDelayMs: deps.config.hangupPlayoutBufferMs,
    onEnded: deps.onCallEnded,
    ...(elevenLabsTts ? { elevenLabsTts } : {}),
    ...(deps.greetingAudioCache ? { greetingAudioCache: deps.greetingAudioCache } : {}),
  });

  const maxMs = deps.config.maxCallSeconds * 1000;
  const timer = setTimeout(() => {
    void bridge.requestHangup("timeout");
  }, maxMs);

  const closeBoth = () => {
    clearTimeout(timer);
    try {
      telnyxWs.close();
    } catch {
      /* already closed */
    }
    try {
      grokWs.close();
    } catch {
      /* already closed */
    }
  };

  grokWs.on("open", () => {
    bridge.configureGrokSession();
  });
  grokWs.on("message", (data) => {
    const raw = typeof data === "string" ? data : data.toString();
    try {
      const event = JSON.parse(raw) as JsonObject;
      void bridge.onGrokEvent(event);
    } catch {
      /* ignore non-JSON */
    }
  });
  grokWs.on("error", (err) => {
    console.error(`[media ${call.id}] grok ws`, err);
  });
  grokWs.on("close", () => {
    clearTimeout(timer);
  });

  telnyxWs.on("message", (data) => {
    const raw = typeof data === "string" ? data : data.toString();
    try {
      const event = JSON.parse(raw) as JsonObject;
      bridge.onTelnyxMessage(event);
    } catch {
      /* ignore */
    }
  });
  telnyxWs.on("close", () => {
    closeBoth();
  });
  telnyxWs.on("error", (err) => {
    console.error(`[media ${call.id}] telnyx ws`, err);
  });
}

function defaultConnectGrok(url: string, apiKey: string): WebSocket {
  return new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } });
}
