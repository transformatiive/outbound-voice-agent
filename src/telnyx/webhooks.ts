import type { CallRecord, CallStatus } from "../calls/types.js";
import type { TelnyxClient } from "./client.js";

export type TelnyxWebhookEnvelope = {
  data?: {
    event_type?: string;
    id?: string;
    payload?: {
      call_control_id?: string;
      call_leg_id?: string;
      call_session_id?: string;
      client_state?: string;
      hangup_cause?: string;
      hangup_source?: string;
      state?: string;
    };
  };
};

export function decodeClientState(clientState: string | undefined): string | undefined {
  if (!clientState) return undefined;
  try {
    const decoded = Buffer.from(clientState, "base64").toString("utf8");
    return decoded || undefined;
  } catch {
    return undefined;
  }
}

export function statusFromHangup(cause: string | undefined, source: string | undefined): {
  status: CallStatus;
  endedReason: string;
} {
  const c = (cause ?? "").toLowerCase();
  const s = (source ?? "").toLowerCase();
  switch (c) {
    case "user_busy":
    case "busy":
      return { status: "busy", endedReason: "busy" };
    case "no_answer":
    case "timeout":
      return { status: "no_answer", endedReason: "no_answer" };
    case "call_rejected":
    case "not_found":
    case "unallocated_number":
      return { status: "failed", endedReason: c };
    default:
      break;
  }
  if (s === "callee") return { status: "completed", endedReason: "callee_hangup" };
  if (s === "caller") return { status: "completed", endedReason: "caller_hangup" };
  return { status: "completed", endedReason: c || "hangup" };
}

export function applyTelnyxEvent(
  call: CallRecord,
  envelope: TelnyxWebhookEnvelope,
  now: () => string,
): void {
  const eventType = envelope.data?.event_type ?? "";
  const payload = envelope.data?.payload ?? {};
  if (payload.call_leg_id) call.telnyx.callLegId = payload.call_leg_id;
  if (payload.call_session_id) call.telnyx.callSessionId = payload.call_session_id;
  if (payload.call_control_id) call.telnyx.callControlId = payload.call_control_id;

  switch (eventType) {
    case "call.initiated":
      if (!isTerminal(call.status)) call.status = "dialing";
      return;
    case "call.ringing":
      if (!isTerminal(call.status) && call.status === "dialing") call.status = "ringing";
      return;
    case "call.answered":
      if (!isTerminal(call.status)) {
        call.status = "answered";
        call.answeredAt = call.answeredAt ?? now();
      }
      return;
    case "streaming.started":
      if (!isTerminal(call.status)) {
        call.status = "in_progress";
        call.answeredAt = call.answeredAt ?? now();
      }
      return;
    case "call.hangup":
    case "call.hangup.received":
      if (isTerminal(call.status)) return;
      {
        const mapped = statusFromHangup(payload.hangup_cause, payload.hangup_source);
        call.status = mapped.status;
        call.endedReason = call.endedReason ?? mapped.endedReason;
        call.endedAt = now();
      }
      return;
    default:
      return;
  }
}

function isTerminal(status: CallStatus): boolean {
  switch (status) {
    case "completed":
    case "failed":
    case "no_answer":
    case "busy":
      return true;
    case "dialing":
    case "ringing":
    case "answered":
    case "in_progress":
      return false;
    default: {
      const _never: never = status;
      return _never;
    }
  }
}

export async function hangupCall(telnyx: TelnyxClient, call: CallRecord): Promise<void> {
  const id = call.telnyx.callControlId;
  if (!id) return;
  await telnyx.hangup(id);
}
