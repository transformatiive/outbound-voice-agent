import { randomBytes, randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { defaultGreeting, isLanguage, type Language } from "./prompt.js";
import type { CallRecord } from "./calls/types.js";
import type { TelnyxClient } from "./telnyx/client.js";
import { CallStore } from "./calls/store.js";

const E164 = /^\+[1-9]\d{7,14}$/;

export type OutboundBody = {
  to?: unknown;
  language?: unknown;
  greeting?: unknown;
  objective?: unknown;
  instructions?: unknown;
  metadata?: unknown;
  maxDurationSeconds?: unknown;
};

export type OutboundError = { status: number; error: string; details?: unknown };

export function parseOutboundBody(body: OutboundBody): 
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
  const greetingRaw = typeof body.greeting === "string" ? body.greeting.trim() : "";
  const greeting = greetingRaw || defaultGreeting(language);
  const objective = typeof body.objective === "string" ? body.objective.trim() : "";
  if (greeting.length > 2000) {
    return { ok: false, error: { status: 400, error: "invalid_greeting" } };
  }
  if (!objective || objective.length > 4000) {
    return { ok: false, error: { status: 400, error: "invalid_objective" } };
  }
  const extra = typeof body.instructions === "string" ? body.instructions.trim() : "";
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
