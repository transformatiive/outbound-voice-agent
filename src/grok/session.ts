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

/**
 * Phone-tuned server_vad. silence_duration_ms 350 (was 700) so the agent
 * starts speaking ~0.3s after the callee stops, not ~1–2s later.
 * prefix_padding_ms 200 keeps barge-in audio; idle_timeout_ms is hang-idle, not turn gap.
 */
export const DEFAULT_TURN_DETECTION: TurnDetectionSettings = {
  threshold: 0.5,
  silenceDurationMs: 350,
  prefixPaddingMs: 200,
  idleTimeoutMs: 12_000,
};

export type GrokSessionUpdate = {
  type: "session.update";
  session: {
    voice: string;
    instructions: string;
    turn_detection: {
      type: "server_vad";
      threshold: number;
      silence_duration_ms: number;
      prefix_padding_ms: number;
      idle_timeout_ms: number;
    };
    reasoning: { effort: "none" | "high" };
    audio: {
      input: {
        format: { type: "audio/pcmu" };
        transcription: { language_hint: string };
      };
      output: { format: { type: "audio/pcmu" } };
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

export function grokTurnDetection(settings: TurnDetectionSettings = DEFAULT_TURN_DETECTION): {
  type: "server_vad";
  threshold: number;
  silence_duration_ms: number;
  prefix_padding_ms: number;
  idle_timeout_ms: number;
} {
  return {
    type: "server_vad",
    threshold: settings.threshold,
    silence_duration_ms: settings.silenceDurationMs,
    prefix_padding_ms: settings.prefixPaddingMs,
    idle_timeout_ms: settings.idleTimeoutMs,
  };
}

export function sessionUpdatePayload(input: {
  voice: string;
  language: Language;
  greeting: string;
  objective: string;
  extraInstructions?: string;
  waitForCallee?: boolean;
  turnDetection?: TurnDetectionSettings;
}): GrokSessionUpdate {
  return {
    type: "session.update",
    session: {
      voice: input.voice,
      instructions: buildSessionInstructions(input),
      turn_detection: grokTurnDetection(input.turnDetection ?? DEFAULT_TURN_DETECTION),
      reasoning: { effort: "none" },
      audio: {
        input: {
          format: { type: "audio/pcmu" },
          transcription: { language_hint: languageHint(input.language) },
        },
        output: { format: { type: "audio/pcmu" } },
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
