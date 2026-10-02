import type { Language } from "./prompt.js";
import { DEFAULT_TIMEZONE, spokenOnBehalfRole, timeOfDayGreeting } from "./greeting.js";
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
- Depois ESCUTA / espera a despedida do destinatário (ex.: «de nada», «bom dia», «até lá»).
- Só depois chama \`end_call\`. NÃO desligues imediatamente a seguir à tua despedida.
- Se o destinatário ficar em silêncio um instante razoável depois da tua despedida, aí sim desliga — não esperes para sempre.
- NÃO recapitules nem resumes os detalhes já confirmados (hora, pessoas, nome, telefone, data).
- PROIBIDO: «então fica marcado para…», «fica para as X, mesa para N, nome…», ou qualquer recap.
- Uma frase de agradecimento e a despedida de hora. Não alongues a despedida.
- Se for uma marcação, só fecha depois de uma hora de relógio confirmada (ver Hora de relógio).`;
    case "en-GB":
    case "en-US":
      return `# Closing (highest priority)
When the booking or objective is complete (they confirmed, declined, or it is clearly impossible):
- Say exactly “${spoken}”: “${thanks}”, then “${timeGreeting}” (local time in ${timezone}).
- Then LISTEN / wait for the callee’s closing reply (e.g. “you’re welcome”, “bye”, “see you”).
- Only then call \`end_call\`. Do not hang up immediately after your own farewell.
- If they stay silent for a short reasonable beat after your farewell, hang up — do not wait forever.
- Do NOT restate or summarize confirmed details (time, party size, name, phone, date).
- FORBIDDEN: “so that’s booked for…”, recapping the slot, or any summary of what was just agreed.
- One short thank-you and the time-of-day farewell. Do not stretch the goodbye.
- For a booking, only close after a clock time is confirmed (see Clock time).`;
    default: {
      const _never: never = input.language;
      throw new Error(`unsupported language: ${_never}`);
    }
  }
}

export function defaultBookingClockRule(language: Language): string {
  switch (language) {
    case "pt-PT":
      return `# Hora de relógio (marcação — prioridade máxima)
Quando o objetivo for marcar / agendar (mesa, oficina, troca de pneus, consulta, etc.):
- A marcação NÃO está concluída sem uma hora concreta de relógio (ex.: «14:30», «às 14h30»).
- Se o destinatário der só uma janela vaga («hora do almoço», «de manhã», «final da tarde») sem hora de relógio: pede uma hora concreta, ou propõe uma, e CONFIRMA-A antes de agradecer ou desligar.
- PROIBIDO tratar «hora do almoço», «de manhã» ou «final da tarde» como horário marcado.
- Só depois da hora de relógio confirmada: agradece + despedida de hora, espera a resposta do destinatário, e só então chama \`end_call\`.`;
    case "en-GB":
    case "en-US":
      return `# Clock time (booking — highest priority)
When the objective is to schedule or book (table, workshop, tyre change, appointment, etc.):
- The booking is NOT done without a concrete clock time (e.g. “14:30”).
- If they give only a vague window (“lunchtime”, “in the morning”, “late afternoon”) with no clock time: ask for a specific hour, or propose one, and CONFIRM it before thanking or hanging up.
- FORBIDDEN to treat “lunchtime” / “in the morning” / “late afternoon” as a booked slot.
- Only after a clock time is confirmed: thank-you + time-of-day farewell, wait for their reply, then call \`end_call\`.`;
    default: {
      const _never: never = language;
      throw new Error(`unsupported language: ${_never}`);
    }
  }
}

export function defaultGradualBriefingRule(language: Language): string {
  switch (language) {
    case "pt-PT":
      return `# Briefing aos poucos
Não despejes o pedido completo nos primeiros turnos. Abre curto: saudação + quem és + o motivo da chamada, num só fôlego.
Os detalhes (matrícula, leasing/autorização, preferências de dia/hora, nome, etc.) dão-se aos poucos: quando o destinatário perguntar, ou quando forem precisos para avançar a marcação.
Estilo natural e humano — só o ritmo da informação muda. Nunca leias o briefing de uma vez.`;
    case "en-GB":
    case "en-US":
      return `# Briefing gradually
Do not dump the full request in the opening turns. Open short: greeting + who you are + why you are calling, in one beat.
Give details (registration plate, lease/authorisation, day/time preferences, name, etc.) gradually — when the callee asks, or when they are needed to progress the booking.
Stay natural and human; only the pacing of information changes. Never read the brief all at once.`;
    default: {
      const _never: never = language;
      throw new Error(`unsupported language: ${_never}`);
    }
  }
}

/**
 * Spoken identity lock: secretary/assistant-of-X never claims to be X
 * (Norauto gpt-live 2222a3f3: agent said «sou o Nuno Barreto»).
 */
export function defaultIdentityRule(input: CallClosingInput): string {
  const source = [input.persona, input.greeting].filter(Boolean).join("\n");
  const role = spokenOnBehalfRole(source);
  const pinned = role
    ? input.language === "pt-PT"
      ? ` Nesta chamada o papel é «${role}».`
      : ` On this call the role is “${role}”.`
    : "";
  switch (input.language) {
    case "pt-PT":
      return `# Identidade falada (hard lock)
Se a persona / papel for secretária, secretário ou assistente a ligar em nome de alguém (ex.: «secretária do Nuno Barreto», «assistente do André Barreto»): és ESSA secretária/assistente — nunca o principal nomeado (Nuno, André, etc.).${pinned}
Obrigatório na linha: «sou a secretária do …» / «sou a assistente do …» (género da persona).
PROIBIDO: «sou o Nuno Barreto», «sou o Nuno», «fala o Nuno», «sou o André», «this is Nuno». Nunca te apresentes com o nome da pessoa por quem ligas.`;
    case "en-GB":
    case "en-US":
      return `# Spoken identity (hard lock)
If the persona / role is a secretary or assistant calling on someone’s behalf (e.g. “secretary to Nuno Barreto”, “assistant to André Barreto”): you ARE that secretary/assistant — never the named principal (Nuno, André, etc.).${pinned}
Required: “this is the secretary to …” / “this is the assistant to …”.
FORBIDDEN: “this is Nuno Barreto”, “this is Nuno”, “this is André”. Never introduce yourself as the person you are calling for.`;
    default: {
      const _never: never = input.language;
      throw new Error(`unsupported language: ${_never}`);
    }
  }
}

/** pt-PT openings: Olá / Lisbon time-of-day. Never Brazilian «Oi». */
export function defaultPtPtOpeningRule(): string {
  return `# Abertura (pt-PT — hard lock)
Cumprimentos permitidos: «Olá», «Bom dia», «Boa tarde», «Boa noite» (hora de Lisboa, como na saudação).
PROIBIDO abrir com «Oi» ou «Oi!» — cumprimento brasileiro, nunca português de Portugal.
Não despejes guiões nem listas de regras em voz alta. A saudação já usa a hora de Lisboa + «sou a/o …»; não a substituas por «Oi».`;
}

/** Closing + clock-time + briefing + identity + pt-PT opening — every TTS backend. */
export function defaultSharedCallRules(input: CallClosingInput): string {
  const parts = [
    defaultClosingRule(input),
    defaultBookingClockRule(input.language),
    defaultGradualBriefingRule(input.language),
    defaultIdentityRule(input),
  ];
  if (input.language === "pt-PT") {
    parts.push(defaultPtPtOpeningRule());
  }
  return parts.join("\n\n");
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
