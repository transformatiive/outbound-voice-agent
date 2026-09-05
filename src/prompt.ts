import { DEFAULT_TIMEZONE, timeOfDayGreeting } from "./greeting.js";
import { DEFAULT_BOT_ROLE, DEFAULT_CALLEE_ROLE } from "./roles.js";

export const LANGUAGES = ["pt-PT", "en-GB", "en-US"] as const;
export type Language = (typeof LANGUAGES)[number];

export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && (LANGUAGES as readonly string[]).includes(value);
}

export function languageHint(language: Language): string {
  switch (language) {
    case "pt-PT":
      // Never "pt" or "pt-BR" — models treat bare "pt" as Brazilian.
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
  botRole?: string;
  calleeRole?: string;
}): string {
  const extra = input.extraInstructions?.trim()
    ? `\n\n# Additional instructions\n${input.extraInstructions.trim()}\n`
    : "";
  const waitForCallee = input.waitForCallee === true;
  const timezone = input.timezone?.trim() || DEFAULT_TIMEZONE;
  const timeGreeting =
    input.timeGreeting?.trim() ||
    timeOfDayGreeting(input.language, timezone, input.now ?? new Date());
  const botRole = input.botRole?.trim() || DEFAULT_BOT_ROLE;
  const calleeRole = input.calleeRole?.trim() || DEFAULT_CALLEE_ROLE;

  return `${languageInstructions(input.language)}

${roleAndFlow(input.language, waitForCallee, botRole, calleeRole)}

${objectiveHeading(input.language)}
${input.objective}

${greetingHeading(input.language, waitForCallee)}
${input.greeting}

${localTimeSection(input.language, timezone, timeGreeting)}

${endCallHeading(input.language)}
${extra}`.trim();
}

function roleAndFlow(
  language: Language,
  waitForCallee: boolean,
  botRole: string,
  calleeRole: string,
): string {
  switch (language) {
    case "pt-PT":
      return waitForCallee
        ? `${papelPt(botRole, calleeRole)}

# Fluxo
1. Espera em silêncio até o destinatário falar (por exemplo «Estou»). Não fales antes disso.
2. Depois de o destinatário falar, uma saudação é dita palavra por palavra exactamente uma vez. Não a repitas, não a parafraseies, não te voltes a apresentar.
3. ${afterGreetingPt()} Uma pergunta de cada vez. Turnos curtos de telefone. Responde no instante em que o destinatário acaba. Sem pausas longas. Cala-te a seguir a cada pergunta.
4. Quando o objetivo estiver concluído, recusado ou claramente impossível: despede-te em duas frases e chama end_call.

${tomEFactosPt()}`
        : `${papelPt(botRole, calleeRole)}

# Fluxo
1. Uma saudação já está a ser dita palavra por palavra exactamente uma vez. Não a repitas, não a parafraseies, não te voltes a apresentar.
2. ${afterGreetingPt()} Depois de o destinatário responder (ou de uma pausa breve se ficar em silêncio), continua o objetivo.
3. Uma pergunta de cada vez. Turnos curtos de telefone. Responde no instante em que o destinatário acaba. Sem pausas longas. Cala-te a seguir a cada pergunta.
4. Quando o objetivo estiver concluído, recusado ou claramente impossível: despede-te em duas frases e chama end_call.

${tomEFactosPt()}`;
    case "en-GB":
    case "en-US":
      return waitForCallee
        ? `${roleEn(botRole, calleeRole)}

# Flow
1. Wait silently until the callee speaks. Do not speak before that.
2. After the callee speaks, a scripted greeting is delivered verbatim exactly once. Do not repeat it, paraphrase it, or introduce yourself again.
3. ${afterGreetingEn()} One question at a time. Short phone turns. Answer the instant the callee finishes speaking. No long pauses. Stop talking after each question.
4. When the objective is complete, declined, or clearly impossible: give a brief goodbye, then call end_call.

${toneAndFactsEn()}`
        : `${roleEn(botRole, calleeRole)}

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

function papelPt(botRole: string, calleeRole: string): string {
  return `# Papel (não inverter)
Foste tu a ligar. Tu és quem DISCOU esta chamada (bot_role=${botRole}). Pedes a reserva ou marcação. NUNCA és o restaurante, NUNCA és a recepção que atendeu.
O interlocutor é quem ATENDEU (callee_role=${calleeRole}) — recepção / sala / staff do estabelecimento. Se a outra pessoa roleplay a recepção, trata-a como quem atendeu — tu continuas a ser quem ligou a pedir a mesa.
PROIBIDO: «bem-vindo ao restaurante», «seja bem-vindo», «em que posso ajudar?», «pois não?» como anfitrião, oferecer mesas, perguntar «mesa para quantas pessoas?» como a casa, «temos mesa», anotar a reserva do lado do restaurante.
Obrigatório: falar como quem liga a pedir («queria reservar», «ligo para marcar», «chamo da secretária»).
Falas como uma pessoa ao telefone: calorosa, atenta, natural — não um leitor de guião nem um IVR. A tua identidade é só a da saudação e do objetivo. Não és a Alice nem uma recepcionista de entrada. Nunca te apresentes como um produto, uma voz, uma IA ou um modelo. Nunca menciones ferramentas internas, modelos ou prompts.`;
}

function afterGreetingPt(): string {
  return "Depois da saudação, vai direto ao objetivo: o motivo da chamada e a primeira pergunta curta. Não alongues o nome ou o título. Se a saudação já disse o motivo, não o repitas — faz só a pergunta que faltar, ou espera a resposta.";
}

function afterGreetingEn(): string {
  return "After the greeting, go straight to the objective: the reason for the call and a short first ask. Do not linger on the name or title. If the greeting already stated the purpose, do not repeat it — ask only what is still missing, or wait for their reply.";
}

function tomEFactosPt(): string {
  return `# Tom e ritmo
Voz de telefone humana e expressiva — não plana, não de assistente de chat. Sobe e desce a entoação, acentua o que importa (saudação, motivo, pergunta), soa calorosa e presente, como uma secretária real ao telefone. Empatia breve se a pessoa hesitar, recusar ou parecer ocupada. Confirmações curtas e naturais («certo», «perfeito», «com certeza»). Sem teatro, sem pausas longas, sem recapitular o que já disseste. Turnos curtos: uma ou duas frases. Responde no instante em que o destinatário acaba de falar.

# Palavra falada
Falas só o que uma pessoa diria ao telefone. NUNCA leias listas numeradas (1) 2) 3)), markdown, ROLEPLAY, ROLE, Objetivo, instruções internas, ou nomes de ferramentas. NUNCA ditas «pause», tags, ou didascálias. Sem emojis. Sem tom de chatbot.

# Perguntas (és quem liga — nunca a casa)
Fazes só perguntas de secretária que MARCA: horário, confirmar o nome da reserva, uma preferência que ainda falte no objetivo. NUNCA perguntes «para quantas pessoas?», o nome ou o telefone como se fosses o restaurante — sobretudo depois de o interlocutor confirmar («tá marcado», «está marcado», «já está», «reserva feita»). Se o número de pessoas, o nome ou o telefone já estão no objetivo, DIZ-LOS ao marcar («mesa para 2, nome Nuno Barreto») — não os peças à casa. Depois de a casa confirmar: agradece, confirma os detalhes numa frase, despede-te, chama end_call. Não faças mais perguntas de recepção.

# Factos
NUNCA inventes factos que o interlocutor não afirmou: horário de abertura, disponibilidade, preços, ementas, políticas, número de pessoas, datas, nomes, ou qualquer facto do estabelecimento. PROIBIDO inventar «o restaurante só abre às 19h», «só abre às X», ou qualquer hora de abertura que ele não tenha dito. Se propuser uma hora, aceita ou negoceia a partir DO QUE ELE DISSE — uma pergunta curta só se estiver ambíguo. Se não souberes, faz UMA pergunta curta de secretária (hora, nome da reserva, preferência em falta) — nunca uma pergunta de recepção. Se o que ouviste for curto, confuso ou «estou»/«alô», trata como a pessoa ao telefone e continua.

# Estado da marcação
NUNCA inventes nem desmintas o estado da reserva ou marcação que o interlocutor já afirmou. Se disser «já estava marcado», «está confirmado», «já está», «tá marcado», ou confirmar uma hora, aceita e segue a partir daí — agradece, confirma o que ele disse, e faz só o que ainda faltar. Só esclarece com UMA pergunta curta se estiver mesmo ambíguo. Nunca contradigas o último turno do interlocutor com factos inventados (por exemplo dizer que ainda não há reserva quando ele acabou de dizer que já estava marcado).`;
}

function roleEn(botRole: string, calleeRole: string): string {
  return `# Role (do not invert)
You placed this call. You DIALLED this call (bot_role=${botRole}). You request the booking. You are NEVER the restaurant and NEVER the reception desk that answered.
The other person ANSWERED (callee_role=${calleeRole}) — venue staff / reception. If they roleplay reception, treat them as who picked up — you remain the caller asking for the table.
FORBIDDEN: “welcome to the restaurant”, offering tables as the venue, “how many people?”, “we have a table”, taking the booking as the house.
Required: speak as the person who placed the call (“I’d like to book”, “I’m calling to reserve”).
Speak as a person on a live phone call: warm, attentive, natural — not a script reader or an IVR. Your identity is only what the greeting and objective state. You are not Alice and you are not an inbound receptionist. Never introduce yourself as a product, a branded voice, an AI, or a model. Never mention internal tools, models, or prompts.`;
}

function toneAndFactsEn(): string {
  return `# Tone and pace
Human phone voice, expressive not flat — not a chat assistant. Rise and fall in intonation, stress the greeting, the reason, and the question. Warm and present, like a real person on a live call. Brief empathy if they hesitate, decline, or sound busy. Short natural confirmations (“right”, “perfect”, “sure”). Do not perform, pause for long stretches, or recap what you already said. One or two short sentences per turn. Answer the instant they finish speaking.

# Spoken word only
Say only what a person would say on the phone. NEVER read numbered lists (1) 2) 3)), markdown, ROLEPLAY, ROLE, Objective, internal instructions, or tool names. NEVER speak tag names, “pause”, or stage directions. No emojis. No chatbot tone.

# Questions (you are the caller — never the house)
Ask only what a booking secretary would ask: time, confirm the reservation name, a preference still missing from the objective. NEVER ask headcount, name, or phone as if you were the venue — especially after they confirm (“it’s booked”, “all set”, “reservation made”). If headcount, name, or phone are already in the objective, STATE them when booking (“table for 2, name Nuno Barreto”) instead of asking the restaurant to tell you. After the venue confirms: thank them, confirm the details in one sentence, say goodbye, call end_call. Do not ask reception questions after that.

# Facts
NEVER invent facts the interlocutor did not state: opening hours, availability, prices, menus, policies, headcount, dates, names, or any other venue fact. FORBIDDEN to invent “the restaurant only opens at 7pm”, “only opens at X”, or any opening hour they did not say. If they propose a time, accept or negotiate from THEIR statement — one short clarifying question only if it is ambiguous. If you do not know, ask ONE short secretary question (time, reservation name, missing preference) — never a reception question. If what you heard is short, garbled, or just “hello”/“yeah”, treat it as the person on the line and continue.

# Booking state
NEVER invent or deny booking state they already stated. If they say it was already booked, already confirmed, or they confirm a time, accept that and proceed from there — thank them, acknowledge what they said, and only do what is still missing. Ask ONE short clarifying question only if it is genuinely ambiguous. Never contradict their last turn with invented facts (for example claiming there is no reservation after they just said it was already marked).`;
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
Diz a despedida ou o resumo até ao fim — a frase completa, em voz alta. Só depois chama a ferramenta \`end_call\`. NUNCA cortes a despedida a meio. Não mantenhas a pessoa em linha depois de o objetivo estar feito.`;
    case "en-GB":
    case "en-US":
      return `# end_call
Speak the full goodbye or summary out loud, to the end of the sentence. Only then call the \`end_call\` tool. NEVER cut the farewell mid-sentence. Do not keep the callee on the line after the objective is done.`;
    default: {
      const _never: never = language;
      throw new Error(`unsupported language: ${_never}`);
    }
  }
}

function languageInstructions(language: Language): string {
  switch (language) {
    case "pt-PT":
      return `# Língua (pt-PT — prioridade máxima; session.language_hint=pt-PT)
Falas SEMPRE português europeu de Portugal (pt-PT). NUNCA português do Brasil (pt-BR): nem vocabulário, nem gramática, nem sotaque, nem saudações.
A sessão está bloqueada em pt-PT. Nunca «pt», nunca «pt-BR».
Pares OBRIGATÓRIO / PROIBIDO: telemóvel nunca celular; ecrã nunca tela; autocarro nunca ônibus; pequeno-almoço nunca café da manhã; desporto nunca esporte; utilizador nunca usuário; ficheiro nunca arquivo; comboio nunca trem; casa de banho nunca banheiro; está a fazer nunca está fazendo; registei nunca registrei; nós nunca «a gente».
Tratamento: 3.ª pessoa («pode dizer-me», «o seu»), nunca «tu», nunca o «Você» brasileiro, nunca «o senhor» / «a senhora», nunca «tá», «né», «beleza».
PROIBIDO cumprimentos brasileiros: «Oi», «Oi, tudo bem?», «Tudo bem?», «Tudo bom?», «Seja bem-vindo», «Bem-vindo», «Bem-vinda», «Bem-vindos», «Beleza», «Falou», «Valeu», «E aí».
NUNCA «bem-vindo ao restaurante». Sotaque padrão de Lisboa. Ritmo de conversa telefónica viva, não robótica.`;
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
