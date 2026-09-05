import { buildSessionInstructions, type Language } from "../prompt.js";
import type { TurnDetectionSettings } from "../grok/session.js";
import { DEFAULT_TURN_DETECTION } from "../grok/session.js";
import { DEFAULT_OPENAI_VOICE } from "../tts.js";

export const OPENAI_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
] as const;
export type OpenAIVoice = (typeof OPENAI_VOICES)[number];

export type OpenAIAudioFormat = { type: "audio/pcmu" };

export type OpenAITurnDetection = {
  type: "server_vad";
  threshold: number;
  prefix_padding_ms: number;
  silence_duration_ms: number;
  create_response: boolean;
  interrupt_response: boolean;
  idle_timeout_ms?: number;
};

export type OpenAIFunctionTool = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type OpenAISessionUpdate = {
  type: "session.update";
  session: {
    type: "realtime";
    model: string;
    output_modalities: ["audio"];
    instructions: string;
    audio: {
      input: {
        format: OpenAIAudioFormat;
        transcription: {
          model: string;
          language: string;
          prompt: string;
        };
        turn_detection: OpenAITurnDetection;
      };
      output: {
        format: OpenAIAudioFormat;
        voice: string;
      };
    };
    tools: OpenAIFunctionTool[];
    tool_choice: "auto";
  };
};

export type OpenAIGreetingResponseCreate = {
  type: "response.create";
  event_id: string;
  response: {
    conversation: "none";
    output_modalities: ["audio"];
    metadata: { purpose: "greeting" };
    instructions: string;
  };
};

const END_CALL_TOOL: OpenAIFunctionTool = {
  type: "function",
  name: "end_call",
  description:
    "Hang up only after you have fully spoken the goodbye or summary. Never cut a sentence short. Use when the objective is complete, declined, or impossible.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      reason: { type: "string", description: "Short reason the call is ending." },
    },
  },
};

export function isOpenAIVoice(value: string): value is OpenAIVoice {
  return (OPENAI_VOICES as readonly string[]).includes(value);
}

export function parseOpenAIVoice(value: unknown): { ok: true; value: OpenAIVoice } | { ok: false } {
  if (value === undefined || value === null || value === "") {
    return { ok: true, value: DEFAULT_OPENAI_VOICE };
  }
  if (typeof value !== "string") return { ok: false };
  const normalized = value.trim().toLowerCase();
  if (!isOpenAIVoice(normalized)) return { ok: false };
  return { ok: true, value: normalized };
}

export function openaiRealtimeUrl(openaiBaseUrl: string, model: string): string {
  const https = openaiBaseUrl.replace(/\/+$/, "");
  const wss = https.startsWith("https://")
    ? `wss://${https.slice("https://".length)}`
    : https.startsWith("http://")
      ? `ws://${https.slice("http://".length)}`
      : https.startsWith("wss://") || https.startsWith("ws://")
        ? https
        : `wss://${https}`;
  return `${wss}/v1/realtime?model=${encodeURIComponent(model)}`;
}

export function openaiTurnDetection(
  settings: TurnDetectionSettings = DEFAULT_TURN_DETECTION,
  opts: { createResponse?: boolean; includeIdleTimeout?: boolean } = {},
): OpenAITurnDetection {
  const createResponse = opts.createResponse === true;
  const includeIdleTimeout = opts.includeIdleTimeout === true;
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

export function openaiTranscriptionLanguage(language: Language): string {
  switch (language) {
    case "pt-PT":
      return "pt";
    case "en-GB":
    case "en-US":
      return "en";
    default: {
      const _never: never = language;
      throw new Error(`unsupported language: ${_never}`);
    }
  }
}

export function openaiTranscriptionPrompt(language: Language): string {
  switch (language) {
    case "pt-PT":
      return "Português europeu de Portugal (pt-PT, Lisboa). Nunca português do Brasil. Vocabulário: telemóvel, ecrã, autocarro, pequeno-almoço, estou, alô.";
    case "en-GB":
      return "British English (UK).";
    case "en-US":
      return "American English (US).";
    default: {
      const _never: never = language;
      throw new Error(`unsupported language: ${_never}`);
    }
  }
}

export function openaiSessionUpdatePayload(input: {
  voice: string;
  model: string;
  language: Language;
  greeting: string;
  objective: string;
  extraInstructions?: string;
  waitForCallee?: boolean;
  timezone?: string;
  turnDetection?: TurnDetectionSettings;
  createResponse?: boolean;
  includeIdleTimeout?: boolean;
  botRole?: string;
  calleeRole?: string;
}): OpenAISessionUpdate {
  const waitForCallee = input.waitForCallee === true;
  const createResponse = input.createResponse ?? false;
  const includeIdleTimeout = input.includeIdleTimeout ?? false;
  return {
    type: "session.update",
    session: {
      type: "realtime",
      model: input.model,
      output_modalities: ["audio"],
      instructions: buildSessionInstructions({
        language: input.language,
        greeting: input.greeting,
        objective: input.objective,
        ...(input.extraInstructions !== undefined ? { extraInstructions: input.extraInstructions } : {}),
        ...(waitForCallee ? { waitForCallee: true } : {}),
        ...(input.timezone ? { timezone: input.timezone } : {}),
        ...(input.botRole ? { botRole: input.botRole } : {}),
        ...(input.calleeRole ? { calleeRole: input.calleeRole } : {}),
      }),
      audio: {
        input: {
          format: { type: "audio/pcmu" },
          transcription: {
            model: "gpt-4o-mini-transcribe",
            language: openaiTranscriptionLanguage(input.language),
            prompt: openaiTranscriptionPrompt(input.language),
          },
          turn_detection: openaiTurnDetection(input.turnDetection ?? DEFAULT_TURN_DETECTION, {
            createResponse,
            includeIdleTimeout,
          }),
        },
        output: {
          format: { type: "audio/pcmu" },
          voice: input.voice,
        },
      },
      tools: [END_CALL_TOOL],
      tool_choice: "auto",
    },
  };
}

export function openaiGreetingResponseCreate(input: {
  callId: string;
  language: Language;
  greeting: string;
}): OpenAIGreetingResponseCreate {
  return {
    type: "response.create",
    event_id: `greeting-${input.callId}`,
    response: {
      conversation: "none",
      output_modalities: ["audio"],
      metadata: { purpose: "greeting" },
      instructions: openaiGreetingSpeakInstructions(input.language, input.greeting),
    },
  };
}

export function openaiGreetingSpeakInstructions(language: Language, greeting: string): string {
  switch (language) {
    case "pt-PT":
      return `Diz palavra por palavra, com voz de telefone humana, calorosa e expressiva, em português europeu de Portugal (nunca brasileiro), exactamente este texto e nada mais:\n\n«${greeting}»`;
    case "en-GB":
    case "en-US":
      return `Speak this greeting word for word, with a warm expressive human phone voice. Do not add anything before or after:\n\n"${greeting}"`;
    default: {
      const _never: never = language;
      throw new Error(`unsupported language: ${_never}`);
    }
  }
}

export function openaiAssistantGreetingItem(greeting: string): {
  type: "conversation.item.create";
  item: {
    type: "message";
    role: "assistant";
    content: Array<{ type: "output_text"; text: string }>;
  };
} {
  return {
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: greeting }],
    },
  };
}
