import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import request from "supertest";
import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import type { TelnyxClient } from "../src/telnyx/client.js";
import type { JsonObject } from "../src/bridge/media-bridge.js";

const config: AppConfig = {
  port: 0,
  apiKey: "test-api-key",
  telnyxApiKey: "telnyx-key",
  telnyxConnectionId: "3041732714274227469",
  telnyxOutboundVoiceProfileId: "3041732644774610184",
  telnyxApiBase: "https://api.telnyx.com",
  telnyxPublicKey: undefined,
  fromNumber: "+351210210260",
  xaiApiKey: "xai-key",
  xaiBaseUrl: "https://api.x.ai",
  grokVoice: "ara",
  grokModel: "grok-voice-think-fast-2.0",
  publicBaseUrl: "https://example.up.railway.app",
  resultWebhook: undefined,
  maxCallSeconds: 600,
  webhookUrl: "https://example.up.railway.app/webhooks/telnyx",
  mediaStreamUrl: (callId, token) =>
    `wss://example.up.railway.app/media-stream?callId=${callId}&token=${token}`,
  ready: { api: true, telnyx: true, xai: true, outbound: true },
};

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

async function waitFor(
  queue: JsonObject[],
  predicate: (msg: JsonObject) => boolean,
  timeoutMs = 3000,
): Promise<JsonObject> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = queue.find(predicate);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`timeout waiting for websocket message: ${JSON.stringify(queue)}`);
}

describe("media stream websocket", () => {
  it("bridges Telnyx media to a fake Grok socket and speaks the greeting", async () => {
    const grokWss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const grokPort = await new Promise<number>((resolve) => {
      grokWss.once("listening", () => resolve((grokWss.address() as AddressInfo).port));
    });

    const grokFromApp: JsonObject[] = [];
    const grokConnection = new Promise<WebSocket>((resolve) => {
      grokWss.once("connection", (ws) => {
        ws.on("message", (data) => {
          grokFromApp.push(JSON.parse(String(data)) as JsonObject);
        });
        resolve(ws);
      });
    });

    const telnyx: TelnyxClient = {
      dial: vi.fn(async () => ({
        call_control_id: "v2:control-id",
        call_leg_id: "leg-id",
        call_session_id: "session-id",
        is_alive: false,
        record_type: "call",
      })),
      hangup: vi.fn(async () => undefined),
    };

    const { app, store, attach } = createApp({
      config,
      telnyx,
      connectGrok: () => new WebSocket(`ws://127.0.0.1:${grokPort}`),
    });
    const httpServer = createServer(app);
    attach(httpServer);
    const port = await listen(httpServer);

    try {
      const created = await request(app)
        .post("/api/outbound")
        .set("Authorization", "Bearer test-api-key")
        .send({
          to: "+351912345678",
          language: "pt-PT",
          greeting: "Olá, fala a Ara.",
          objective: "Confirmar quinta",
        });
      const call = store.get(created.body.id as string);
      if (!call) throw new Error("call missing");

      const telnyxFromGrok: JsonObject[] = [];
      const telnyxWs = new WebSocket(
        `ws://127.0.0.1:${port}/media-stream?callId=${call.id}&token=${call.streamToken}`,
      );
      telnyxWs.on("message", (data) => {
        telnyxFromGrok.push(JSON.parse(String(data)) as JsonObject);
      });
      await new Promise<void>((resolve, reject) => {
        telnyxWs.once("open", () => resolve());
        telnyxWs.once("error", reject);
      });

      const grokWs = await grokConnection;
      const sessionUpdate = await waitFor(grokFromApp, (m) => m.type === "session.update");
      expect((sessionUpdate.session as JsonObject).voice).toBe("ara");

      grokWs.send(JSON.stringify({ type: "session.updated" }));
      const greeting = await waitFor(grokFromApp, (m) => m.type === "conversation.item.create");
      expect((greeting.item as JsonObject).type).toBe("force_message");

      telnyxWs.send(
        JSON.stringify({
          event: "media",
          media: { track: "inbound", payload: "QUJDRA==" },
        }),
      );
      const appended = await waitFor(
        grokFromApp,
        (m) => m.type === "input_audio_buffer.append",
      );
      expect(appended).toEqual({ type: "input_audio_buffer.append", audio: "QUJDRA==" });

      grokWs.send(JSON.stringify({ type: "response.output_audio.delta", delta: "UlRQQQ==" }));
      const media = await waitFor(telnyxFromGrok, (m) => m.event === "media");
      expect(media).toEqual({ event: "media", media: { payload: "UlRQQQ==" } });

      telnyxWs.close();
      grokWs.close();
    } finally {
      httpServer.close();
      grokWss.close();
    }
  });

  it("waits for callee speech before speaking the greeting when waitForCallee is true", async () => {
    const grokWss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const grokPort = await new Promise<number>((resolve) => {
      grokWss.once("listening", () => resolve((grokWss.address() as AddressInfo).port));
    });

    const grokFromApp: JsonObject[] = [];
    const grokConnection = new Promise<WebSocket>((resolve) => {
      grokWss.once("connection", (ws) => {
        ws.on("message", (data) => {
          grokFromApp.push(JSON.parse(String(data)) as JsonObject);
        });
        resolve(ws);
      });
    });

    const telnyx: TelnyxClient = {
      dial: vi.fn(async () => ({
        call_control_id: "v2:control-id",
        call_leg_id: "leg-id",
        call_session_id: "session-id",
        is_alive: false,
        record_type: "call",
      })),
      hangup: vi.fn(async () => undefined),
    };

    const { app, store, attach } = createApp({
      config,
      telnyx,
      connectGrok: () => new WebSocket(`ws://127.0.0.1:${grokPort}`),
    });
    const httpServer = createServer(app);
    attach(httpServer);
    const port = await listen(httpServer);

    try {
      const created = await request(app)
        .post("/api/outbound")
        .set("Authorization", "Bearer test-api-key")
        .send({
          to: "+351912345678",
          language: "pt-PT",
          greeting: "Olá, fala a secretária da Ara.",
          objective: "Confirmar quinta",
          waitForCallee: true,
        });
      const call = store.get(created.body.id as string);
      if (!call) throw new Error("call missing");
      expect(call.waitForCallee).toBe(true);

      const telnyxWs = new WebSocket(
        `ws://127.0.0.1:${port}/media-stream?callId=${call.id}&token=${call.streamToken}`,
      );
      await new Promise<void>((resolve, reject) => {
        telnyxWs.once("open", () => resolve());
        telnyxWs.once("error", reject);
      });

      const grokWs = await grokConnection;
      const sessionUpdate = await waitFor(grokFromApp, (m) => m.type === "session.update");
      expect(String((sessionUpdate.session as JsonObject).instructions)).toMatch(
        /Espera em silêncio até o destinatário falar/i,
      );

      grokWs.send(JSON.stringify({ type: "session.updated" }));
      await new Promise((r) => setTimeout(r, 80));
      expect(grokFromApp.some((m) => m.type === "conversation.item.create")).toBe(false);

      grokWs.send(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
      const greeting = await waitFor(grokFromApp, (m) => m.type === "conversation.item.create");
      expect((greeting.item as JsonObject).type).toBe("force_message");
      expect(((greeting.item as JsonObject).content as JsonObject[])[0]).toMatchObject({
        type: "output_text",
        text: "Olá, fala a secretária da Ara.",
      });

      telnyxWs.close();
      grokWs.close();
    } finally {
      httpServer.close();
      grokWss.close();
    }
  });
});
