import { randomBytes, randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { DEFAULT_TIMEZONE, composeSpokenGreeting, isValidTimeZone } from "./greeting.js";
import { instructionsRequestWait, isLanguage, type Language } from "./prompt.js";
import { DEFAULT_BOT_ROLE, DEFAULT_CALLEE_ROLE, parseRoleLabel } from "./roles.js";
import { parseTtsProvider, type TtsProvider } from "./tts.js";
import type { CallRecord } from "./calls/types.js";
import type { TelnyxClient } from "./telnyx/client.js";
import { CallStore } from "./calls/store.js";

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
      error: { status: 400, error: "invalid_tts_provider", details: "tts_provider must be grok | elevenlabs" },
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
  if (parsed.value.ttsProvider === "elevenlabs") {
    console.info(
      `[outbound] tts_provider=elevenlabs requested; audio pipeline still grok (voice ${opts.config.grokVoice}) until ElevenLabs TTS is wired`,
    );
  }

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
    voice: opts.config.grokVoice,
    model: opts.config.grokModel,
    streamToken,
    telnyx: {},
    transcript: [],
    createdAt: new Date().toISOString(),
    ...(parsed.value.extraInstructions
      ? { extraInstructions: parsed.value.extraInstructions }
      : {}),
    ...(parsed.value.metadata ? { metadata: parsed.value.metadata } : {}),
  };
  opts.store.create(call);

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
    call.status = "failed";
    call.endedReason = "dial_failed";
    call.endedAt = new Date().toISOString();
    call.error = err instanceof Error ? err.message : String(err);
    return { error: { status: 502, error: "telnyx_dial_failed", details: call.error } };
  }
}
