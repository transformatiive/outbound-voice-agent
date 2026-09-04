import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { DEFAULT_TURN_DETECTION } from "../src/grok/session.js";
import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import type { TelnyxClient } from "../src/telnyx/client.js";
import { CallStore } from "../src/calls/store.js";

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
  turnDetection: DEFAULT_TURN_DETECTION,
  calleeSpeechGraceMs: 1000,
  calleeMinSpeechMs: 250,
  publicBaseUrl: "https://example.up.railway.app",
  resultWebhook: undefined,
  maxCallSeconds: 600,
  webhookUrl: "https://example.up.railway.app/webhooks/telnyx",
  mediaStreamUrl: (callId, token) =>
    `wss://example.up.railway.app/media-stream?callId=${callId}&token=${token}`,
  ready: { api: true, telnyx: true, xai: true, outbound: true },
};

describe("Telnyx webhooks", () => {
  it("updates call status from Call Control events and is idempotent", async () => {
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
    const store = new CallStore();
    const { app } = createApp({ config, telnyx, store });

    const created = await request(app)
      .post("/api/outbound")
      .set("Authorization", "Bearer test-api-key")
      .send({
        to: "+351910000001",
        language: "pt-PT",
        greeting: "Olá, fala a secretária.",
        objective: "Confirmar uma marcação",
      });
    const id = created.body.id as string;
    const clientState = Buffer.from(id, "utf8").toString("base64");

    const ringing = await request(app)
      .post("/webhooks/telnyx")
      .send({
        data: {
          event_type: "call.ringing",
          id: "evt-ring",
          payload: {
            call_control_id: "v2:control-id",
            client_state: clientState,
          },
        },
      });
    expect(ringing.status).toBe(200);

    await request(app)
      .post("/webhooks/telnyx")
      .send({
        data: {
          event_type: "call.answered",
          id: "evt-ans",
          payload: {
            call_control_id: "v2:control-id",
            client_state: clientState,
          },
        },
      });

    await request(app)
      .post("/webhooks/telnyx")
      .send({
        data: {
          event_type: "call.answered",
          id: "evt-ans",
          payload: {
            call_control_id: "v2:control-id",
            client_state: clientState,
          },
        },
      });

    const got = await request(app)
      .get(`/api/calls/${id}`)
      .set("Authorization", "Bearer test-api-key");
    expect(got.body.status).toBe("answered");

    await request(app)
      .post("/webhooks/telnyx")
      .send({
        data: {
          event_type: "call.hangup",
          id: "evt-hang",
          payload: {
            call_control_id: "v2:control-id",
            client_state: clientState,
            hangup_cause: "normal_clearing",
            hangup_source: "callee",
          },
        },
      });

    const ended = await request(app)
      .get(`/api/calls/${id}`)
      .set("Authorization", "Bearer test-api-key");
    expect(ended.body.status).toBe("completed");
    expect(ended.body.endedReason).toBe("callee_hangup");
  });

  it("maps no-answer hangup cause", async () => {
    const telnyx: TelnyxClient = {
      dial: vi.fn(async () => ({
        call_control_id: "v2:na",
        call_leg_id: "leg",
        call_session_id: "sess",
        is_alive: false,
        record_type: "call",
      })),
      hangup: vi.fn(async () => undefined),
    };
    const { app } = createApp({ config, telnyx });
    const created = await request(app)
      .post("/api/outbound")
      .set("Authorization", "Bearer test-api-key")
      .send({
        to: "+351910000002",
        language: "pt-PT",
        greeting: "Olá",
        objective: "Deixar um lembrete",
      });
    const clientState = Buffer.from(created.body.id, "utf8").toString("base64");
    await request(app)
      .post("/webhooks/telnyx")
      .send({
        data: {
          event_type: "call.hangup",
          payload: {
            call_control_id: "v2:na",
            client_state: clientState,
            hangup_cause: "no_answer",
          },
        },
      });
    const got = await request(app)
      .get(`/api/calls/${created.body.id}`)
      .set("Authorization", "Bearer test-api-key");
    expect(got.body.status).toBe("no_answer");
  });

  it("rejects unsigned webhooks when TELNYX_PUBLIC_KEY is set", async () => {
    const signedConfig: AppConfig = {
      ...config,
      telnyxPublicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    };
    const telnyx: TelnyxClient = { dial: vi.fn(), hangup: vi.fn() };
    const { app } = createApp({ config: signedConfig, telnyx });
    const res = await request(app)
      .post("/webhooks/telnyx")
      .send({ data: { event_type: "call.answered" } });
    expect(res.status).toBe(401);
  });
});
