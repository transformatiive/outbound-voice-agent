import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import type { TelnyxClient } from "../src/telnyx/client.js";

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
  resultWebhook: "https://n8n.example/webhook/result",
  maxCallSeconds: 600,
  webhookUrl: "https://example.up.railway.app/webhooks/telnyx",
  mediaStreamUrl: (callId, token) =>
    `wss://example.up.railway.app/media-stream?callId=${encodeURIComponent(callId)}&token=${encodeURIComponent(token)}`,
  ready: { api: true, telnyx: true, xai: true, outbound: true },
};

function mockTelnyx(): TelnyxClient {
  return {
    dial: vi.fn(async () => ({
      call_control_id: "v2:control-id",
      call_leg_id: "leg-id",
      call_session_id: "session-id",
      is_alive: false,
      record_type: "call",
    })),
    hangup: vi.fn(async () => undefined),
  };
}

describe("HTTP API", () => {
  let telnyx: TelnyxClient;

  beforeEach(() => {
    telnyx = mockTelnyx();
  });

  it("GET /health is public and reports Grok ara + caller ID", async () => {
    const { app } = createApp({ config, telnyx });
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.voice).toBe("ara");
    expect(res.body.model).toBe("grok-voice-think-fast-2.0");
    expect(res.body.from).toBe("+351210210260");
    expect(res.body.language).toBe("pt-PT");
    expect(res.body.languages).toEqual(["pt-PT", "en-GB", "en-US"]);
    expect(res.body.telnyx.connectionId).toBe("3041732714274227469");
    expect(res.body.telnyx.outboundVoiceProfileId).toBe("3041732644774610184");
    expect(res.body.telnyx.webhookPath).toBe("/webhooks/telnyx");
    expect(res.body.ready.outbound).toBe(true);
  });

  it("rejects outbound without Bearer API_KEY", async () => {
    const { app } = createApp({ config, telnyx });
    const res = await request(app).post("/api/outbound").send({
      to: "+351912345678",
      language: "pt-PT",
      greeting: "Olá",
      objective: "Confirmar marcação",
    });
    expect(res.status).toBe(401);
    expect(telnyx.dial).not.toHaveBeenCalled();
  });

  it("validates language and E.164 destination", async () => {
    const { app } = createApp({ config, telnyx });
    const badLang = await request(app)
      .post("/api/outbound")
      .set("Authorization", "Bearer test-api-key")
      .send({
        to: "+351912345678",
        language: "pt-BR",
        greeting: "Olá",
        objective: "x",
      });
    expect(badLang.status).toBe(400);
    expect(badLang.body.error).toBe("invalid_language");
    expect(telnyx.dial).not.toHaveBeenCalled();

    const englishGb = await request(app)
      .post("/api/outbound")
      .set("Authorization", "Bearer test-api-key")
      .send({
        to: "+351912345678",
        language: "en-GB",
        greeting: "Hello, this is Ara.",
        objective: "Confirm Thursday at 4pm",
      });
    expect(englishGb.status).toBe(201);
    expect(englishGb.body.language).toBe("en-GB");

    const englishUs = await request(app)
      .post("/api/outbound")
      .set("Authorization", "Bearer test-api-key")
      .send({
        to: "+351912345677",
        language: "en-US",
        objective: "Confirm Thursday at 4pm",
      });
    expect(englishUs.status).toBe(201);
    expect(englishUs.body.language).toBe("en-US");
    expect(englishUs.body).toMatchObject({ language: "en-US" });

    const gotUs = await request(app)
      .get(`/api/calls/${englishUs.body.id}`)
      .set("Authorization", "Bearer test-api-key");
    expect(gotUs.body.greeting).toBe("Hi, this is Ara. This call is being recorded.");

    const badTo = await request(app)
      .post("/api/outbound")
      .set("Authorization", "Bearer test-api-key")
      .send({
        to: "912345678",
        language: "pt-PT",
        greeting: "Olá",
        objective: "x",
      });
    expect(badTo.status).toBe(400);
    expect(telnyx.dial).toHaveBeenCalledTimes(2);
  });

  it("dials Telnyx Call Control with bidirectional media streaming and does not use Alice inbound", async () => {
    const { app } = createApp({ config, telnyx });
    const res = await request(app)
      .post("/api/outbound")
      .set("Authorization", "Bearer test-api-key")
      .send({
        to: "+351912345678",
        language: "pt-PT",
        greeting: "Olá, fala a Ara.",
        objective: "Confirmar a marcação de quinta às 16h",
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(res.body.status).toBe("dialing");
    expect(res.body.from).toBe("+351210210260");
    expect(res.body.to).toBe("+351912345678");
    expect(res.body.language).toBe("pt-PT");
    expect(res.body.voice).toBe("ara");

    expect(telnyx.dial).toHaveBeenCalledTimes(1);
    const dialArg = vi.mocked(telnyx.dial).mock.calls[0]?.[0];
    expect(dialArg).toMatchObject({
      connection_id: "3041732714274227469",
      to: "+351912345678",
      from: "+351210210260",
      stream_track: "inbound_track",
      stream_bidirectional_mode: "rtp",
      stream_bidirectional_codec: "PCMU",
      stream_bidirectional_target_legs: "self",
      webhook_url: "https://example.up.railway.app/webhooks/telnyx",
    });
    expect(dialArg?.stream_url).toMatch(
      /^wss:\/\/example\.up\.railway\.app\/media-stream\?callId=.+&token=.+/,
    );
    expect(JSON.stringify(dialArg)).not.toMatch(/alice/i);

    const omittedLang = await request(app)
      .post("/api/outbound")
      .set("Authorization", "Bearer test-api-key")
      .send({
        to: "+351912345679",
        greeting: "Olá, fala a Ara.",
        objective: "Confirmar a marcação",
      });
    expect(omittedLang.status).toBe(201);
    expect(omittedLang.body.language).toBe("pt-PT");

    const got = await request(app)
      .get(`/api/calls/${res.body.id}`)
      .set("Authorization", "Bearer test-api-key");
    expect(got.status).toBe(200);
    expect(got.body.telnyx.callControlId).toBe("v2:control-id");
    expect(got.body.greeting).toBe("Olá, fala a Ara.");
    expect(got.body.objective).toBe("Confirmar a marcação de quinta às 16h");
  });

  it("GET /api/calls/:id requires auth and 404s unknown ids", async () => {
    const { app } = createApp({ config, telnyx });
    const unauth = await request(app).get("/api/calls/not-a-call");
    expect(unauth.status).toBe(401);
    const missing = await request(app)
      .get("/api/calls/00000000-0000-4000-8000-000000000000")
      .set("Authorization", "Bearer test-api-key");
    expect(missing.status).toBe(404);
  });

  it("returns 503 when outbound is not configured instead of calling Telnyx", async () => {
    const unready = {
      ...config,
      telnyxConnectionId: "",
      ready: { api: true, telnyx: false, xai: true, outbound: false },
    };
    const { app } = createApp({ config: unready, telnyx });
    const res = await request(app)
      .post("/api/outbound")
      .set("Authorization", "Bearer test-api-key")
      .send({
        to: "+351912345678",
        language: "pt-PT",
        greeting: "Olá",
        objective: "Confirmar marcação",
      });
    expect(res.status).toBe(503);
    expect(telnyx.dial).not.toHaveBeenCalled();
  });
});
