import { randomBytes, randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { DEFAULT_TIMEZONE, composeSpokenGreeting, isValidTimeZone } from "./greeting.js";
import { instructionsRequestWait, isLanguage, type Language } from "./prompt.js";
import { DEFAULT_BOT_ROLE, DEFAULT_CALLEE_ROLE, parseRoleLabel } from "./roles.js";
import { parseOpenAIVoice } from "./openai/session.js";
import { GPT_LIVE_VOICE_LIST, parseGptLiveVoice } from "./openai/live-session.js";
import { GROK_VOICE_LIST, parseGrokVoice } from "./grok/session.js";
import {
  parseTtsProvider,
  ttsProviderUsesOpenAISession,
  type TtsProvider,
} from "./tts.js";
import { createElevenLabsTts } from "./elevenlabs.js";
import type { GreetingAudioCache } from "./bridge/greeting-audio-cache.js";
import type { ElevenLabsTts } from "./elevenlabs.js";
import type { CallRecord } from "./calls/types.js";
import type { TelnyxClient } from "./telnyx/client.js";
import { CallStore } from "./calls/store.js";
import { OpenAISessionError, prewarmOpenAISession, type ConnectOpenAI } from "./openai/prewarm.js";
import { prewarmGptLiveSession } from "./openai/live-prewarm.js";
import type { OpenAISessionStore } from "./openai/sessions.js";

const E164 = /^\+[1-9]\d{7,14}$/;
const MAX_PERSONA_CHARS = 500;

export type OutboundBody = {
  to?: unknown;
  language?: unknown;
  greeting?: unknown;
  persona?: unknown;
  objective?: unknown;
  instructions?: unknown;
  metadata?: unknown;
  maxDurationSeconds?: unknown;
  waitForCallee?: unknown;
  timezone?: unknown;
  spokenAsk?: unknown;
  tts_provider?: unknown;
  bot_role?: unknown;
  callee_role?: unknown;
  openai_voice?: unknown;
  gpt_live_voice?: unknown;
  grok_voice?: unknown;
  ivr?: unknown;
};

export type OutboundError = { status: number; error: string; details?: unknown };

export type ParseOutboundOptions = {
  now?: Date;
};

export function parseOutboundBody(
  body: OutboundBody,
  opts: ParseOutboundOptions = {},
):
  | {
      ok: true;
      value: {
        to: string;
        language: Language;
        greeting: string;
        objective: string;
        extraInstructions?: string;
        metadata?: Record<string, unknown>;
        maxDurationSeconds?: number;
        waitForCallee: boolean;
        timezone: string;
        persona?: string;
        botRole: string;
        calleeRole: string;
        ttsProvider: TtsProvider;
        openaiVoice?: string;
        grokVoice?: string;
        ivr: boolean;
      };
    }
  | { ok: false; error: OutboundError } {
  const to = typeof body.to === "string" ? body.to.trim() : "";
  if (!E164.test(to)) {
    return { ok: false, error: { status: 400, error: "invalid_to", details: "E.164 required, e.g. +351912345678" } };
  }
  const languageRaw = body.language;
  const language: unknown =
    languageRaw === undefined || languageRaw === null || languageRaw === "" ? "pt-PT" : languageRaw;
  if (!isLanguage(language)) {
    return {
      ok: false,
      error: { status: 400, error: "invalid_language", details: "language must be pt-PT | en-GB | en-US" },
    };
  }
  const ttsProviderParsed = parseTtsProvider(body.tts_provider);
  if (!ttsProviderParsed.ok) {
    return {
      ok: false,
      error: {
        status: 400,
        error: "invalid_tts_provider",
        details: "tts_provider must be grok | elevenlabs | openai | gpt-live",
      },
    };
  }
  const botRoleParsed = parseRoleLabel(body.bot_role, DEFAULT_BOT_ROLE);
  if (!botRoleParsed.ok) {
    return { ok: false, error: { status: 400, error: "invalid_bot_role" } };
  }
  const calleeRoleParsed = parseRoleLabel(body.callee_role, DEFAULT_CALLEE_ROLE);
  if (!calleeRoleParsed.ok) {
    return { ok: false, error: { status: 400, error: "invalid_callee_role" } };
  }
  let openaiVoice: string | undefined;
  if (ttsProviderParsed.value === "openai") {
    const voiceParsed = parseOpenAIVoice(body.openai_voice);
    if (!voiceParsed.ok) {
      return {
        ok: false,
        error: {
          status: 400,
          error: "invalid_openai_voice",
          details: "openai_voice must be alloy | ash | ballad | coral | echo | sage | shimmer | verse | marin | cedar",
        },
      };
    }
    if (body.openai_voice !== undefined && body.openai_voice !== null && body.openai_voice !== "") {
      openaiVoice = voiceParsed.value;
    }
  } else if (ttsProviderParsed.value === "gpt-live") {
    const liveVoiceRaw =
      body.gpt_live_voice !== undefined && body.gpt_live_voice !== null && body.gpt_live_voice !== ""
        ? body.gpt_live_voice
        : body.openai_voice;
    const voiceParsed = parseGptLiveVoice(liveVoiceRaw);
    if (!voiceParsed.ok) {
      return {
        ok: false,
        error: {
          status: 400,
          error: "invalid_gpt_live_voice",
          details: `gpt_live_voice / openai_voice must be ${GPT_LIVE_VOICE_LIST}`,
        },
      };
    }
    if (liveVoiceRaw !== undefined && liveVoiceRaw !== null && liveVoiceRaw !== "") {
      openaiVoice = voiceParsed.value;
    }
  }
  if (body.persona !== undefined && body.persona !== null && body.persona !== "" && typeof body.persona !== "string") {
    return { ok: false, error: { status: 400, error: "invalid_persona" } };
  }
  const personaRaw = typeof body.persona === "string" ? body.persona.trim() : "";
  if (personaRaw.length > MAX_PERSONA_CHARS) {
    return { ok: false, error: { status: 400, error: "invalid_persona" } };
  }
  const greetingRaw = typeof body.greeting === "string" ? body.greeting.trim() : "";
  const objective = typeof body.objective === "string" ? body.objective.trim() : "";
  const spokenAskRaw = typeof body.spokenAsk === "string" ? body.spokenAsk.trim() : "";
  if (greetingRaw.length > 2000) {
    return { ok: false, error: { status: 400, error: "invalid_greeting" } };
  }
  if (spokenAskRaw.length > 500) {
    return { ok: false, error: { status: 400, error: "invalid_spokenAsk" } };
  }
  if (!objective || objective.length > 4000) {
    return { ok: false, error: { status: 400, error: "invalid_objective" } };
  }
  const extra = typeof body.instructions === "string" ? body.instructions.trim() : "";
  if (body.waitForCallee !== undefined && body.waitForCallee !== null && typeof body.waitForCallee !== "boolean") {
    return { ok: false, error: { status: 400, error: "invalid_waitForCallee" } };
  }
  if (body.ivr !== undefined && body.ivr !== null && typeof body.ivr !== "boolean") {
    return { ok: false, error: { status: 400, error: "invalid_ivr" } };
  }
  let grokVoice: string | undefined;
  const grokVoiceParsed = parseGrokVoice(body.grok_voice);
  if (!grokVoiceParsed.ok) {
    return {
      ok: false,
      error: {
        status: 400,
        error: "invalid_grok_voice",
        details: `grok_voice must be ${GROK_VOICE_LIST}`,
      },
    };
  }
  if (body.grok_voice !== undefined && body.grok_voice !== null && body.grok_voice !== "") {
    grokVoice = grokVoiceParsed.value;
  }
  let timezone = DEFAULT_TIMEZONE;
  if (body.timezone !== undefined && body.timezone !== null && body.timezone !== "") {
    if (typeof body.timezone !== "string" || !isValidTimeZone(body.timezone.trim())) {
      return {
        ok: false,
        error: {
          status: 400,
          error: "invalid_timezone",
          details: "IANA timezone required, e.g. Europe/Lisbon",
        },
      };
    }
    timezone = body.timezone.trim();
  }
  const waitForCallee =
    body.waitForCallee === true || (body.waitForCallee !== false && instructionsRequestWait(extra));
  const ivr = body.ivr === true;
  const greeting = composeSpokenGreeting({
    language,
    ...(personaRaw ? { persona: personaRaw } : {}),
    ...(greetingRaw ? { greeting: greetingRaw } : {}),
    objective,
    ...(spokenAskRaw ? { spokenAsk: spokenAskRaw } : {}),
    timezone,
    now: opts.now ?? new Date(),
  });
  const metadata =
    body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
      ? (body.metadata as Record<string, unknown>)
      : undefined;
  const maxDurationSeconds =
    typeof body.maxDurationSeconds === "number" && Number.isFinite(body.maxDurationSeconds)
      ? Math.min(Math.max(30, Math.floor(body.maxDurationSeconds)), 1800)
      : undefined;
  return {
    ok: true,
    value: {
      to,
      language,
      greeting,
      objective,
      waitForCallee,
      timezone,
      botRole: botRoleParsed.value,
      calleeRole: calleeRoleParsed.value,
      ttsProvider: ttsProviderParsed.value,
      ivr,
      ...(openaiVoice ? { openaiVoice } : {}),
      ...(grokVoice ? { grokVoice } : {}),
      ...(personaRaw ? { persona: personaRaw } : {}),
      ...(extra ? { extraInstructions: extra } : {}),
      ...(metadata ? { metadata } : {}),
      ...(maxDurationSeconds !== undefined ? { maxDurationSeconds } : {}),
    },
  };
}

export async function placeOutboundCall(opts: {
  config: AppConfig;
  telnyx: TelnyxClient;
  store: CallStore;
  body: OutboundBody;
  openaiSessions?: OpenAISessionStore;
  connectOpenAI?: ConnectOpenAI;
  onCallEnded?: (call: CallRecord) => void;
  fetchImpl?: typeof fetch;
  greetingAudioCache?: GreetingAudioCache;
  elevenLabsTts?: ElevenLabsTts;
  onCallCreated?: (call: CallRecord) => void;
  onDialFailed?: (call: CallRecord) => void;
}): Promise<{ call: CallRecord } | { error: OutboundError }> {
  if (!opts.config.ready.outbound) {
    return { error: { status: 503, error: "outbound_not_ready", details: opts.config.ready } };
  }
  const parsed = parseOutboundBody(opts.body);
  if (!parsed.ok) return { error: parsed.error };
  if (parsed.value.ttsProvider === "elevenlabs" && !opts.config.elevenlabs.configured) {
    return {
      error: {
        status: 503,
        error: "elevenlabs_not_configured",
        details: "ELEVENLABS_API_KEY is required for tts_provider=elevenlabs (set on Railway)",
      },
    };
  }
  if (ttsProviderUsesOpenAISession(parsed.value.ttsProvider) && !opts.config.openai.configured) {
    return {
      error: {
        status: 503,
        error: "openai_not_configured",
        details: `OPENAI_API_KEY is required for tts_provider=${parsed.value.ttsProvider} (set on Railway)`,
      },
    };
  }
  if (parsed.value.ttsProvider === "elevenlabs") {
    console.info(
      `[outbound] tts_provider=elevenlabs; Telnyx playback is ElevenLabs voice ${opts.config.elevenlabs.voiceId} (Grok STT/dialogue only)`,
    );
  }
  if (parsed.value.ttsProvider === "openai") {
    console.info(
      `[outbound] tts_provider=openai; Telnyx speech-to-speech is OpenAI Realtime ${opts.config.openai.model} voice ${parsed.value.openaiVoice ?? opts.config.openai.voice}`,
    );
  }
  if (parsed.value.ttsProvider === "gpt-live") {
    console.info(
      `[outbound] tts_provider=gpt-live; Telnyx speech-to-speech is GPT-Live ${opts.config.openai.liveModel} voice ${parsed.value.openaiVoice ?? opts.config.openai.liveVoice} (pt-PT lock in instructions)`,
    );
  }

  const spokenVoice = spokenVoiceFor(parsed.value, opts.config);
  if (parsed.value.ttsProvider === "grok") {
    console.info(`[outbound] tts_provider=grok; Telnyx voice is Grok ${spokenVoice}`);
  }
  const model = modelFor(parsed.value.ttsProvider, opts.config);

  const id = randomUUID();
  const streamToken = randomBytes(24).toString("base64url");
  const call: CallRecord = {
    id,
    status: "dialing",
    to: parsed.value.to,
    from: opts.config.fromNumber,
    language: parsed.value.language,
    greeting: parsed.value.greeting,
    objective: parsed.value.objective,
    ...(parsed.value.waitForCallee ? { waitForCallee: true } : {}),
    timezone: parsed.value.timezone,
    botRole: parsed.value.botRole,
    calleeRole: parsed.value.calleeRole,
    ttsProvider: parsed.value.ttsProvider,
    ...(parsed.value.persona ? { persona: parsed.value.persona } : {}),
    ...(parsed.value.ivr ? { ivr: true } : {}),
    voice: spokenVoice,
    model,
    streamToken,
    telnyx: {},
    transcript: [],
    createdAt: new Date().toISOString(),
    ...(parsed.value.extraInstructions
      ? { extraInstructions: parsed.value.extraInstructions }
      : {}),
    ...(parsed.value.metadata ? { metadata: parsed.value.metadata } : {}),
  };

  let openaiSession: Awaited<ReturnType<typeof prewarmOpenAISession>> | undefined;
  if (parsed.value.ttsProvider === "openai") {
    try {
      openaiSession = await prewarmOpenAISession({
        call,
        config: opts.config,
        telnyx: opts.telnyx,
        ...(opts.connectOpenAI ? { connectOpenAI: opts.connectOpenAI } : {}),
        ...(opts.onCallEnded ? { onEnded: opts.onCallEnded } : {}),
      });
    } catch (err) {
      const sessionErr = err instanceof OpenAISessionError ? err : undefined;
      return {
        error: {
          status: 503,
          error: sessionErr?.code ?? "openai_session_failed",
          details: err instanceof Error ? err.message : String(err),
        },
      };
    }
  } else if (parsed.value.ttsProvider === "gpt-live") {
    try {
      openaiSession = await prewarmGptLiveSession({
        call,
        config: opts.config,
        telnyx: opts.telnyx,
        ...(opts.connectOpenAI ? { connectOpenAI: opts.connectOpenAI } : {}),
        ...(opts.onCallEnded ? { onEnded: opts.onCallEnded } : {}),
      });
    } catch (err) {
      const sessionErr = err instanceof OpenAISessionError ? err : undefined;
      return {
        error: {
          status: 503,
          error: sessionErr?.code ?? "gpt_live_session_failed",
          details: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  opts.store.create(call);
  if (openaiSession && opts.openaiSessions) {
    opts.openaiSessions.set(call.id, openaiSession);
  } else if (!ttsProviderUsesOpenAISession(parsed.value.ttsProvider)) {
    opts.onCallCreated?.(call);
  }

  if (
    call.ttsProvider === "elevenlabs" &&
    opts.config.elevenlabs.configured &&
    opts.greetingAudioCache
  ) {
    const tts = opts.elevenLabsTts ?? createElevenLabsTts(opts.config.elevenlabs, opts.fetchImpl ?? fetch);
    console.info(`[call ${call.id}] el_latency stage=prefetch_start turn=greeting source=dial`);
    opts.greetingAudioCache.startIfNeeded({
      callId: call.id,
      text: call.greeting,
      language: call.language,
      tts,
      onHttpStart: () =>
        console.info(`[call ${call.id}] el_latency stage=el_http_start turn=greeting source=dial`),
      onFirstByte: () =>
        console.info(`[call ${call.id}] el_latency stage=el_first_byte turn=greeting source=dial`),
    });
  }

  try {
    const dialed = await opts.telnyx.dial({
      connection_id: opts.config.telnyxConnectionId,
      to: call.to,
      from: call.from,
      stream_url: opts.config.mediaStreamUrl(call.id, call.streamToken),
      stream_track: "inbound_track",
      stream_bidirectional_mode: "rtp",
      stream_bidirectional_codec: "PCMU",
      stream_bidirectional_target_legs: "self",
      webhook_url: opts.config.webhookUrl,
      client_state: Buffer.from(call.id, "utf8").toString("base64"),
    });
    opts.store.indexControlId(call, dialed.call_control_id);
    call.telnyx.callLegId = dialed.call_leg_id;
    call.telnyx.callSessionId = dialed.call_session_id;
    return { call };
  } catch (err) {
    openaiSession?.close();
    opts.openaiSessions?.close(call.id);
    opts.greetingAudioCache?.abort(call.id);
    opts.onDialFailed?.(call);
    call.status = "failed";
    call.endedReason = "dial_failed";
    call.endedAt = new Date().toISOString();
    call.error = err instanceof Error ? err.message : String(err);
    return { error: { status: 502, error: "telnyx_dial_failed", details: call.error } };
  }
}

function spokenVoiceFor(
  parsed: {
    ttsProvider: TtsProvider;
    openaiVoice?: string;
    grokVoice?: string;
  },
  config: AppConfig,
): string {
  switch (parsed.ttsProvider) {
    case "openai":
      return parsed.openaiVoice ?? config.openai.voice;
    case "gpt-live":
      return parsed.openaiVoice ?? config.openai.liveVoice;
    case "grok":
    case "elevenlabs":
      return parsed.grokVoice ?? config.grokVoice;
    default: {
      const _never: never = parsed.ttsProvider;
      throw new Error(`unsupported tts provider: ${_never}`);
    }
  }
}

function modelFor(provider: TtsProvider, config: AppConfig): string {
  switch (provider) {
    case "openai":
      return config.openai.model;
    case "gpt-live":
      return config.openai.liveModel;
    case "grok":
    case "elevenlabs":
      return config.grokModel;
    default: {
      const _never: never = provider;
      throw new Error(`unsupported tts provider: ${_never}`);
    }
  }
}
