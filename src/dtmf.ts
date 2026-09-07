import type { TelnyxClient } from "./telnyx/client.js";

export const DTMF_DIGITS_RE = /^[0-9A-D*#]+$/i;
export const MAX_DTMF_DIGITS = 32;

export const SEND_DTMF_TOOL_DESCRIPTION =
  "Send DTMF keypad tones on the live phone call (0-9, *, #, A-D). Use when an IVR or automated menu asks you to press keys. Never speak the numbers as words. After sending, stay silent and keep listening for the next prompt. Do not hang up.";

export type RealtimeFunctionTool = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export const SEND_DTMF_TOOL: RealtimeFunctionTool = {
  type: "function",
  name: "send_dtmf",
  description: SEND_DTMF_TOOL_DESCRIPTION,
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["digits"],
    properties: {
      digits: {
        type: "string",
        description: "Keypad digits to send (0-9, A-D, *, #). No spaces. Max 32 characters.",
        pattern: "^[0-9A-Da-d*#]+$",
        minLength: 1,
        maxLength: MAX_DTMF_DIGITS,
      },
    },
  },
};

export function parseDtmfDigits(value: unknown): { ok: true; digits: string } | { ok: false; error: string } {
  if (typeof value !== "string") return { ok: false, error: "invalid_digits" };
  const digits = value.trim().replace(/\s+/g, "");
  if (!digits || digits.length > MAX_DTMF_DIGITS) return { ok: false, error: "invalid_digits" };
  if (!DTMF_DIGITS_RE.test(digits)) return { ok: false, error: "invalid_digits" };
  return { ok: true, digits: digits.toUpperCase() };
}

export function digitsFromToolArguments(raw: unknown): unknown {
  let args = raw;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args) as unknown;
    } catch {
      return undefined;
    }
  }
  if (args && typeof args === "object" && !Array.isArray(args) && "digits" in args) {
    return (args as { digits: unknown }).digits;
  }
  return undefined;
}

export type SendDtmfResult = { ok: true; digits: string } | { ok: false; error: string };

export async function executeSendDtmf(opts: {
  telnyx: TelnyxClient;
  callControlId: string | undefined;
  callId: string;
  arguments: unknown;
}): Promise<SendDtmfResult> {
  const parsed = parseDtmfDigits(digitsFromToolArguments(opts.arguments));
  if (!parsed.ok) return parsed;
  if (!opts.callControlId) return { ok: false, error: "missing_call_control_id" };
  if (!opts.telnyx.sendDtmf) return { ok: false, error: "send_dtmf_unavailable" };
  console.info(`[call ${opts.callId}] send_dtmf digits=${parsed.digits}`);
  try {
    await opts.telnyx.sendDtmf(opts.callControlId, parsed.digits);
    return { ok: true, digits: parsed.digits };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[call ${opts.callId}] send_dtmf failed`, message);
    return { ok: false, error: "send_dtmf_failed" };
  }
}

type JsonObject = Record<string, unknown>;

export function functionCallFromEvent(event: JsonObject): {
  name: string;
  callId: string;
  arguments: unknown;
} {
  const item = event.item && typeof event.item === "object" ? (event.item as JsonObject) : undefined;
  return {
    name: String(event.name ?? item?.name ?? ""),
    callId: String(event.call_id ?? item?.call_id ?? ""),
    arguments: event.arguments ?? item?.arguments,
  };
}

export async function handleRealtimeToolCall(opts: {
  event: JsonObject;
  alreadyHandled: Set<string>;
  telnyx: TelnyxClient;
  callControlId: string | undefined;
  callId: string;
  sendOutput: (toolCallId: string, output: string) => void;
  onEndCall: () => Promise<void>;
  onDtmfContinue: () => void;
  clearPlayback?: () => void;
}): Promise<void> {
  const { name, callId, arguments: args } = functionCallFromEvent(opts.event);
  if (!name) return;
  if (callId && opts.alreadyHandled.has(callId)) return;
  if (name === "send_dtmf") {
    if (callId) opts.alreadyHandled.add(callId);
    opts.clearPlayback?.();
    const result = await executeSendDtmf({
      telnyx: opts.telnyx,
      callControlId: opts.callControlId,
      callId: opts.callId,
      arguments: args,
    });
    if (callId) opts.sendOutput(callId, JSON.stringify(result));
    opts.onDtmfContinue();
    return;
  }
  if (name !== "end_call") return;
  if (callId) opts.alreadyHandled.add(callId);
  if (callId) opts.sendOutput(callId, JSON.stringify({ ok: true }));
  await opts.onEndCall();
}
