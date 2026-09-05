import { WebSocket, WebSocketServer } from "ws";
import type { IncomingMessage } from "node:http";
import type { Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import type { AppConfig } from "../config.js";
import type { CallStore } from "../calls/store.js";
import type { TelnyxClient } from "../telnyx/client.js";
import type { ElevenLabsTts } from "../elevenlabs.js";
import type { GreetingAudioCache } from "./greeting-audio-cache.js";
import { CallRuntime, type CallRuntimeRegistry, type ConnectGrokFn } from "./call-runtime.js";
import type { CallRecord } from "../calls/types.js";
import type { OpenAISessionStore } from "../openai/sessions.js";
import type { JsonObject } from "./media-bridge.js";

export type MediaStreamDeps = {
  config: AppConfig;
  store: CallStore;
  telnyx: TelnyxClient;
  onCallEnded: (call: CallRecord) => void;
  connectGrok: ConnectGrokFn;
  runtimes: CallRuntimeRegistry;
  greetingAudioCache: GreetingAudioCache;
  elevenLabsTts?: ElevenLabsTts;
  openaiSessions?: OpenAISessionStore;
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
      handleMediaConnection(ws, url, deps);
    });
  });
  return wss;
}

function handleMediaConnection(telnyxWs: WebSocket, url: URL, deps: MediaStreamDeps): void {
  const callId = url.searchParams.get("callId") ?? "";
  const token = url.searchParams.get("token") ?? "";
  const call = deps.store.get(callId);
  if (!call || token !== call.streamToken) {
    telnyxWs.close(1008, "unauthorized");
    return;
  }

  if (call.ttsProvider === "openai") {
    handleOpenAIMediaConnection(telnyxWs, call, deps);
    return;
  }

  if (call.ttsProvider === "elevenlabs" && !deps.config.elevenlabs.configured) {
    console.error(
      `[media ${call.id}] tts_provider=elevenlabs but ELEVENLABS_API_KEY missing; not falling back to Grok ara`,
    );
  }

  const runtime = deps.runtimes.start(call.id, () =>
    new CallRuntime({
      call,
      config: deps.config,
      telnyx: deps.telnyx,
      connectGrok: deps.connectGrok,
      onEnded: (ended) => {
        deps.runtimes.drop(ended.id);
        deps.onCallEnded(ended);
      },
      greetingAudioCache: deps.greetingAudioCache,
      onClosed: () => deps.runtimes.drop(call.id),
      ...(deps.elevenLabsTts ? { elevenLabsTts: deps.elevenLabsTts } : {}),
    }),
  );
  runtime.attachTelnyx(telnyxWs, deps.config.maxCallSeconds);
}

function handleOpenAIMediaConnection(
  telnyxWs: WebSocket,
  call: CallRecord,
  deps: MediaStreamDeps,
): void {
  const session = deps.openaiSessions?.take(call.id);
  if (!session) {
    console.error(
      `[media ${call.id}] tts_provider=openai but Realtime session is missing; not falling back to Grok ara`,
    );
    telnyxWs.close(1011, "openai_session_missing");
    if (call.telnyx.callControlId) {
      void deps.telnyx.hangup(call.telnyx.callControlId).catch((err) => {
        console.error(`[media ${call.id}] hangup after missing openai session`, err);
      });
    }
    call.status = "failed";
    call.endedReason = call.endedReason ?? "openai_session_missing";
    call.endedAt = call.endedAt ?? new Date().toISOString();
    deps.onCallEnded(call);
    return;
  }

  session.bridge.setOnEnded(deps.onCallEnded);
  const sendTelnyx = (event: JsonObject) => {
    if (telnyxWs.readyState === WebSocket.OPEN) telnyxWs.send(JSON.stringify(event));
  };
  session.bridge.attachTelnyx(sendTelnyx);

  const maxMs = deps.config.maxCallSeconds * 1000;
  const timer = setTimeout(() => {
    void session.bridge.requestHangup("timeout");
  }, maxMs);

  const closeBoth = () => {
    clearTimeout(timer);
    try {
      telnyxWs.close();
    } catch {
      /* already closed */
    }
    session.close();
  };

  telnyxWs.on("message", (data) => {
    const raw = typeof data === "string" ? data : data.toString();
    try {
      const event = JSON.parse(raw) as JsonObject;
      session.bridge.onTelnyxMessage(event);
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
