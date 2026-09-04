import { buildSessionInstructions, languageHint, type Language } from "../prompt.js";

export type GrokFunctionTool = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
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

export function sessionUpdatePayload(input: {
  voice: string;
  language: Language;
  greeting: string;
  objective: string;
  extraInstructions?: string;
  waitForCallee?: boolean;
}): GrokSessionUpdate {
  return {
    type: "session.update",
    session: {
      voice: input.voice,
      instructions: buildSessionInstructions(input),
      turn_detection: {
        type: "server_vad",
        threshold: 0.85,
        silence_duration_ms: 700,
        prefix_padding_ms: 300,
        idle_timeout_ms: 12_000,
      },
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
