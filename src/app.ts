import express from "express";
import type { Server as HttpServer } from "node:http";
import { requireApiKey } from "./auth.js";
import type { AppConfig } from "./config.js";
import { CallStore } from "./calls/store.js";
import { toPublicCall } from "./calls/types.js";
import type { TelnyxClient } from "./telnyx/client.js";
import { verifyTelnyxSignature } from "./telnyx/signature.js";
import {
  applyTelnyxEvent,
  decodeClientState,
  type TelnyxWebhookEnvelope,
} from "./telnyx/webhooks.js";
import { placeOutboundCall } from "./outbound.js";
import { LANGUAGES } from "./prompt.js";
import { DEFAULT_BOT_ROLE, DEFAULT_CALLEE_ROLE } from "./roles.js";
import { DEFAULT_TTS_PROVIDER, elevenLabsAudioPathActive, openaiAudioPathActive } from "./tts.js";
import { attachMediaStream } from "./bridge/media-stream.js";
import { GreetingAudioCache } from "./bridge/greeting-audio-cache.js";
import {
  CallRuntime,
  CallRuntimeRegistry,
  resolveConnectGrok,
  type ConnectGrokFn,
} from "./bridge/call-runtime.js";
import { createElevenLabsTts } from "./elevenlabs.js";
import { notifyResultWebhook } from "./result-webhook.js";
import type { CallRecord } from "./calls/types.js";
import { OpenAISessionStore } from "./openai/sessions.js";
import type { ConnectOpenAI } from "./openai/prewarm.js";

export type AppDeps = {
  config: AppConfig;
  telnyx: TelnyxClient;
  store?: CallStore;
  fetchImpl?: typeof fetch;
  connectGrok?: ConnectGrokFn;
  connectOpenAI?: ConnectOpenAI;
  openaiSessions?: OpenAISessionStore;
};

export type CreatedApp = {
  app: express.Express;
  store: CallStore;
  attach: (server: HttpServer) => void;
};

export function createApp(deps: AppDeps): CreatedApp {
  const store = deps.store ?? new CallStore();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const openaiSessions = deps.openaiSessions ?? new OpenAISessionStore();
  const greetingAudioCache = new GreetingAudioCache();
  const runtimes = new CallRuntimeRegistry();
  const connectGrok = resolveConnectGrok(deps.connectGrok);
  const elevenLabsTts = deps.config.elevenlabs.configured
    ? createElevenLabsTts(deps.config.elevenlabs, fetchImpl)
    : undefined;
  const notified = new Set<string>();

  const onCallEnded = (call: CallRecord) => {
    runtimes.drop(call.id);
    greetingAudioCache.drop(call.id);
    openaiSessions.close(call.id);
    if (notified.has(call.id)) return;
    notified.add(call.id);
    void notifyResultWebhook(deps.config.resultWebhook, call, fetchImpl);
  };

  const startRuntime = (call: CallRecord) => {
    runtimes.start(
      call.id,
      () =>
        new CallRuntime({
          call,
          config: deps.config,
          telnyx: deps.telnyx,
          connectGrok,
          onEnded: onCallEnded,
          greetingAudioCache,
          onClosed: () => runtimes.drop(call.id),
          ...(elevenLabsTts ? { elevenLabsTts } : {}),
        }),
    );
  };

  const app = express();
  app.use(
    express.json({
      limit: "1mb",
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "outbound-voice-agent",
      voice: deps.config.grokVoice,
      language: "pt-PT",
      languages: LANGUAGES,
      model: deps.config.grokModel,
      from: deps.config.fromNumber,
      tts: {
        default: "grok",
        grokVoice: deps.config.grokVoice,
        elevenlabs: {
          configured: deps.config.elevenlabs.configured,
          audioPathActive: elevenLabsAudioPathActive(deps.config.elevenlabs),
          model: deps.config.elevenlabs.model,
          voiceId: deps.config.elevenlabs.voiceId,
        },
        openai: {
          configured: deps.config.openai.configured,
          audioPathActive: openaiAudioPathActive(deps.config.openai),
          model: deps.config.openai.model,
          voice: deps.config.openai.voice,
        },
      },
      telnyx: {
        connectionId: deps.config.telnyxConnectionId,
        outboundVoiceProfileId: deps.config.telnyxOutboundVoiceProfileId,
        webhookPath: "/webhooks/telnyx",
      },
      ready: deps.config.ready,
    });
  });

  app.post("/webhooks/telnyx", (req, res) => {
    const publicKey = deps.config.telnyxPublicKey;
    if (publicKey) {
      const raw = (req as express.Request & { rawBody?: Buffer }).rawBody ?? Buffer.from("");
      const timestamp = String(req.get("telnyx-timestamp") ?? "");
      const signature = String(req.get("telnyx-signature-ed25519") ?? "");
      if (!verifyTelnyxSignature(raw, timestamp, signature, publicKey)) {
        res.status(401).json({ error: "invalid_signature" });
        return;
      }
    }

    const envelope = req.body as TelnyxWebhookEnvelope;
    const eventId = envelope.data?.id;
    if (store.consumeEvent(eventId)) {
      res.status(200).json({ ok: true, duplicate: true });
      return;
    }

    const payload = envelope.data?.payload;
    const fromState = decodeClientState(payload?.client_state);
    const call =
      (fromState ? store.get(fromState) : undefined) ??
      (payload?.call_control_id ? store.getByControlId(payload.call_control_id) : undefined);

    if (!call) {
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    const wasTerminal = store.isTerminal(call);
    applyTelnyxEvent(call, envelope, () => new Date().toISOString());
    if (payload?.call_control_id) store.indexControlId(call, payload.call_control_id);
    if (!wasTerminal && store.isTerminal(call)) onCallEnded(call);

    res.status(200).json({ ok: true });
  });

  const authed = requireApiKey(deps.config.apiKey);

  app.post("/api/outbound", authed, async (req, res) => {
    const result = await placeOutboundCall({
      config: deps.config,
      telnyx: deps.telnyx,
      store,
      body: req.body as Record<string, unknown>,
      openaiSessions,
      onCallEnded,
      fetchImpl,
      greetingAudioCache,
      onCallCreated: startRuntime,
      onDialFailed: (call) => {
        runtimes.drop(call.id);
        greetingAudioCache.drop(call.id);
        openaiSessions.close(call.id);
      },
      ...(deps.connectOpenAI ? { connectOpenAI: deps.connectOpenAI } : {}),
      ...(elevenLabsTts ? { elevenLabsTts } : {}),
    });
    if ("error" in result) {
      res.status(result.error.status).json(result.error);
      return;
    }
    res.status(201).json({
      id: result.call.id,
      status: result.call.status,
      to: result.call.to,
      from: result.call.from,
      language: result.call.language,
      voice: result.call.voice,
      model: result.call.model,
      waitForCallee: result.call.waitForCallee === true,
      ttsProvider: result.call.ttsProvider ?? DEFAULT_TTS_PROVIDER,
      botRole: result.call.botRole ?? DEFAULT_BOT_ROLE,
      calleeRole: result.call.calleeRole ?? DEFAULT_CALLEE_ROLE,
      createdAt: result.call.createdAt,
    });
  });

  app.get("/api/calls/:id", authed, (req, res) => {
    const id = req.params.id ?? "";
    const call = store.get(id);
    if (!call) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(toPublicCall(call));
  });

  function attach(server: HttpServer): void {
    attachMediaStream(server, {
      config: deps.config,
      store,
      telnyx: deps.telnyx,
      onCallEnded,
      openaiSessions,
      greetingAudioCache,
      connectGrok,
      runtimes,
      ...(elevenLabsTts ? { elevenLabsTts } : {}),
    });
  }

  return { app, store, attach };
}
