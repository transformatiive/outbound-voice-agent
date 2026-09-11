import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import type { JsonObject } from "../../src/bridge/media-bridge.js";

export class FakeGptLiveWebSocket extends EventEmitter {
  readonly sent: JsonObject[] = [];
  readyState: number = WebSocket.CONNECTING;
  autoSession = true;
  autoGreetingAudio = true;
  greetingDelta = "UlRQQQ==";

  send(data: string): void {
    const event = JSON.parse(data) as JsonObject;
    this.sent.push(event);
    if (this.autoGreetingAudio && event.type === "session.instructions.append") {
      queueMicrotask(() => {
        this.emit("message", JSON.stringify({ type: "session.output_audio.delta", delta: this.greetingDelta }));
      });
    }
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }

  openNow(): void {
    this.readyState = WebSocket.OPEN;
    this.emit("open");
    if (this.autoSession) {
      queueMicrotask(() => {
        this.emit("message", JSON.stringify({ type: "session.started", session: { id: "live-sess-1" } }));
      });
    }
  }
}

export function connectFakeGptLive(): FakeGptLiveWebSocket {
  const ws = new FakeGptLiveWebSocket();
  queueMicrotask(() => ws.openNow());
  return ws;
}
