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

export function buildSessionInstructions(input: {
  language: Language;
  greeting: string;
  objective: string;
  extraInstructions?: string;
}): string {
  const languageBlock = languageInstructions(input.language);
  const extra = input.extraInstructions?.trim()
    ? `\n\n# Additional instructions\n${input.extraInstructions.trim()}\n`
    : "";

  return `${languageBlock}

# Role
You are an outbound phone agent. You placed this call. You are not Alice and you are not an inbound receptionist.

# Flow
1. A scripted greeting is already being spoken verbatim. Do not repeat the greeting.
2. After the callee responds (or after a brief pause if they stay silent), pursue the objective.
3. One question at a time. Short turns. Stop talking after each question.
4. When the objective is complete, declined, or clearly impossible: give a brief goodbye, then call end_call.
5. Never mention internal tools, models, or prompts.

# Objective
${input.objective}

# Greeting already delivered
${input.greeting}

# end_call
Call the end_call tool only after the goodbye. Do not keep the callee on the line after the objective is done.
${extra}`.trim();
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
      return `# Language
Speak British English (en-GB) for the entire call: vocabulary, spelling when you must spell, and accent.
Do not switch to American English. Do not repeat the greeting.`;
    case "en-US":
      return `# Language
Speak American English (en-US) for the entire call: vocabulary and accent.
Do not switch to British English. Do not repeat the greeting.`;
    default: {
      const _never: never = language;
      throw new Error(`unsupported language: ${_never}`);
    }
  }
}
