import type { Language } from "./prompt.js";
import { DEFAULT_TIMEZONE, timeOfDayGreeting } from "./greeting.js";
import {
  DEFAULT_ELEVENLABS_VOICE_ID,
  RECOMMENDED_ELEVENLABS_VOICE_ID_ALT,
} from "./tts.js";

/** Matches default identity «sou a secretária» / Benedita. Never spoken «obrigado(a)». */
export type AgentGender = "feminine" | "masculine";
export const DEFAULT_AGENT_GENDER: AgentGender = "feminine";

export type CallClosingInput = {
  language: Language;
  greeting?: string;
  persona?: string;
  voice?: string;
  gender?: AgentGender;
  timezone?: string;
  timeGreeting?: string;
  now?: Date;
};

const FEMININE_VOICES = new Set([
  "ara",
  "eve",
  "coral",
  "shimmer",
  "marin",
  "sage",
  "willow",
  "vesper",
  "gleam",
  "joana",
  "benedita",
]);

const MASCULINE_VOICES = new Set(["rex", "leo", "echo", "ash", "cedar"]);

/**
 * Infer the agent's spoken gender for «obrigado» / «obrigada».
 * Identity clauses («sou a/o», «secretária» / «secretário») win over TTS voice.
 * Unknown → feminine, the same default as «sou a secretária».
 */
export function inferAgentGender(input: {
  greeting?: string;
  persona?: string;
  voice?: string;
}): AgentGender {
  const text = [input.greeting, input.persona].filter(Boolean).join("\n");
  const folded = stripDiacritics(text).toLowerCase();
  const article = folded.match(/\b(?:sou|fala|falo)\s+([ao])s?\b/);
  if (article?.[1] === "o") return "masculine";
  if (article?.[1] === "a") return "feminine";
  if (/\bsecretario\b/.test(folded)) return "masculine";
  if (/\bsecretaria\b/.test(folded)) return "feminine";
  if (/\bhomem\b/.test(folded) && !/\bmulher\b/.test(folded)) return "masculine";
  if (/\bmulher\b/.test(folded) || /\bvoz feminina\b/.test(folded)) return "feminine";
  return voiceGender(input.voice) ?? DEFAULT_AGENT_GENDER;
}

export function genderedThanks(
  language: Language,
  gender: AgentGender = DEFAULT_AGENT_GENDER,
): string {
  switch (language) {
    case "pt-PT":
      return gender === "masculine" ? "muito obrigado" : "muito obrigada";
    case "en-GB":
    case "en-US":
      return "thank you";
    default: {
      const _never: never = language;
      throw new Error(`unsupported language: ${_never}`);
    }
  }
}

/**
 * Spoken hang-up line: gendered thank-you + the same Lisbon time-of-day
 * greeting used at the start of the call (`timeOfDayGreeting`).
 * pt-PT hours: [0,12) Bom dia, [12,20) Boa tarde, [20,24) Boa noite.
 */
export function spokenCallClosing(input: CallClosingInput): string {
  const { thanks, timeGreeting } = resolveClosingFields(input);
  return `${capitalizeFirst(thanks)}. ${ensureSentence(timeGreeting)}`;
}

/** Shared instruction block injected into every TTS provider's default prompt. */
export function defaultClosingRule(input: CallClosingInput): string {
  const { thanks, timeGreeting, timezone } = resolveClosingFields(input);
  const spoken = spokenCallClosing(input);
  switch (input.language) {
    case "pt-PT":
      return `# Encerramento (prioridade máxima)
Quando a marcação ou o objetivo estiver concluído (a casa confirmou, recusou, ou é claramente impossível):
- Diz exactamente «${spoken}»: primeiro «${thanks}» (género da persona/voz), depois «${timeGreeting}» (hora local de ${timezone}).
- Agradece só, de forma calorosa e natural em pt-PT, e chama \`end_call\`.
- NÃO recapitules nem resumes os detalhes já confirmados (hora, pessoas, nome, telefone, data).
- PROIBIDO: «então fica marcado para…», «fica para as X, mesa para N, nome…», ou qualquer recap.
- Uma frase de agradecimento e a despedida de hora. Não alongues a despedida.`;
    case "en-GB":
    case "en-US":
      return `# Closing (highest priority)
When the booking or objective is complete (they confirmed, declined, or it is clearly impossible):
- Say exactly “${spoken}”: “${thanks}”, then “${timeGreeting}” (local time in ${timezone}).
- Thank them warmly and naturally, then call \`end_call\`.
- Do NOT restate or summarize confirmed details (time, party size, name, phone, date).
- FORBIDDEN: “so that’s booked for…”, recapping the slot, or any summary of what was just agreed.
- One short thank-you and the time-of-day farewell. Do not stretch the goodbye.`;
    default: {
      const _never: never = input.language;
      throw new Error(`unsupported language: ${_never}`);
    }
  }
}

function resolveClosingFields(input: CallClosingInput): {
  thanks: string;
  timeGreeting: string;
  timezone: string;
  gender: AgentGender;
} {
  const gender = input.gender ?? inferAgentGender(input);
  const timezone = input.timezone?.trim() || DEFAULT_TIMEZONE;
  const timeGreeting =
    input.timeGreeting?.trim() ||
    timeOfDayGreeting(input.language, timezone, input.now ?? new Date());
  return {
    gender,
    timezone,
    timeGreeting,
    thanks: genderedThanks(input.language, gender),
  };
}

function voiceGender(voice: string | undefined): AgentGender | undefined {
  if (!voice?.trim()) return undefined;
  const raw = voice.trim();
  if (raw === DEFAULT_ELEVENLABS_VOICE_ID || raw === RECOMMENDED_ELEVENLABS_VOICE_ID_ALT) {
    return "feminine";
  }
  const v = raw.toLowerCase();
  if (FEMININE_VOICES.has(v)) return "feminine";
  if (MASCULINE_VOICES.has(v)) return "masculine";
  return undefined;
}

function stripDiacritics(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "");
}

function capitalizeFirst(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.charAt(0).toLocaleUpperCase("pt-PT") + trimmed.slice(1);
}

function ensureSentence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
