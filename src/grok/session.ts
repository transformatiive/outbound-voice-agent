import { buildSessionInstructions, languageHint, type Language } from "../prompt.js";

export type GrokFunctionTool = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type TurnDetectionSettings = {
  threshold: number;
  silenceDurationMs: number;
  prefixPaddingMs: number;
  idleTimeoutMs: number;
};

export type GrokTurnDetection = {
  type: "server_vad";
  threshold: number;
  silence_duration_ms: number;
  prefix_padding_ms: number;
  idle_timeout_ms?: number;
  create_response: boolean;
  interrupt_response: boolean;
};

export type TurnDetectionOptions = {
  /** When false, VAD still emits speech events but Grok must not auto-speak. */
  createResponse?: boolean;
  /** When false, omit idle_timeout_ms so Grok cannot proactive-check-in. */
  includeIdleTimeout?: boolean;
};

/**
 * Phone-tuned server_vad. silence_duration_ms 160 (was 220) so the agent
 * starts speaking as soon as the callee stops. Override with GROK_VAD_SILENCE_MS.
 * prefix_padding_ms 200 keeps barge-in audio; idle_timeout_ms is hang-idle, not turn gap.
 * create_response is explicit: false until the scripted greeting has finished.
 */
export const DEFAULT_TURN_DETECTION: TurnDetectionSettings = {
  threshold: 0.5,
  silenceDurationMs: 160,
  prefixPaddingMs: 200,
  idleTimeoutMs: 12_000,
};

/** Documented xAI session.audio.output.speed range is 0.7–1.5. Slight liveliness nudge above API default 1.0. */
export const DEFAULT_OUTPUT_SPEED = 1.05;

export type GrokSessionUpdate = {
  type: "session.update";
  session: {
    voice: string;
    instructions: string;
    turn_detection: GrokTurnDetection;
    reasoning: { effort: "none" | "high" };
    audio: {
      input: {
        format: { type: "audio/pcmu" };
        transcription: { language_hint: string };
      };
      output: { format: { type: "audio/pcmu" }; speed: number };
    };
    tools: GrokFunctionTool[];
    tool_choice: "auto";
  };
};

export function grokRealtimeUrl(xaiBaseUrl: string, model: string): string {
  const https = xaiBaseUrl.replace(/\/+$/, "");
  const wss = https.startsWith("https://")
    ? `wss://${https.slice("https://".length)}`
    : https.startsWith("http://")
      ? `ws://${https.slice("http://".length)}`
      : https.startsWith("wss://") || https.startsWith("ws://")
        ? https
        : `wss://${https}`;
  return `${wss}/v1/realtime?model=${encodeURIComponent(model)}`;
}

export function grokTurnDetection(
  settings: TurnDetectionSettings = DEFAULT_TURN_DETECTION,
  opts: TurnDetectionOptions = {},
): GrokTurnDetection {
  const createResponse = opts.createResponse !== false;
  const includeIdleTimeout = opts.includeIdleTimeout !== false;
  return {
    type: "server_vad",
    threshold: settings.threshold,
    silence_duration_ms: settings.silenceDurationMs,
    prefix_padding_ms: settings.prefixPaddingMs,
    ...(includeIdleTimeout ? { idle_timeout_ms: settings.idleTimeoutMs } : {}),
    create_response: createResponse,
    interrupt_response: true,
  };
}

export function sessionUpdatePayload(input: {
  voice: string;
  language: Language;
  greeting: string;
  objective: string;
  extraInstructions?: string;
  waitForCallee?: boolean;
  timezone?: string;
  timeGreeting?: string;
  turnDetection?: TurnDetectionSettings;
  createResponse?: boolean;
  includeIdleTimeout?: boolean;
  outputSpeed?: number;
}): GrokSessionUpdate {
  const waitForCallee = input.waitForCallee === true;
  const createResponse = input.createResponse ?? !waitForCallee;
  const includeIdleTimeout = input.includeIdleTimeout ?? !waitForCallee;
  const outputSpeed = input.outputSpeed ?? DEFAULT_OUTPUT_SPEED;
  return {
    type: "session.update",
    session: {
      voice: input.voice,
      instructions: buildSessionInstructions(input),
      turn_detection: grokTurnDetection(input.turnDetection ?? DEFAULT_TURN_DETECTION, {
        createResponse,
        includeIdleTimeout,
      }),
      reasoning: { effort: "none" },
      audio: {
        input: {
          format: { type: "audio/pcmu" },
          transcription: { language_hint: languageHint(input.language) },
        },
        output: { format: { type: "audio/pcmu" }, speed: outputSpeed },
      },
      tools: [
        {
          type: "function",
          name: "end_call",
          description:
            "Hang up after you have said goodbye. Use when the objective is complete, declined, or impossible.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              reason: { type: "string", description: "Short reason the call is ending." },
            },
          },
        },
      ],
      tool_choice: "auto",
    },
  };
}
