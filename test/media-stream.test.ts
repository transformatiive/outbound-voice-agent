import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import request from "supertest";
import { DEFAULT_TURN_DETECTION } from "../src/grok/session.js";
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
  grokVoiceSpeed: 1,
  elevenlabs: { apiKey: "", voiceId: "", model: "eleven_v3", configured: false },
  turnDetection: DEFAULT_TURN_DETECTION,
  calleeSpeechGraceMs: 1000,
  calleeMinSpeechMs: 250,
  hangupPlayoutBufferMs: 0,
  publicBaseUrl: "https://example.up.railway.app",
  resultWebhook: undefined,
  maxCallSeconds: 600,
  webhookUrl: "https://example.up.railway.app/webhooks/telnyx",
  mediaStreamUrl: (callId, token) =>
    `wss://example.up.railway.app/media-stream?callId=${callId}&token=${token}`,
  ready: { api: true, telnyx: true, xai: true, outbound: true, elevenlabs: false },
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
          greeting: "Olá, fala a secretária.",
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
      grokWs.send(JSON.stringify({ type: "response.created", response_id: "greeting" }));
      grokWs.send(JSON.stringify({ type: "response.done" }));

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
          greeting: "Olá, fala a secretária.",
          objective: "Confirmar quinta",
          waitForCallee: true,
        });
      const call = store.get(created.body.id as string);
      if (!call) throw new Error("call missing");
      expect(call.waitForCallee).toBe(true);

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
      expect(String((sessionUpdate.session as JsonObject).instructions)).toMatch(
        /Espera em silêncio até o destinatário falar/i,
      );
      expect((sessionUpdate.session as JsonObject).turn_detection).toMatchObject({
        create_response: false,
      });
      expect(
        ((sessionUpdate.session as JsonObject).turn_detection as JsonObject).idle_timeout_ms,
      ).toBeUndefined();

      grokWs.send(JSON.stringify({ type: "session.updated" }));
      grokWs.send(JSON.stringify({ type: "response.created", response_id: "auto-1" }));
      grokWs.send(JSON.stringify({ type: "response.output_audio.delta", delta: "UlRQQQ==" }));
      await new Promise((r) => setTimeout(r, 80));
      expect(grokFromApp.some((m) => m.type === "conversation.item.create")).toBe(false);
      expect(grokFromApp.some((m) => m.type === "response.create")).toBe(false);
      expect(grokFromApp.some((m) => m.type === "response.cancel")).toBe(true);
      expect(telnyxFromGrok.some((m) => m.event === "media")).toBe(false);

      grokWs.send(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
      await new Promise((r) => setTimeout(r, 50));
      expect(grokFromApp.some((m) => m.type === "conversation.item.create")).toBe(false);

      grokWs.send(
        JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed",
          item_id: "u1",
          transcript: "Estou",
        }),
      );
      const greeting = await waitFor(grokFromApp, (m) => m.type === "conversation.item.create");
      expect((greeting.item as JsonObject).type).toBe("force_message");
      expect(((greeting.item as JsonObject).content as JsonObject[])[0]).toMatchObject({
        type: "output_text",
        text: call.greeting,
      });
      expect(call.greeting).toMatch(/^Olá, (bom dia|boa tarde|boa noite)\. Fala a secretária\. Confirmar quinta\.$/);
      grokWs.send(JSON.stringify({ type: "response.created", response_id: "greeting" }));
      grokWs.send(JSON.stringify({ type: "response.done" }));
      const talkingUpdate = await waitFor(
        grokFromApp,
        (m) =>
          m.type === "session.update" &&
          ((m.session as JsonObject).turn_detection as JsonObject | undefined)?.create_response === true,
      );
      expect((talkingUpdate.session as JsonObject).turn_detection).toMatchObject({
        create_response: true,
      });

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

  it("plays ElevenLabs PCMU to Telnyx when tts_provider=elevenlabs and drops Grok audio", async () => {
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

    const elPcmu = Buffer.alloc(160, 0xab);
    const elCalls: { url: string; body: string }[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      elCalls.push({ url: String(url), body: String(init?.body ?? "") });
      return new Response(elPcmu, { status: 200 });
    };

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

    const withLabs: AppConfig = {
      ...config,
      elevenlabs: {
        apiKey: "el-key",
        voiceId: "NkpT2jezLnCDRKHkWiX",
        model: "eleven_v3",
        configured: true,
      },
      ready: { ...config.ready, elevenlabs: true },
    };

    const { app, store, attach } = createApp({
      config: withLabs,
      telnyx,
      connectGrok: () => new WebSocket(`ws://127.0.0.1:${grokPort}`),
      fetchImpl,
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
          greeting: "Olá, fala a secretária.",
          objective: "Confirmar quinta",
          tts_provider: "elevenlabs",
        });
      const call = store.get(created.body.id as string);
      if (!call) throw new Error("call missing");
      expect(call.ttsProvider).toBe("elevenlabs");

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
      await waitFor(grokFromApp, (m) => m.type === "session.update");
      grokWs.send(JSON.stringify({ type: "session.updated" }));
      await waitFor(grokFromApp, (m) => m.type === "conversation.item.create");

      const greetingMedia = await waitFor(telnyxFromGrok, (m) => m.event === "media");
      expect(greetingMedia).toEqual({
        event: "media",
        media: { payload: elPcmu.toString("base64") },
      });
      expect(elCalls[0]?.url).toContain("NkpT2jezLnCDRKHkWiX");
      expect(elCalls[0]?.url).toContain("output_format=ulaw_8000");
      expect(elCalls[0]?.body).toContain(call.greeting);

      grokWs.send(JSON.stringify({ type: "response.created", response_id: "greeting" }));
      grokWs.send(JSON.stringify({ type: "response.output_audio.delta", delta: "GROKAUDIO" }));
      grokWs.send(JSON.stringify({ type: "response.done" }));
      await new Promise((r) => setTimeout(r, 50));
      expect(telnyxFromGrok.filter((m) => m.event === "media")).toHaveLength(1);

      grokWs.send(JSON.stringify({ type: "response.created", response_id: "turn-1" }));
      grokWs.send(
        JSON.stringify({
          type: "response.output_audio_transcript.done",
          response_id: "turn-1",
          transcript: "Perfeito, às 18h.",
        }),
      );
      const turnMedia = await waitFor(
        telnyxFromGrok,
        (m) => m.event === "media" && telnyxFromGrok.filter((x) => x.event === "media").length >= 2,
      );
      expect(turnMedia).toEqual({
        event: "media",
        media: { payload: elPcmu.toString("base64") },
      });
      expect(elCalls.some((c) => c.body.includes("Perfeito, às 18h."))).toBe(true);

      telnyxWs.close();
      grokWs.close();
    } finally {
      httpServer.close();
      grokWss.close();
    }
  });
});
