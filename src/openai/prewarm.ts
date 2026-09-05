import { WebSocket } from "ws";
import type { CallRecord } from "../calls/types.js";
import type { AppConfig } from "../config.js";
import type { TelnyxClient } from "../telnyx/client.js";
import type { JsonObject } from "../bridge/media-bridge.js";
import { openaiRealtimeUrl } from "./session.js";
import { OpenAIMediaBridge } from "./realtime-bridge.js";
import type { OpenAICallSession } from "./sessions.js";

export type ConnectOpenAI = (url: string, apiKey: string) => WebSocket;

export function defaultConnectOpenAI(url: string, apiKey: string): WebSocket {
  return new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } });
}

export type PrewarmOpenAIOptions = {
  call: CallRecord;
  config: AppConfig;
  telnyx: TelnyxClient;
  connectOpenAI?: ConnectOpenAI;
  onEnded?: (call: CallRecord) => void;
};

export class OpenAISessionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "OpenAISessionError";
    this.code = code;
  }
}

/**
 * Open the Realtime WebSocket and apply session.update before Telnyx answers.
 * Greeting audio is requested immediately (generate early); Telnyx stays muted
 * until the bridge unlocks (speak late).
 */
export async function prewarmOpenAISession(opts: PrewarmOpenAIOptions): Promise<OpenAICallSession> {
  const openai = opts.config.openai;
  if (!openai.configured || !openai.apiKey) {
    throw new OpenAISessionError("openai_not_configured", "OPENAI_API_KEY is required for tts_provider=openai");
  }

  const url = openaiRealtimeUrl(openai.baseUrl, openai.model);
  const connect = opts.connectOpenAI ?? defaultConnectOpenAI;
  let ws: WebSocket;
  try {
    ws = connect(url, openai.apiKey);
  } catch (err) {
    throw new OpenAISessionError(
      "openai_session_failed",
      err instanceof Error ? err.message : "failed to open OpenAI Realtime WebSocket",
    );
  }

  const sendOpenAI = (event: JsonObject) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
  };

  const bridge = new OpenAIMediaBridge({
    call: opts.call,
    sendOpenAI,
    sendTelnyx: () => undefined,
    telnyx: opts.telnyx,
    voice: opts.call.voice,
    model: opts.call.model,
    turnDetection: opts.config.turnDetection,
    calleeSpeechGraceMs: opts.config.calleeSpeechGraceMs,
    calleeMinSpeechMs: opts.config.calleeMinSpeechMs,
    hangupDelayMs: opts.config.hangupPlayoutBufferMs,
    ...(opts.onEnded ? { onEnded: opts.onEnded } : {}),
    ...(opts.call.extraInstructions !== undefined ? { extraInstructions: opts.call.extraInstructions } : {}),
  });

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  };

  ws.on("open", () => {
    bridge.configureSession();
  });
  if (ws.readyState === WebSocket.OPEN) {
    bridge.configureSession();
  }

  ws.on("message", (data) => {
    const raw = typeof data === "string" ? data : data.toString();
    try {
      const event = JSON.parse(raw) as JsonObject;
      void bridge.onOpenAIEvent(event);
    } catch {
      /* ignore non-JSON */
    }
  });
  ws.on("error", (err) => {
    console.error(`[openai ${opts.call.id}] ws`, err);
    bridge.failSession(err instanceof Error ? err : new Error(String(err)));
  });
  ws.on("close", () => {
    if (!closed) {
      bridge.failSession(new Error("openai_ws_closed"));
    }
  });

  try {
    await bridge.waitUntilReady(openai.prewarmTimeoutMs);
  } catch (err) {
    close();
    const message = err instanceof Error ? err.message : String(err);
    const code = message === "openai_session_timeout" ? "openai_session_failed" : "openai_session_failed";
    throw new OpenAISessionError(code, message);
  }

  return { ws, bridge, close };
}
