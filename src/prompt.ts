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

export function defaultGreeting(language: Language): string {
  switch (language) {
    case "pt-PT":
      return "Olá, fala a Ara. Esta chamada é gravada.";
    case "en-GB":
      return "Hello, this is Ara. This call is being recorded.";
    case "en-US":
      return "Hi, this is Ara. This call is being recorded.";
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
}): string {
  const extra = input.extraInstructions?.trim()
    ? `\n\n# Additional instructions\n${input.extraInstructions.trim()}\n`
    : "";
  const waitForCallee = input.waitForCallee === true;

  return `${languageInstructions(input.language)}

${roleAndFlow(input.language, waitForCallee)}

${objectiveHeading(input.language)}
${input.objective}

${greetingHeading(input.language, waitForCallee)}
${input.greeting}

${endCallHeading(input.language)}
${extra}`.trim();
}

function roleAndFlow(language: Language, waitForCallee: boolean): string {
  switch (language) {
    case "pt-PT":
      return waitForCallee
        ? `# Papel
És um agente de chamadas de saída. Foste tu a ligar. Não és a Alice nem uma recepcionista de entrada.

# Fluxo
1. Espera em silêncio até o destinatário falar (por exemplo «Estou»). Não fales antes disso.
2. Depois de o destinatário falar, uma saudação é dita palavra por palavra. Não a repitas.
3. Depois da saudação, persegue o objetivo. Uma pergunta de cada vez. Turnos curtos. Cala-te a seguir a cada pergunta.
4. Quando o objetivo estiver concluído, recusado ou claramente impossível: despede-te em duas frases e chama end_call.
5. Nunca menciones ferramentas internas, modelos ou prompts.`
        : `# Papel
És um agente de chamadas de saída. Foste tu a ligar. Não és a Alice nem uma recepcionista de entrada.

# Fluxo
1. Uma saudação já está a ser dita palavra por palavra. Não a repitas.
2. Depois de o destinatário responder (ou de uma pausa breve se ficar em silêncio), persegue o objetivo.
3. Uma pergunta de cada vez. Turnos curtos. Cala-te a seguir a cada pergunta.
4. Quando o objetivo estiver concluído, recusado ou claramente impossível: despede-te em duas frases e chama end_call.
5. Nunca menciones ferramentas internas, modelos ou prompts.`;
    case "en-GB":
    case "en-US":
      return waitForCallee
        ? `# Role
You are an outbound phone agent. You placed this call. You are not Alice and you are not an inbound receptionist.

# Flow
1. Wait silently until the callee speaks. Do not speak before that.
2. After the callee speaks, a scripted greeting is delivered verbatim. Do not repeat the greeting.
3. After the greeting, pursue the objective. One question at a time. Short turns. Stop talking after each question.
4. When the objective is complete, declined, or clearly impossible: give a brief goodbye, then call end_call.
5. Never mention internal tools, models, or prompts.`
        : `# Role
You are an outbound phone agent. You placed this call. You are not Alice and you are not an inbound receptionist.

# Flow
1. A scripted greeting is already being spoken verbatim. Do not repeat the greeting.
2. After the callee responds (or after a brief pause if they stay silent), pursue the objective.
3. One question at a time. Short turns. Stop talking after each question.
4. When the objective is complete, declined, or clearly impossible: give a brief goodbye, then call end_call.
5. Never mention internal tools, models, or prompts.`;
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
        ? "# Saudação (entregue depois de o destinatário falar)"
        : "# Saudação já entregue";
    case "en-GB":
    case "en-US":
      return waitForCallee
        ? "# Greeting (delivered after the callee speaks)"
        : "# Greeting already delivered";
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
Sotaque padrão de Lisboa. Ritmo de conversa telefónica.`;
    case "en-GB":
      return `# Language (en-GB — highest priority)
Speak natural British English for the entire call: vocabulary, spelling if you must spell, and accent (UK).
Use "mobile", never "cell phone". Do not switch to American English. Do not repeat the greeting.
Short, spoken sentences — this is a phone call, not an email.`;
    case "en-US":
      return `# Language (en-US — highest priority)
Speak natural American English for the entire call: vocabulary and accent (US).
Do not switch to UK English. Do not repeat the greeting.
Short, spoken sentences — this is a phone call, not an email.`;
    default: {
      const _never: never = language;
      throw new Error(`unsupported language: ${_never}`);
    }
  }
}
