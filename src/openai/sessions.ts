import type { OpenAIMediaBridge } from "./realtime-bridge.js";
import type { WebSocket } from "ws";

export type OpenAICallSession = {
  ws: WebSocket;
  bridge: OpenAIMediaBridge;
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
