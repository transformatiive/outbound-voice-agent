import type { Language } from "../prompt.js";
import { DEFAULT_BOT_ROLE, DEFAULT_CALLEE_ROLE } from "../roles.js";
import { DEFAULT_TTS_PROVIDER, type TtsProvider } from "../tts.js";

export type CallStatus =
  | "dialing"
  | "ringing"
  | "answered"
  | "in_progress"
  | "completed"
  | "failed"
  | "no_answer"
  | "busy";

export type TranscriptLine = {
  role: "user" | "assistant";
  text: string;
};

export type CallRecord = {
  id: string;
  status: CallStatus;
  to: string;
  from: string;
  language: Language;
  greeting: string;
  objective: string;
  waitForCallee?: boolean;
  timezone?: string;
  extraInstructions?: string;
  persona?: string;
  botRole?: string;
  calleeRole?: string;
  ttsProvider?: TtsProvider;
  metadata?: Record<string, unknown>;
  voice: string;
  model: string;
  streamToken: string;
  telnyx: {
    callControlId?: string;
    callLegId?: string;
    callSessionId?: string;
  };
  transcript: TranscriptLine[];
  endedReason?: string;
  createdAt: string;
  answeredAt?: string;
  endedAt?: string;
  error?: string;
};

export type PublicCall = {
  id: string;
  status: CallStatus;
  to: string;
  from: string;
  language: Language;
  greeting: string;
  objective: string;
  waitForCallee: boolean;
  persona?: string;
  botRole: string;
  calleeRole: string;
  ttsProvider: TtsProvider;
  voice: string;
  model: string;
  telnyx: {
    callControlId?: string;
    callLegId?: string;
    callSessionId?: string;
  };
  transcript: TranscriptLine[];
  endedReason?: string;
  createdAt: string;
  answeredAt?: string;
  endedAt?: string;
  error?: string;
};

export function toPublicCall(call: CallRecord): PublicCall {
  return {
    id: call.id,
    status: call.status,
    to: call.to,
    from: call.from,
    language: call.language,
    greeting: call.greeting,
    objective: call.objective,
    waitForCallee: call.waitForCallee === true,
    botRole: call.botRole ?? DEFAULT_BOT_ROLE,
    calleeRole: call.calleeRole ?? DEFAULT_CALLEE_ROLE,
    ttsProvider: call.ttsProvider ?? DEFAULT_TTS_PROVIDER,
    voice: call.voice,
    model: call.model,
    telnyx: { ...call.telnyx },
    transcript: [...call.transcript],
    createdAt: call.createdAt,
    ...(call.endedReason !== undefined ? { endedReason: call.endedReason } : {}),
    ...(call.answeredAt !== undefined ? { answeredAt: call.answeredAt } : {}),
    ...(call.endedAt !== undefined ? { endedAt: call.endedAt } : {}),
    ...(call.error !== undefined ? { error: call.error } : {}),
    ...(call.persona !== undefined ? { persona: call.persona } : {}),
  };
}
