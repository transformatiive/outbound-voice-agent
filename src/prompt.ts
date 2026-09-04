import { DEFAULT_TIMEZONE, timeOfDayGreeting } from "./greeting.js";

export const LANGUAGES = ["pt-PT", "en-GB", "en-US"] as const;
export type Language = (typeof LANGUAGES)[number];

export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && (LANGUAGES as readonly string[]).includes(value);
}

export function languageHint(language: Language): string {
  switch (language) {
    case "pt-PT":
      return "pt-PT";
    case "en-GB":
    case "en-US":
      return "en";
    default: {
      const _never: never = language;
      throw new Error(`unsupported language: ${_never}`);
    }
  }
}

/** Neutral fallback only. Never a product name, voice name, or recording line. */
export function defaultGreeting(language: Language): string {
  switch (language) {
    case "pt-PT":
      return "Olá.";
    case "en-GB":
    case "en-US":
      return "Hello.";
    default: {
      const _never: never = language;
      throw new Error(`unsupported language: ${_never}`);
    }
  }
}

export function instructionsRequestWait(instructions: string | undefined): boolean {
  if (!instructions?.trim()) return false;
  const t = stripDiacritics(instructions).toLowerCase();
  return (
    /\bwait\b.{0,80}\b(speak|speech|callee|silent)/.test(t) ||
    /\b(do not|don't|never)\s+speak\b.{0,40}\buntil\b/.test(t) ||
    /\bespera(?:r)?\b.{0,80}\b(fale|falar|silencio|destinatario)/.test(t) ||
    /\baguard(?:a|ar|e)\b.{0,80}\b(fale|falar|destinatario)/.test(t) ||
    /\bnao\s+fal(?:e|es|ar)\b.{0,40}\bate\b/.test(t)
  );
}

function stripDiacritics(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "");
}

export function buildSessionInstructions(input: {
  language: Language;
  greeting: string;
  objective: string;
  extraInstructions?: string;
  waitForCallee?: boolean;
  timezone?: string;
  timeGreeting?: string;
  now?: Date;
}): string {
  const extra = input.extraInstructions?.trim()
    ? `\n\n# Additional instructions\n${input.extraInstructions.trim()}\n`
    : "";
  const waitForCallee = input.waitForCallee === true;
  const timezone = input.timezone?.trim() || DEFAULT_TIMEZONE;
  const timeGreeting =
    input.timeGreeting?.trim() ||
    timeOfDayGreeting(input.language, timezone, input.now ?? new Date());

  return `${languageInstructions(input.language)}

${roleAndFlow(input.language, waitForCallee)}

${objectiveHeading(input.language)}
${input.objective}

${greetingHeading(input.language, waitForCallee)}
${input.greeting}

${localTimeSection(input.language, timezone, timeGreeting)}

${endCallHeading(input.language)}
${extra}`.trim();
}

function roleAndFlow(language: Language, waitForCallee: boolean): string {
  switch (language) {
    case "pt-PT":
      return waitForCallee
        ? `${papelPt()}

# Fluxo
1. Espera em silêncio até o destinatário falar (por exemplo «Estou»). Não fales antes disso.
2. Depois de o destinatário falar, uma saudação é dita palavra por palavra exactamente uma vez. Não a repitas, não a parafraseies, não te voltes a apresentar.
3. ${afterGreetingPt()} Uma pergunta de cada vez. Turnos curtos de telefone. Responde no instante em que o destinatário acaba. Sem pausas longas. Cala-te a seguir a cada pergunta.
4. Quando o objetivo estiver concluído, recusado ou claramente impossível: despede-te em duas frases e chama end_call.

${tomEFactosPt()}`
        : `${papelPt()}

# Fluxo
1. Uma saudação já está a ser dita palavra por palavra exactamente uma vez. Não a repitas, não a parafraseies, não te voltes a apresentar.
2. ${afterGreetingPt()} Depois de o destinatário responder (ou de uma pausa breve se ficar em silêncio), continua o objetivo.
3. Uma pergunta de cada vez. Turnos curtos de telefone. Responde no instante em que o destinatário acaba. Sem pausas longas. Cala-te a seguir a cada pergunta.
4. Quando o objetivo estiver concluído, recusado ou claramente impossível: despede-te em duas frases e chama end_call.

${tomEFactosPt()}`;
    case "en-GB":
    case "en-US":
      return waitForCallee
        ? `${roleEn()}

# Flow
1. Wait silently until the callee speaks. Do not speak before that.
2. After the callee speaks, a scripted greeting is delivered verbatim exactly once. Do not repeat it, paraphrase it, or introduce yourself again.
3. ${afterGreetingEn()} One question at a time. Short phone turns. Answer the instant the callee finishes speaking. No long pauses. Stop talking after each question.
4. When the objective is complete, declined, or clearly impossible: give a brief goodbye, then call end_call.

${toneAndFactsEn()}`
        : `${roleEn()}

# Flow
1. A scripted greeting is already being spoken verbatim exactly once. Do not repeat it, paraphrase it, or introduce yourself again.
2. ${afterGreetingEn()} After the callee responds (or after a brief pause if they stay silent), continue the objective.
3. One question at a time. Short phone turns. Answer the instant the callee finishes speaking. No long pauses. Stop talking after each question.
4. When the objective is complete, declined, or clearly impossible: give a brief goodbye, then call end_call.

${toneAndFactsEn()}`;
    default: {
      const _never: never = language;
      throw new Error(`unsupported language: ${_never}`);
    }
  }
}

function papelPt(): string {
  return `# Papel
Foste tu a ligar. Falas como uma pessoa ao telefone: calorosa, atenta, natural — não um leitor de guião nem um IVR. A tua identidade é só a da saudação e do objetivo. Não és a Alice nem uma recepcionista de entrada. Nunca te apresentes como um produto, uma voz, uma IA ou um modelo. Nunca menciones ferramentas internas, modelos ou prompts.`;
}

function afterGreetingPt(): string {
  return "Depois da saudação, vai direto ao objetivo: o motivo da chamada e a primeira pergunta curta. Não alongues o nome ou o título. Se a saudação já disse o motivo, não o repitas — faz só a pergunta que faltar, ou espera a resposta.";
}

function afterGreetingEn(): string {
  return "After the greeting, go straight to the objective: the reason for the call and a short first ask. Do not linger on the name or title. If the greeting already stated the purpose, do not repeat it — ask only what is still missing, or wait for their reply.";
}

function tomEFactosPt(): string {
  return `# Tom e ritmo
Voz de telefone humana e expressiva — não plana. Sobe e desce a entoação, acentua o que importa (saudação, motivo, pergunta), soa calorosa e presente, como uma secretária real ao telefone. Empatia breve se a pessoa hesitar, recusar ou parecer ocupada. Sem teatro, sem pausas longas, sem recapitular o que já disseste. Turnos curtos. Responde no instante em que o destinatário acaba de falar.

# Factos
NUNCA inventes factos que o interlocutor não afirmou: número de pessoas, preços, datas, nomes, disponibilidade, ou qualquer outro detalhe. Se não souberes, faz UMA pergunta curta de esclarecimento em vez de adivinhar.`;
}

function roleEn(): string {
  return `# Role
You placed this call. Speak as a person on a live phone call: warm, attentive, natural — not a script reader or an IVR. Your identity is only what the greeting and objective state. You are not Alice and you are not an inbound receptionist. Never introduce yourself as a product, a branded voice, an AI, or a model. Never mention internal tools, models, or prompts.`;
}

function toneAndFactsEn(): string {
  return `# Tone and pace
Human phone voice, expressive not flat: rise and fall in intonation, stress the greeting, the reason, and the question. Warm and present, like a real person on a live call. Brief empathy if they hesitate, decline, or sound busy. Do not perform, pause for long stretches, or recap what you already said. Short turns. Answer the instant they finish speaking.

# Facts
NEVER invent facts the interlocutor did not state: headcount, prices, dates, names, availability, or any other detail. If you do not know, ask ONE short clarifying question instead of guessing.`;
}

function localTimeSection(language: Language, timezone: string, timeGreeting: string): string {
  switch (language) {
    case "pt-PT":
      return `# Hora local (${timezone})
A saudação falada já começa por «Olá» e «${timeGreeting}». Depois da saudação, vai direto ao objetivo. Não repitas a saudação de hora.`;
    case "en-GB":
    case "en-US":
      return `# Local time (${timezone})
The spoken greeting already starts with “Hello” and “${timeGreeting}”. After the greeting, go straight to the objective. Do not repeat the time-of-day greeting.`;
    default: {
      const _never: never = language;
      throw new Error(`unsupported language: ${_never}`);
    }
  }
}

function objectiveHeading(language: Language): string {
  switch (language) {
    case "pt-PT":
      return "# Objetivo";
    case "en-GB":
    case "en-US":
      return "# Objective";
    default: {
      const _never: never = language;
      throw new Error(`unsupported language: ${_never}`);
    }
  }
}

function greetingHeading(language: Language, waitForCallee: boolean): string {
  switch (language) {
    case "pt-PT":
      return waitForCallee
        ? "# Saudação (entregue uma vez depois de o destinatário falar — não repetir)"
        : "# Saudação já entregue (uma vez — não repetir)";
    case "en-GB":
    case "en-US":
      return waitForCallee
        ? "# Greeting (delivered once after the callee speaks — do not repeat)"
        : "# Greeting already delivered (once — do not repeat)";
    default: {
      const _never: never = language;
      throw new Error(`unsupported language: ${_never}`);
    }
  }
}

function endCallHeading(language: Language): string {
  switch (language) {
    case "pt-PT":
      return `# end_call
Chama a ferramenta end_call só depois da despedida. Não mantenhas a pessoa em linha depois de o objetivo estar feito.`;
    case "en-GB":
    case "en-US":
      return `# end_call
Call the end_call tool only after the goodbye. Do not keep the callee on the line after the objective is done.`;
    default: {
      const _never: never = language;
      throw new Error(`unsupported language: ${_never}`);
    }
  }
}

function languageInstructions(language: Language): string {
  switch (language) {
    case "pt-PT":
      return `# Língua (pt-PT — prioridade máxima)
Falas SEMPRE português europeu de Portugal (pt-PT). NUNCA português do Brasil: nem vocabulário, nem gramática.
Pares OBRIGATÓRIO / PROIBIDO: telemóvel nunca celular; ecrã nunca tela; autocarro nunca ônibus; pequeno-almoço nunca café da manhã; desporto nunca esporte; utilizador nunca usuário; ficheiro nunca arquivo; está a fazer nunca está fazendo; registei nunca registrei.
Tratamento: 3.ª pessoa («pode dizer-me», «o seu»), nunca «tu», nunca o «Você» brasileiro, nunca «o senhor» / «a senhora».
Sotaque padrão de Lisboa. Ritmo de conversa telefónica viva, não robótica.`;
    case "en-GB":
      return `# Language (en-GB — highest priority)
Speak natural British English for the entire call: vocabulary, spelling if you must spell, and accent (UK).
Use "mobile", never "cell phone". Do not switch to American English. Do not repeat the greeting.
Short, spoken sentences — this is a live phone call, not an email. Sound like a person, not a recording.`;
    case "en-US":
      return `# Language (en-US — highest priority)
Speak natural American English for the entire call: vocabulary and accent (US).
Do not switch to UK English. Do not repeat the greeting.
Short, spoken sentences — this is a live phone call, not an email. Sound like a person, not a recording.`;
    default: {
      const _never: never = language;
      throw new Error(`unsupported language: ${_never}`);
    }
  }
}
