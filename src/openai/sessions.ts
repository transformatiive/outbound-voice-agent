import type { WebSocket } from "ws";
import type { CallRecord } from "../calls/types.js";
import type { JsonObject } from "../bridge/media-bridge.js";

export type OpenAIFamilyBridge = {
  attachTelnyx(sendTelnyx: (event: JsonObject) => void): void;
  setOnEnded(onEnded: (call: CallRecord) => void): void;
  onTelnyxMessage(message: JsonObject): void;
  waitUntilReady(timeoutMs: number): Promise<void>;
  failSession(err: Error): void;
  flushTranscript(): void;
  requestHangup(reason: string): Promise<void>;
};

export type OpenAICallSession = {
  ws: WebSocket;
  bridge: OpenAIFamilyBridge;
  close: () => void;
};

export class OpenAISessionStore {
  private readonly byCallId = new Map<string, OpenAICallSession>();
  private readonly live = new Map<string, OpenAICallSession>();

  set(callId: string, session: OpenAICallSession): void {
    this.byCallId.set(callId, session);
    this.live.set(callId, session);
  }

  get(callId: string): OpenAICallSession | undefined {
    return this.byCallId.get(callId) ?? this.live.get(callId);
  }

  take(callId: string): OpenAICallSession | undefined {
    const session = this.byCallId.get(callId);
    if (session) this.byCallId.delete(callId);
    return session ?? this.live.get(callId);
  }

  close(callId: string): void {
    const session = this.byCallId.get(callId) ?? this.live.get(callId);
    this.byCallId.delete(callId);
    this.live.delete(callId);
    session?.close();
  }
}
