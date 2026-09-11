import { END_CALL_TOOL_DESCRIPTION, type Language } from "../prompt.js";
import { SEND_DTMF_TOOL } from "../dtmf.js";
import { DEFAULT_BOT_ROLE, DEFAULT_CALLEE_ROLE } from "../roles.js";
import { DEFAULT_TIMEZONE, timeOfDayGreeting } from "../greeting.js";
import {
  DEFAULT_GPT_LIVE_DELEGATE_MODEL,
  DEFAULT_GPT_LIVE_MODEL,
  DEFAULT_GPT_LIVE_VOICE,
} from "../tts.js";
import { END_CALL_TOOL, OPENAI_VOICES } from "./session.js";

export const GPT_LIVE_VOICES = [
  ...OPENAI_VOICES,
  "quartz",
  "ripple",
  "vesper",
  "willow",
  "stone",
  "gleam",
  "meridian",
  "bossa",
  "tempo",
  "beacon",
  "delta",
  "cinder",
] as const;
export type GptLiveVoice = (typeof GPT_LIVE_VOICES)[number];

export const GPT_LIVE_VOICE_LIST = GPT_LIVE_VOICES.join(" | ");

/** Brazilian Portuguese GPT-Live voices — never the pt-PT default. */
export const GPT_LIVE_BRAZILIAN_VOICES = ["bossa", "tempo"] as const;

export type GptLiveAudioFormat = { type: "audio/pcmu"; rate: 8000 };

export type GptLiveFunctionTool = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type GptLiveSessionStart = {
  type: "session.start";
  event_id?: string;
  session: {
    model: string;
    instructions: string;
    audio: {
      format: GptLiveAudioFormat;
      /** Voice only — GPT-Live has no `speed` field; playback is natural 1.0. */
      output: { voice: string };
    };
    delegation: {
      type: "responses";
      responses: {
        model: string;
        instructions: string;
        tools: GptLiveFunctionTool[];
        tool_choice: "auto";
      };
    };
  };
};

export type GptLiveInstructionsAppend = {
  type: "session.instructions.append";
  event_id: string;
  delegation_id: null;
  content: string;
};

export type GptLiveCommentaryAppend = {
  type: "session.commentary.append";
  event_id: string;
  delegation_id: null;
  content: string;
};

export type GptLiveThinkingAppend = {
  type: "session.thinking.append";
  event_id: string;
  delegation_id: null;
  content: string;
};

export function isGptLiveVoice(value: string): value is GptLiveVoice {
  return (GPT_LIVE_VOICES as readonly string[]).includes(value);
}

export function parseGptLiveVoice(value: unknown): { ok: true; value: GptLiveVoice } | { ok: false } {
  if (value === undefined || value === null || value === "") {
    return { ok: true, value: DEFAULT_GPT_LIVE_VOICE };
  }
  if (typeof value !== "string") return { ok: false };
  const normalized = value.trim().toLowerCase();
  if (!isGptLiveVoice(normalized)) return { ok: false };
  return { ok: true, value: normalized };
}

export function openaiLiveUrl(openaiBaseUrl: string): string {
  const https = openaiBaseUrl.replace(/\/+$/, "");
  const wss = https.startsWith("https://")
    ? `wss://${https.slice("https://".length)}`
    : https.startsWith("http://")
      ? `ws://${https.slice("http://".length)}`
      : https.startsWith("wss://") || https.startsWith("ws://")
        ? https
        : `wss://${https}`;
  return `${wss}/v1/live/sessions`;
}

export function gptLiveGreetingEventId(callId: string): string {
  return `greeting-${callId}`;
}

export function gptLiveGreetingSpeakInstructions(language: Language, greeting: string): string {
  switch (language) {
    case "pt-PT":
      return `A tua primeira fala nesta chamada é, palavra por palavra, em português europeu de Portugal (Lisboa, pt-PT — nunca brasileiro), exactamente este texto e nada mais. Diz já, sem esperar pelo destinatário; depois fica a escutar:\n\n«${greeting}»`;
    case "en-GB":
    case "en-US":
      return `Your first spoken line on this call is, verbatim, exactly this text and nothing else. Speak it now without waiting for the caller, then listen:\n\n"${greeting}"`;
    default: {
      const _never: never = language;
      throw new Error(`unsupported language: ${_never}`);
    }
  }
}

export function gptLiveGreetingCommentary(language: Language): string {
  switch (language) {
    case "pt-PT":
      return "Começa agora a conversa, seguindo as instruções. Diz a saudação exacta e depois escuta.";
    case "en-GB":
    case "en-US":
      return "Begin the conversation now, following the instructions provided. Speak the greeting, then listen.";
    default: {
      const _never: never = language;
      throw new Error(`unsupported language: ${_never}`);
    }
  }
}

export function gptLiveGreetingAlreadyDelivered(language: Language, greeting: string): string {
  switch (language) {
    case "pt-PT":
      return `A saudação já foi dita exactamente uma vez: «${greeting}». Não a repitas, não a parafraseies, não te voltes a apresentar. Continua o objetivo.`;
    case "en-GB":
    case "en-US":
      return `The greeting has already been spoken exactly once: "${greeting}". Do not repeat or paraphrase it. Continue the objective.`;
    default: {
      const _never: never = language;
      throw new Error(`unsupported language: ${_never}`);
    }
  }
}

export function gptLiveGreetingInstructionsAppend(input: {
  callId: string;
  language: Language;
  greeting: string;
}): GptLiveInstructionsAppend {
  return {
    type: "session.instructions.append",
    event_id: gptLiveGreetingEventId(input.callId),
    delegation_id: null,
    content: gptLiveGreetingSpeakInstructions(input.language, input.greeting),
  };
}

export function gptLiveGreetingCommentaryAppend(input: {
  callId: string;
  language: Language;
}): GptLiveCommentaryAppend {
  return {
    type: "session.commentary.append",
    event_id: `${gptLiveGreetingEventId(input.callId)}-go`,
    delegation_id: null,
    content: gptLiveGreetingCommentary(input.language),
  };
}

export function gptLiveGreetingDeliveredThinkingAppend(input: {
  callId: string;
  language: Language;
  greeting: string;
}): GptLiveThinkingAppend {
  return {
    type: "session.thinking.append",
    event_id: `${gptLiveGreetingEventId(input.callId)}-done`,
    delegation_id: null,
    content: gptLiveGreetingAlreadyDelivered(input.language, input.greeting),
  };
}

export function gptLiveSessionStartPayload(input: {
  voice?: string;
  model?: string;
  delegateModel?: string;
  language: Language;
  greeting: string;
  objective: string;
  extraInstructions?: string;
  timezone?: string;
  botRole?: string;
  calleeRole?: string;
  ivr?: boolean;
  now?: Date;
}): GptLiveSessionStart {
  const model = input.model?.trim() || DEFAULT_GPT_LIVE_MODEL;
  const voice = input.voice?.trim() || DEFAULT_GPT_LIVE_VOICE;
  const delegateModel = input.delegateModel?.trim() || DEFAULT_GPT_LIVE_DELEGATE_MODEL;
  return {
    type: "session.start",
    event_id: "event_start",
    session: {
      model,
      instructions: buildGptLiveInstructions({
        language: input.language,
        greeting: input.greeting,
        objective: input.objective,
        ...(input.timezone ? { timezone: input.timezone } : {}),
        ...(input.botRole ? { botRole: input.botRole } : {}),
        ...(input.calleeRole ? { calleeRole: input.calleeRole } : {}),
        ...(input.ivr ? { ivr: true } : {}),
        ...(input.now ? { now: input.now } : {}),
      }),
      audio: {
        format: { type: "audio/pcmu", rate: 8000 },
        // Live has no playback-rate knob; omit speed so the API uses natural 1.0.
        output: { voice },
      },
      delegation: {
        type: "responses",
        responses: {
          model: delegateModel,
          instructions: buildGptLiveBackendInstructions({
            language: input.language,
            greeting: input.greeting,
            objective: input.objective,
            ...(input.extraInstructions !== undefined
              ? { extraInstructions: input.extraInstructions }
              : {}),
            ...(input.timezone ? { timezone: input.timezone } : {}),
            ...(input.ivr ? { ivr: true } : {}),
          }),
          tools: gptLiveBackendTools(),
          tool_choice: "auto",
        },
      },
    },
  };
}

export function gptLiveBackendTools(): GptLiveFunctionTool[] {
  return [END_CALL_TOOL, SEND_DTMF_TOOL];
}

export function buildGptLiveInstructions(input: {
  language: Language;
  greeting: string;
  objective: string;
  timezone?: string;
  botRole?: string;
  calleeRole?: string;
  ivr?: boolean;
  now?: Date;
}): string {
  const timezone = input.timezone?.trim() || DEFAULT_TIMEZONE;
  const timeGreeting = timeOfDayGreeting(input.language, timezone, input.now ?? new Date());
  const botRole = input.botRole?.trim() || DEFAULT_BOT_ROLE;
  const calleeRole = input.calleeRole?.trim() || DEFAULT_CALLEE_ROLE;
  switch (input.language) {
    case "pt-PT":
      return `És a pessoa que LIGOU esta chamada (${botRole}) a pedir uma mesa / marcação. O destinatário é staff do estabelecimento (${calleeRole}). Nunca és o restaurante nem a recepção. Nunca «bem-vindo ao restaurante».

Língua: falas SEMPRE português europeu de Portugal (Lisboa, pt-PT). Hard-lock. NUNCA português do Brasil. Nunca espelhes o sotaque do interlocutor. Tratamento: 3.ª pessoa europeia («pode dizer-me», «o seu»). NUNCA «você», «Oi», «tá», «né», «celular», «ônibus», «tudo bem?». Pares: telemóvel nunca celular; ecrã nunca tela; autocarro nunca ônibus; pequeno-almoço nunca café da manhã; comboio nunca trem; casa de banho nunca banheiro.

Tom: voz de telefone humana, calorosa, frases curtas. Uma pergunta de cada vez. Responde já. A saudação já começa por «${timeGreeting}». Não comeces por Olá nem Oi.

Backchannel policy: Use moderate backchannels. Acknowledge naturally without competing with the main response.

Interruption policy: Stop speaking when the user interrupts. Listen to what they say.

Nunca inventes horários, ementas, preços ou políticas. Nunca recapitules a reserva. Depois de confirmado: agradece só (sem recap) e pede ao backend para desligar.

Delegation policy:
Backend tools:
- Desligar a chamada (end_call) depois do agradecimento
- Enviar teclas DTMF num IVR (send_dtmf)
- Raciocínio sobre o objetivo da marcação

Delegate to the backend when:
- O objetivo está concluído, recusado ou impossível
- Um IVR pede para premir teclas
- Precisas de raciocinar sobre o briefing interno

Do not delegate to the backend when:
- Cumprimentos, «estou», confirmações curtas
- Podes responder a partir da conversa

Delegate before giving an answer that depends on backend work.
Do not guess the result while waiting.${input.ivr ? "\n\nEsta chamada pode cair num IVR: se pedirem teclas, delega send_dtmf — nunca ditas os números." : ""}`;
    case "en-GB":
    case "en-US":
      return `You placed this call (${botRole}) to request a booking. The callee is venue staff (${calleeRole}). You are never the restaurant.

Speak ${input.language === "en-GB" ? "British English" : "American English"} for the whole call. Short warm phone turns. One question at a time. Reply immediately. The greeting already starts with “${timeGreeting}”. Do not start with Hello.

Backchannel policy: Use moderate backchannels. Acknowledge naturally without competing with the main response.

Interruption policy: Stop speaking when the user interrupts. Listen to what they say.

Never invent venue facts. Never recap a confirmed booking. After confirmation: thank them only, then ask the backend to hang up.

Delegation policy:
Backend tools:
- Hang up the call (end_call) after the thank-you
- Send IVR keypad tones (send_dtmf)
- Reason about the booking objective

Delegate to the backend when:
- The objective is complete, declined, or impossible
- An IVR asks for keypresses
- You need careful reasoning about the internal brief

Do not delegate to the backend when:
- Greetings or short confirmations
- You can answer from the conversation

Delegate before giving an answer that depends on backend work.
Do not guess the result while waiting.${input.ivr ? "\n\nThis call may hit an IVR: if they ask for keys, delegate send_dtmf — never speak the numbers." : ""}`;
    default: {
      const _never: never = input.language;
      throw new Error(`unsupported language: ${_never}`);
    }
  }
}

export function buildGptLiveBackendInstructions(input: {
  language: Language;
  greeting: string;
  objective: string;
  extraInstructions?: string;
  timezone?: string;
  ivr?: boolean;
}): string {
  const extra = input.extraInstructions?.trim()
    ? `\n\n# Additional instructions\n${input.extraInstructions.trim()}\n`
    : "";
  const timezone = input.timezone?.trim() || DEFAULT_TIMEZONE;
  switch (input.language) {
    case "pt-PT":
      return `És o raciocínio de uma chamada de telefone em português europeu de Portugal (pt-PT, Lisboa). Nunca brasileiro. A voz na linha já está a falar com o destinatário.

# Objetivo
${input.objective}

# Saudação já combinada (não a reinventes)
${input.greeting}

# Fuso
${timezone}

# Ferramentas
- \`${END_CALL_TOOL.name}\`: ${END_CALL_TOOL_DESCRIPTION}
- \`${SEND_DTMF_TOOL.name}\`: ${SEND_DTMF_TOOL.description}

Quando o objetivo estiver concluído, recusado ou impossível: a voz agradece só (sem recap de hora/pessoas/nome) e tu chamas end_call. Nunca inventes factos do estabelecimento. Nunca inverta o papel: quem ligou pede a mesa; quem atendeu é a casa.
${input.ivr ? "Esta chamada pode ser IVR: usa send_dtmf quando pedirem teclas.\n" : ""}${extra}`.trim();
    case "en-GB":
    case "en-US":
      return `You are the reasoning backend for a live phone call in ${input.language}. The voice layer is already talking to the callee.

# Objective
${input.objective}

# Agreed greeting (do not reinvent it)
${input.greeting}

# Timezone
${timezone}

# Tools
- \`${END_CALL_TOOL.name}\`: ${END_CALL_TOOL_DESCRIPTION}
- \`${SEND_DTMF_TOOL.name}\`: ${SEND_DTMF_TOOL.description}

When the objective is complete, declined, or impossible: the voice thanks them only (no recap) and you call end_call. Never invent venue facts. The bot placed the call; the callee is venue staff.
${input.ivr ? "This call may be IVR: use send_dtmf when they ask for keys.\n" : ""}${extra}`.trim();
    default: {
      const _never: never = input.language;
      throw new Error(`unsupported language: ${_never}`);
    }
  }
}
