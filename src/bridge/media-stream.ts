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

export type MediaStreamDeps = {
  config: AppConfig;
  store: CallStore;
  telnyx: TelnyxClient;
  onCallEnded: (call: CallRecord) => void;
  connectGrok: ConnectGrokFn;
  runtimes: CallRuntimeRegistry;
  greetingAudioCache: GreetingAudioCache;
  elevenLabsTts?: ElevenLabsTts;
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
