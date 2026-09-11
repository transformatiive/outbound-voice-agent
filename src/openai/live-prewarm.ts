import { WebSocket } from "ws";
import type { CallRecord } from "../calls/types.js";
import type { AppConfig } from "../config.js";
import type { TelnyxClient } from "../telnyx/client.js";
import type { JsonObject } from "../bridge/media-bridge.js";
import { openaiLiveUrl } from "./live-session.js";
import { GptLiveMediaBridge } from "./live-bridge.js";
import type { OpenAICallSession } from "./sessions.js";
import { OpenAISessionError, type ConnectOpenAI } from "./prewarm.js";
import { GPT_LIVE_USER_AGENT } from "../tts.js";

export function defaultConnectGptLive(url: string, apiKey: string): WebSocket {
  return new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "User-Agent": GPT_LIVE_USER_AGENT,
    },
  });
}

export type PrewarmGptLiveOptions = {
  call: CallRecord;
  config: AppConfig;
  telnyx: TelnyxClient;
  connectOpenAI?: ConnectOpenAI;
  onEnded?: (call: CallRecord) => void;
};

/**
 * Open the GPT-Live WebSocket and send `session.start` before Telnyx answers.
 * Greeting audio is requested on `session.started` (generate early); Telnyx
 * stays muted until the bridge unlocks (speak late).
 */
export async function prewarmGptLiveSession(opts: PrewarmGptLiveOptions): Promise<OpenAICallSession> {
  const openai = opts.config.openai;
  if (!openai.configured || !openai.apiKey) {
    throw new OpenAISessionError("openai_not_configured", "OPENAI_API_KEY is required for tts_provider=gpt-live");
  }

  const url = openaiLiveUrl(openai.baseUrl);
  const connect = opts.connectOpenAI ?? defaultConnectGptLive;
  let ws: WebSocket;
  try {
    ws = connect(url, openai.apiKey);
  } catch (err) {
    throw new OpenAISessionError(
      "gpt_live_session_failed",
      err instanceof Error ? err.message : "failed to open GPT-Live WebSocket",
    );
  }

  const sendLive = (event: JsonObject) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
  };

  const bridge = new GptLiveMediaBridge({
    call: opts.call,
    sendLive,
    sendTelnyx: () => undefined,
    telnyx: opts.telnyx,
    voice: opts.call.voice,
    model: opts.call.model,
    delegateModel: openai.delegateModel,
    hangupDelayMs: opts.config.hangupPlayoutBufferMs,
    calleeSpeechGraceMs: opts.config.calleeSpeechGraceMs,
    calleeMinSpeechMs: opts.config.calleeMinSpeechMs,
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
      void bridge.onLiveEvent(event);
    } catch {
      /* ignore non-JSON */
    }
  });
  ws.on("error", (err) => {
    console.error(`[gpt-live ${opts.call.id}] ws`, err);
    bridge.failSession(err instanceof Error ? err : new Error(String(err)));
  });
  ws.on("close", () => {
    if (!closed) {
      bridge.failSession(new Error("gpt_live_ws_closed"));
    }
  });

  try {
    await bridge.waitUntilReady(openai.prewarmTimeoutMs);
  } catch (err) {
    close();
    const message = err instanceof Error ? err.message : String(err);
    throw new OpenAISessionError("gpt_live_session_failed", message);
  }

  return { ws, bridge, close };
}
