import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import type { JsonObject } from "../../src/bridge/media-bridge.js";

export class FakeOpenAIWebSocket extends EventEmitter {
  readonly sent: JsonObject[] = [];
  readyState: number = WebSocket.CONNECTING;
  autoSession = true;
  autoGreetingAudio = true;
  greetingDelta = "UlRQQQ==";

  send(data: string): void {
    const event = JSON.parse(data) as JsonObject;
    this.sent.push(event);
    if (this.autoSession && event.type === "session.update") {
      queueMicrotask(() => {
        this.emit("message", JSON.stringify({ type: "session.updated", session: event.session }));
      });
    }
    if (this.autoGreetingAudio && event.type === "response.create") {
      queueMicrotask(() => {
        const id = "greet-1";
        this.emit("message", JSON.stringify({ type: "response.created", response: { id, metadata: { purpose: "greeting" } } }));
        this.emit(
          "message",
          JSON.stringify({ type: "response.output_audio.delta", response_id: id, delta: this.greetingDelta }),
        );
        this.emit(
          "message",
          JSON.stringify({ type: "response.output_audio_transcript.done", response_id: id, transcript: "Olá" }),
        );
        this.emit("message", JSON.stringify({ type: "response.done", response: { id, metadata: { purpose: "greeting" } } }));
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
      this.emit("message", JSON.stringify({ type: "session.created" }));
    }
  }
}

export function connectFakeOpenAI(): FakeOpenAIWebSocket {
  const ws = new FakeOpenAIWebSocket();
  queueMicrotask(() => ws.openNow());
  return ws;
}
