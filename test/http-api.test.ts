import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import { DEFAULT_TURN_DETECTION } from "../src/grok/session.js";
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
  grokVoiceSpeed: 1,
  elevenlabs: { apiKey: "", voiceId: "", model: "eleven_v3", configured: false },
  openai: {
    apiKey: "",
    baseUrl: "https://api.openai.com",
    model: "gpt-realtime-2.1",
    voice: "coral",
    configured: false,
    prewarmTimeoutMs: 2000,
  },
  turnDetection: DEFAULT_TURN_DETECTION,
  calleeSpeechGraceMs: 1000,
  calleeMinSpeechMs: 250,
  hangupPlayoutBufferMs: 0,
  elevenlabsVadSilenceMs: 130,
  publicBaseUrl: "https://example.up.railway.app",
  resultWebhook: "https://n8n.example/webhook/result",
  maxCallSeconds: 600,
  webhookUrl: "https://example.up.railway.app/webhooks/telnyx",
  mediaStreamUrl: (callId, token) =>
    `wss://example.up.railway.app/media-stream?callId=${encodeURIComponent(callId)}&token=${encodeURIComponent(token)}`,
  ready: { api: true, telnyx: true, xai: true, outbound: true, elevenlabs: false, openai: false },
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
    expect(res.body.ready.elevenlabs).toBe(false);
    expect(res.body.ready.openai).toBe(false);
    expect(res.body.tts).toEqual({
      default: "grok",
      grokVoice: "ara",
      elevenlabs: { configured: false, audioPathActive: false, model: "eleven_v3", voiceId: "" },
      openai: {
        configured: false,
        audioPathActive: false,
        model: "gpt-realtime-2.1",
        voice: "coral",
      },
    });
    expect(res.body.tts.elevenlabs.apiKey).toBeUndefined();
    expect(res.body.tts.openai.apiKey).toBeUndefined();
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
        greeting: "Hello, this is the secretary.",
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
    expect(gotUs.body.greeting).toMatch(
      /^Hello, good (morning|afternoon|evening)\. I'm calling from the secretary\. Confirm Thursday at 4pm\.$/,
    );
    expect(gotUs.body.greeting).not.toMatch(/Ara|Grok|record/i);

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
        greeting: "Olá, fala a secretária.",
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
        greeting: "Olá, fala a secretária.",
        objective: "Confirmar a marcação",
      });
    expect(omittedLang.status).toBe(201);
    expect(omittedLang.body.language).toBe("pt-PT");

    const got = await request(app)
      .get(`/api/calls/${res.body.id}`)
      .set("Authorization", "Bearer test-api-key");
    expect(got.status).toBe(200);
    expect(got.body.telnyx.callControlId).toBe("v2:control-id");
    expect(got.body.greeting).toMatch(
      /^Olá, (bom dia|boa tarde|boa noite)\. Fala a secretária\. Confirmar a marcação de quinta às 16h\.$/,
    );
    expect(got.body.objective).toBe("Confirmar a marcação de quinta às 16h");
    expect(got.body.waitForCallee).toBe(false);
    expect(res.body.waitForCallee).toBe(false);
  });

  it("stores waitForCallee true and infers it from wait instructions", async () => {
    const { app, store } = createApp({ config, telnyx });
    const explicit = await request(app)
      .post("/api/outbound")
      .set("Authorization", "Bearer test-api-key")
      .send({
        to: "+351912345678",
        language: "pt-PT",
        greeting: "Olá, fala a secretária.",
        objective: "Confirmar a marcação",
        waitForCallee: true,
      });
    expect(explicit.status).toBe(201);
    expect(explicit.body.waitForCallee).toBe(true);
    const stored = store.get(explicit.body.id as string);
    expect(stored?.waitForCallee).toBe(true);

    const got = await request(app)
      .get(`/api/calls/${explicit.body.id}`)
      .set("Authorization", "Bearer test-api-key");
    expect(got.status).toBe(200);
    expect(got.body.waitForCallee).toBe(true);

    const inferred = await request(app)
      .post("/api/outbound")
      .set("Authorization", "Bearer test-api-key")
      .send({
        to: "+351912345679",
        language: "pt-PT",
        greeting: "Olá, fala a secretária.",
        objective: "Confirmar a marcação",
        instructions: "Wait silently until the callee speaks, then introduce yourself.",
      });
    expect(inferred.status).toBe(201);
    expect(inferred.body.waitForCallee).toBe(true);

    const omitted = await request(app)
      .post("/api/outbound")
      .set("Authorization", "Bearer test-api-key")
      .send({
        to: "+351912345680",
        language: "pt-PT",
        greeting: "Olá",
        objective: "Confirmar",
      });
    expect(omitted.status).toBe(201);
    expect(omitted.body.waitForCallee).toBe(false);

    const bad = await request(app)
      .post("/api/outbound")
      .set("Authorization", "Bearer test-api-key")
      .send({
        to: "+351912345681",
        language: "pt-PT",
        greeting: "Olá",
        objective: "Confirmar",
        waitForCallee: "yes",
      });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid_waitForCallee");
    expect(telnyx.dial).toHaveBeenCalledTimes(3);
  });

  it("composes Olá + time-of-day + purpose when greeting is omitted, including waitForCallee", async () => {
    const { app } = createApp({ config, telnyx });
    const omittedPt = await request(app)
      .post("/api/outbound")
      .set("Authorization", "Bearer test-api-key")
      .send({
        to: "+351912345682",
        language: "pt-PT",
        objective: "Confirmar a marcação",
      });
    expect(omittedPt.status).toBe(201);
    const gotPt = await request(app)
      .get(`/api/calls/${omittedPt.body.id}`)
      .set("Authorization", "Bearer test-api-key");
    expect(gotPt.body.greeting).toMatch(
      /^Olá, (bom dia|boa tarde|boa noite)\. Ligo da secretária\. Confirmar a marcação\.$/,
    );
    expect(gotPt.body.greeting).not.toMatch(/Ara|Grok|gravad|record/i);

    const waitMissing = await request(app)
      .post("/api/outbound")
      .set("Authorization", "Bearer test-api-key")
      .send({
        to: "+351912345683",
        language: "pt-PT",
        objective: "Confirmar a marcação",
        waitForCallee: true,
      });
    expect(waitMissing.status).toBe(201);
    expect(waitMissing.body.waitForCallee).toBe(true);
    const gotWait = await request(app)
      .get(`/api/calls/${waitMissing.body.id}`)
      .set("Authorization", "Bearer test-api-key");
    expect(gotWait.body.greeting).toMatch(
      /^Olá, (bom dia|boa tarde|boa noite)\. Ligo da secretária\. Confirmar a marcação\.$/,
    );
    expect(telnyx.dial).toHaveBeenCalledTimes(2);
  });

  it("never speaks a ROLEPLAY objective in the composed greeting", async () => {
    const { app } = createApp({ config, telnyx });
    const res = await request(app)
      .post("/api/outbound")
      .set("Authorization", "Bearer test-api-key")
      .send({
        to: "+351912345684",
        language: "pt-PT",
        greeting: "Fala a secretária da clínica.",
        objective: `ROLEPLAY: quem atende diz Estou.
# Objetivo
Confirmar a consulta de otorrino na segunda às 10h.`,
        waitForCallee: true,
      });
    expect(res.status).toBe(201);
    const got = await request(app)
      .get(`/api/calls/${res.body.id}`)
      .set("Authorization", "Bearer test-api-key");
    expect(got.body.greeting).toMatch(/^Olá, (bom dia|boa tarde|boa noite)\. Fala a secretária da clínica\. Confirmar a consulta de otorrino na segunda às 10h\.$/);
    expect(got.body.greeting).not.toMatch(/ROLEPLAY/i);
    expect(got.body.greeting).not.toMatch(/quem atende/i);
    expect(got.body.objective).toMatch(/ROLEPLAY/);
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
      ready: { api: true, telnyx: false, xai: true, outbound: false, elevenlabs: false, openai: false },
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

  it("returns 503 elevenlabs_not_configured when tts_provider is elevenlabs without keys", async () => {
    const { app } = createApp({ config, telnyx });
    const res = await request(app)
      .post("/api/outbound")
      .set("Authorization", "Bearer test-api-key")
      .send({
        to: "+351912345678",
        language: "pt-PT",
        objective: "Reservar uma mesa",
        tts_provider: "elevenlabs",
        waitForCallee: true,
      });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("elevenlabs_not_configured");
    expect(res.body.details).toMatch(/ELEVENLABS_API_KEY/);
    expect(telnyx.dial).not.toHaveBeenCalled();
  });

  it("GET /health reports ElevenLabs audio path active when the key is configured", async () => {
    const withLabs = {
      ...config,
      elevenlabs: {
        apiKey: "el-key",
        voiceId: "NkpT2jezTenCDRKHkWiX",
        model: "eleven_v3",
        configured: true,
      },
      ready: { ...config.ready, elevenlabs: true },
    };
    const { app } = createApp({ config: withLabs, telnyx });
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.tts.elevenlabs).toEqual({
      configured: true,
      audioPathActive: true,
      model: "eleven_v3",
      voiceId: "NkpT2jezTenCDRKHkWiX",
    });
    expect(res.body.ready.elevenlabs).toBe(true);
    expect(res.body.tts.elevenlabs.apiKey).toBeUndefined();
  });

  it("accepts tts_provider=elevenlabs when configured; Grok voice stays ara for STT", async () => {
    const withLabs = {
      ...config,
      elevenlabs: {
        apiKey: "el-key",
        voiceId: "el-voice",
        model: "eleven_v3",
        configured: true,
      },
      ready: { ...config.ready, elevenlabs: true },
    };
    const { app } = createApp({
      config: withLabs,
      telnyx,
      fetchImpl: async () => new Response(Buffer.alloc(160, 0x7f), { status: 200 }),
    });
    const res = await request(app)
      .post("/api/outbound")
      .set("Authorization", "Bearer test-api-key")
      .send({
        to: "+351912345678",
        language: "pt-PT",
        persona: "secretária da empresa",
        objective: "Reservar uma mesa para quinta.",
        tts_provider: "elevenlabs",
        bot_role: "caller_booking",
        callee_role: "venue_staff",
        waitForCallee: true,
      });
    expect(res.status).toBe(201);
    expect(res.body.ttsProvider).toBe("elevenlabs");
    expect(res.body.voice).toBe("ara");
    expect(res.body.botRole).toBe("caller_booking");
    expect(res.body.calleeRole).toBe("venue_staff");
    expect(res.body.language).toBe("pt-PT");
    expect(telnyx.dial).toHaveBeenCalledTimes(1);

    const got = await request(app)
      .get(`/api/calls/${res.body.id}`)
      .set("Authorization", "Bearer test-api-key");
    expect(got.body.ttsProvider).toBe("elevenlabs");
    expect(got.body.persona).toBe("secretária da empresa");
    expect(got.body.greeting).toMatch(/Fala a secretária da empresa/);
    expect(got.body.greeting).not.toMatch(/bem-vindo ao restaurante/i);
    expect(got.body.voice).toBe("ara");
  });

  it("starts ElevenLabs greeting TTS at dial and does not wait for unlock or media stream", async () => {
    const elPcmu = Buffer.alloc(160, 0x7f);
    const elCalls: { url: string; body: string }[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      elCalls.push({ url: String(url), body: String(init?.body ?? "") });
      return new Response(elPcmu, { status: 200 });
    };
    const withLabs = {
      ...config,
      elevenlabs: {
        apiKey: "el-key",
        voiceId: "NkpT2jezTenCDRKHkWiX",
        model: "eleven_v3",
        configured: true,
      },
      ready: { ...config.ready, elevenlabs: true },
    };
    const { app, store } = createApp({ config: withLabs, telnyx, fetchImpl });
    const res = await request(app)
      .post("/api/outbound")
      .set("Authorization", "Bearer test-api-key")
      .send({
        to: "+351912345678",
        language: "pt-PT",
        greeting: "Olá, fala a secretária.",
        objective: "Confirmar quinta",
        tts_provider: "elevenlabs",
        waitForCallee: true,
      });
    expect(res.status).toBe(201);
    const call = store.get(res.body.id as string);
    if (!call) throw new Error("call missing");
    for (let i = 0; i < 20 && elCalls.length === 0; i++) await Promise.resolve();
    expect(elCalls.length).toBeGreaterThanOrEqual(1);
    expect(elCalls[0]?.url).toContain("NkpT2jezTenCDRKHkWiX");
    expect(elCalls[0]?.body).toContain(call.greeting);
    expect(telnyx.dial).toHaveBeenCalledTimes(1);
  });

  it("swapping only tts_provider keeps the same dial, persona, roles, and pt-PT fields", async () => {
    const withLabs = {
      ...config,
      elevenlabs: {
        apiKey: "el-key",
        voiceId: "NkpT2jezTenCDRKHkWiX",
        model: "eleven_v3",
        configured: true,
      },
      ready: { ...config.ready, elevenlabs: true },
    };
    const { app } = createApp({
      config: withLabs,
      telnyx,
      fetchImpl: async () => new Response(Buffer.alloc(160, 0x7f), { status: 200 }),
    });
    const body = {
      to: "+351912345678",
      language: "pt-PT",
      persona: "secretária da empresa",
      objective: "Reservar uma mesa para 2 hoje à noite.",
      waitForCallee: true,
      bot_role: "caller_booking",
      callee_role: "venue_staff",
    };
    const grok = await request(app)
      .post("/api/outbound")
      .set("Authorization", "Bearer test-api-key")
      .send({ ...body, tts_provider: "grok" });
    const el = await request(app)
      .post("/api/outbound")
      .set("Authorization", "Bearer test-api-key")
      .send({ ...body, tts_provider: "elevenlabs" });
    expect(grok.status).toBe(201);
    expect(el.status).toBe(201);
    expect(grok.body.ttsProvider).toBe("grok");
    expect(el.body.ttsProvider).toBe("elevenlabs");
    expect(el.body.language).toBe("pt-PT");
    expect(el.body.language).toBe(grok.body.language);
    expect(el.body.botRole).toBe(grok.body.botRole);
    expect(el.body.calleeRole).toBe(grok.body.calleeRole);
    expect(el.body.to).toBe(grok.body.to);
    expect(el.body.waitForCallee).toBe(true);
    expect(el.body.voice).toBe("ara");
    expect(grok.body.voice).toBe("ara");

    const grokCall = await request(app)
      .get(`/api/calls/${grok.body.id}`)
      .set("Authorization", "Bearer test-api-key");
    const elCall = await request(app)
      .get(`/api/calls/${el.body.id}`)
      .set("Authorization", "Bearer test-api-key");
    expect(elCall.body.greeting).toBe(grokCall.body.greeting);
    expect(elCall.body.persona).toBe(grokCall.body.persona);
    expect(elCall.body.objective).toBe(grokCall.body.objective);
    expect(elCall.body.greeting).toMatch(/Fala a secretária da empresa/);

    expect(telnyx.dial).toHaveBeenCalledTimes(2);
    const grokDial = vi.mocked(telnyx.dial).mock.calls[0]?.[0];
    const elDial = vi.mocked(telnyx.dial).mock.calls[1]?.[0];
    expect(elDial?.connection_id).toBe(grokDial?.connection_id);
    expect(elDial?.to).toBe(grokDial?.to);
    expect(elDial?.from).toBe(grokDial?.from);
    expect(elDial?.stream_bidirectional_codec).toBe("PCMU");
    expect(elDial?.stream_bidirectional_codec).toBe(grokDial?.stream_bidirectional_codec);
    expect(elDial?.stream_bidirectional_mode).toBe(grokDial?.stream_bidirectional_mode);
    expect(elDial?.webhook_url).toBe(grokDial?.webhook_url);
  });

  it("defaults tts_provider grok and echoes roles on POST /api/outbound", async () => {
    const { app } = createApp({ config, telnyx });
    const res = await request(app)
      .post("/api/outbound")
      .set("Authorization", "Bearer test-api-key")
      .send({
        to: "+351912345678",
        objective: "Confirmar a marcação",
        waitForCallee: true,
      });
    expect(res.status).toBe(201);
    expect(res.body.ttsProvider).toBe("grok");
    expect(res.body.botRole).toBe("caller_booking");
    expect(res.body.calleeRole).toBe("venue_staff");
    expect(res.body.voice).toBe("ara");
  });

  it("returns 503 openai_not_configured when tts_provider is openai without OPENAI_API_KEY", async () => {
    const { app } = createApp({ config, telnyx });
    const res = await request(app)
      .post("/api/outbound")
      .set("Authorization", "Bearer test-api-key")
      .send({
        to: "+351912345678",
        language: "pt-PT",
        objective: "Reservar uma mesa",
        tts_provider: "openai",
        waitForCallee: true,
      });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("openai_not_configured");
    expect(res.body.details).toMatch(/OPENAI_API_KEY/);
    expect(telnyx.dial).not.toHaveBeenCalled();
  });

  it("GET /health reports OpenAI configured without secrets when the key is set", async () => {
    const withOpenAI = {
      ...config,
      openai: {
        apiKey: "sk-test",
        baseUrl: "https://api.openai.com",
        model: "gpt-realtime-2.1",
        voice: "coral",
        configured: true,
        prewarmTimeoutMs: 2000,
      },
      ready: { ...config.ready, openai: true },
    };
    const { app } = createApp({ config: withOpenAI, telnyx });
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.tts.openai).toEqual({
      configured: true,
      audioPathActive: true,
      model: "gpt-realtime-2.1",
      voice: "coral",
    });
    expect(res.body.ready.openai).toBe(true);
    expect(res.body.tts.openai.apiKey).toBeUndefined();
  });

  it("accepts tts_provider=openai when configured and echoes OpenAI voice/model, not ara", async () => {
    const { connectFakeOpenAI } = await import("./helpers/fake-openai-ws.js");
    const withOpenAI = {
      ...config,
      openai: {
        apiKey: "sk-test",
        baseUrl: "https://api.openai.com",
        model: "gpt-realtime-2.1",
        voice: "coral",
        configured: true,
        prewarmTimeoutMs: 2000,
      },
      ready: { ...config.ready, openai: true },
    };
    const { app } = createApp({
      config: withOpenAI,
      telnyx,
      connectOpenAI: () => connectFakeOpenAI() as unknown as import("ws").WebSocket,
    });
    const res = await request(app)
      .post("/api/outbound")
      .set("Authorization", "Bearer test-api-key")
      .send({
        to: "+351912345678",
        language: "pt-PT",
        persona: "secretária da empresa",
        objective: "Reservar uma mesa para quinta.",
        tts_provider: "openai",
        openai_voice: "marin",
        bot_role: "caller_booking",
        callee_role: "venue_staff",
        waitForCallee: true,
      });
    expect(res.status).toBe(201);
    expect(res.body.ttsProvider).toBe("openai");
    expect(res.body.voice).toBe("marin");
    expect(res.body.model).toBe("gpt-realtime-2.1");
    expect(res.body.language).toBe("pt-PT");
    expect(telnyx.dial).toHaveBeenCalledTimes(1);

    const got = await request(app)
      .get(`/api/calls/${res.body.id}`)
      .set("Authorization", "Bearer test-api-key");
    expect(got.body.ttsProvider).toBe("openai");
    expect(got.body.voice).toBe("marin");
    expect(got.body.greeting).toMatch(/Fala a secretária da empresa/);
    expect(got.body.greeting).not.toMatch(/bem-vindo ao restaurante/i);
  });

  it("returns 503 openai_session_failed when the Realtime socket never becomes ready", async () => {
    const { EventEmitter } = await import("node:events");
    const { WebSocket } = await import("ws");
    const withOpenAI = {
      ...config,
      openai: {
        apiKey: "sk-test",
        baseUrl: "https://api.openai.com",
        model: "gpt-realtime-2.1",
        voice: "coral",
        configured: true,
        prewarmTimeoutMs: 50,
      },
      ready: { ...config.ready, openai: true },
    };
    const { app } = createApp({
      config: withOpenAI,
      telnyx,
      connectOpenAI: () => {
        const emitter = new EventEmitter();
        return {
          readyState: WebSocket.CONNECTING,
          send() {
            /* never opens */
          },
          close() {
            emitter.emit("close");
          },
          on(event: string, fn: (...args: unknown[]) => void) {
            emitter.on(event, fn);
            return this;
          },
        } as unknown as import("ws").WebSocket;
      },
    });
    const res = await request(app)
      .post("/api/outbound")
      .set("Authorization", "Bearer test-api-key")
      .send({
        to: "+351912345678",
        objective: "Reservar uma mesa",
        tts_provider: "openai",
      });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("openai_session_failed");
    expect(telnyx.dial).not.toHaveBeenCalled();
  });

  it("swapping tts_provider across grok | elevenlabs | openai keeps dial, persona, roles, and pt-PT", async () => {
    const { connectFakeOpenAI } = await import("./helpers/fake-openai-ws.js");
    const withAll = {
      ...config,
      elevenlabs: {
        apiKey: "el-key",
        voiceId: "NkpT2jezTenCDRKHkWiX",
        model: "eleven_v3",
        configured: true,
      },
      openai: {
        apiKey: "sk-test",
        baseUrl: "https://api.openai.com",
        model: "gpt-realtime-2.1",
        voice: "coral",
        configured: true,
        prewarmTimeoutMs: 2000,
      },
      ready: { ...config.ready, elevenlabs: true, openai: true },
    };
    const { app } = createApp({
      config: withAll,
      telnyx,
      connectOpenAI: () => connectFakeOpenAI() as unknown as import("ws").WebSocket,
    });
    const body = {
      to: "+351912345678",
      language: "pt-PT",
      persona: "secretária da empresa",
      objective: "Reservar uma mesa para 2 hoje à noite.",
      waitForCallee: true,
      bot_role: "caller_booking",
      callee_role: "venue_staff",
    };
    const grok = await request(app)
      .post("/api/outbound")
      .set("Authorization", "Bearer test-api-key")
      .send({ ...body, tts_provider: "grok" });
    const el = await request(app)
      .post("/api/outbound")
      .set("Authorization", "Bearer test-api-key")
      .send({ ...body, tts_provider: "elevenlabs" });
    const openai = await request(app)
      .post("/api/outbound")
      .set("Authorization", "Bearer test-api-key")
      .send({ ...body, tts_provider: "openai" });
    expect(grok.status).toBe(201);
    expect(el.status).toBe(201);
    expect(openai.status).toBe(201);
    expect(grok.body.ttsProvider).toBe("grok");
    expect(el.body.ttsProvider).toBe("elevenlabs");
    expect(openai.body.ttsProvider).toBe("openai");
    expect(el.body.language).toBe(grok.body.language);
    expect(openai.body.language).toBe(grok.body.language);
    expect(openai.body.botRole).toBe(grok.body.botRole);
    expect(openai.body.to).toBe(grok.body.to);
    expect(grok.body.voice).toBe("ara");
    expect(el.body.voice).toBe("ara");
    expect(openai.body.voice).toBe("coral");
    expect(telnyx.dial).toHaveBeenCalledTimes(3);
  });
});
