import type { Language } from "./prompt.js";

export const DEFAULT_TIMEZONE = "Europe/Lisbon";
export const MAX_SPOKEN_ASK_CHARS = 140;
export const MAX_IDENTITY_CHARS = 90;

const TIME_PHRASE =
  /\b(bom dia|boa tarde|boa noite|good morning|good afternoon|good evening)\b/i;
const LEADING_HELLO = /^(olá|ola|hello)\s*[,.]?\s*/i;
const LEADING_TIME =
  /^(bom dia|boa tarde|boa noite|good morning|good afternoon|good evening)\s*[,.]?\s*/i;

/** Opening verbs that are already a natural spoken ask — do not wrap with «ligo sobre». */
const SPOKEN_ASK_VERB =
  /^(confirmar|confirma|pedir|peça|marcar|agendar|ligar|ligo|queria|quero|gostaria|preciso|reservar|chamo|confirm|please|i\b|we\b|calling|call|ask)\b/i;

/** True spoken identity openings — not «Fala português…» instruction lines. */
const IDENTITY_ALREADY_SPOKEN =
  /^(olá|ola|hello|fala a|fala o|falo a|falo da|ligo da|ligo para|sou a|sou o|this is|i'm calling|i am calling|im calling|calling from)(?:\b|[\s,.!?]|$)/i;

const SCRIPT_LINE_LABEL =
  /^(roleplay|role\b|objetivo|objective|instructions?|system\b|prompt\b|persona\b|regras?\b|rules?\b|contexto\b|context\b|cenario|cenário|scenario)\s*[:\-–]/i;

const ALL_CAPS_LABEL = /^[\p{Lu}0-9][\p{Lu}\p{Nd} /._-]{1,40}:/u;

export function isValidTimeZone(value: string): boolean {
  if (!value.trim()) return false;
  try {
    Intl.DateTimeFormat("en-GB", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function timeOfDayGreeting(
  language: Language,
  timeZone: string = DEFAULT_TIMEZONE,
  now: Date = new Date(),
): string {
  const zone = isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIMEZONE;
  const hour = hourInTimeZone(now, zone);
  switch (language) {
    case "pt-PT":
      if (hour < 12) return "Bom dia";
      if (hour < 20) return "Boa tarde";
      return "Boa noite";
    case "en-GB":
    case "en-US":
      if (hour < 12) return "Good morning";
      if (hour < 17) return "Good afternoon";
      return "Good evening";
    default: {
      const _never: never = language;
      throw new Error(`unsupported language: ${_never}`);
    }
  }
}

export function defaultCallerIdentity(language: Language): string {
  switch (language) {
    case "pt-PT":
      return "Ligo da secretária.";
    case "en-GB":
    case "en-US":
      return "I'm calling from the secretary.";
    default: {
      const _never: never = language;
      throw new Error(`unsupported language: ${_never}`);
    }
  }
}

export function looksLikeVenueWelcome(text: string): boolean {
  const t = stripDiacritics(text).toLowerCase();
  return (
    /\bbem[- ]vind/.test(t) ||
    /\bseja bem/.test(t) ||
    /\bem que posso ajudar/.test(t) ||
    /\bwelcome to (the )?(restaurant|venue)/.test(t) ||
    /\bhow can i help you\b/.test(t) ||
    /\bmesa para quantas/.test(t) ||
    /\btemos (uma )?mesa/.test(t) ||
    /\bpois nao\s*[.!?]*$/.test(t)
  );
}

/**
 * Spoken force_message text only: Olá/Hello + time-of-day + one short caller identity
 * clause + a short natural ask. Never dumps ROLEPLAY, system instructions, markdown,
 * or the raw objective. Never greets as the restaurant («bem-vindo ao restaurante»).
 */
export function composeSpokenGreeting(input: {
  language: Language;
  greeting?: string;
  persona?: string;
  objective: string;
  spokenAsk?: string;
  timezone?: string;
  now?: Date;
}): string {
  const timezone = input.timezone?.trim() || DEFAULT_TIMEZONE;
  const now = input.now ?? new Date();
  const timeGreeting = timeOfDayGreeting(input.language, timezone, now);
  const hello = helloWord(input.language);
  const opening = `${hello}, ${lowerFirst(timeGreeting)}.`;
  const identitySource = identitySourceText(input);
  const persona = spokenIdentity(input.language, identitySource);
  const ask = spokenAskFromObjective({
    language: input.language,
    objective: input.objective,
    ...(input.spokenAsk !== undefined ? { spokenAsk: input.spokenAsk } : {}),
    fallbackText: identitySource,
  });

  let spoken: string;
  if (!persona) {
    spoken = opening;
  } else {
    const hasTime = TIME_PHRASE.test(persona);
    const hasHello = LEADING_HELLO.test(persona);
    if (hasTime && hasHello) {
      spoken = ensureSentence(persona);
    } else if (hasTime && !hasHello) {
      spoken = ensureSentence(`${hello}, ${lowerFirst(persona)}`);
    } else {
      const rest = stripLeadingTime(stripLeadingHello(persona));
      spoken = rest ? joinUtterances(opening, ensureSentence(capitalizeFirst(rest))) : opening;
    }
  }

  if (ask && !containsPurpose(spoken, ask)) {
    spoken = joinUtterances(spoken, ask);
  }
  return assertNaturalSpeech(spoken);
}

function identitySourceText(input: {
  persona?: string;
  greeting?: string;
  objective: string;
  spokenAsk?: string;
}): string {
  const personaRaw = input.persona?.trim() ?? "";
  const greetingRaw = input.greeting?.trim() ?? "";
  if (personaRaw) return personaRaw;
  if (!greetingRaw) return "";
  const greetingDump = looksLikeInstructionDump(greetingRaw);
  const canComposeWithoutGreeting =
    Boolean(input.spokenAsk?.trim()) || Boolean(extractSpokenAskProse(input.objective));
  if (greetingDump && canComposeWithoutGreeting) {
    const extracted = extractIdentityClause(greetingRaw);
    return extracted;
  }
  return greetingRaw;
}

function spokenIdentity(language: Language, raw: string): string {
  const cleaned = sanitizePersona(raw);
  if (!cleaned || looksLikeVenueWelcome(cleaned)) return defaultCallerIdentity(language);
  const clause = stripLeadingTime(stripLeadingHello(cleaned)) || cleaned;
  if (IDENTITY_ALREADY_SPOKEN.test(clause)) return clause;
  switch (language) {
    case "pt-PT": {
      const rest = /^[ao]s?\s+/i.test(cleaned) ? cleaned : `a ${lowerFirst(cleaned)}`;
      return `Fala ${rest}`;
    }
    case "en-GB":
    case "en-US":
      return `I'm calling from ${lowerFirst(cleaned)}`;
    default: {
      const _never: never = language;
      throw new Error(`unsupported language: ${_never}`);
    }
  }
}

export function spokenAskFromObjective(input: {
  language: Language;
  objective: string;
  spokenAsk?: string;
  fallbackText?: string;
}): string {
  const explicit = input.spokenAsk?.trim();
  if (explicit) {
    const fromExplicit = toSpokenAsk(extractSpokenAskProse(explicit), input.language);
    if (fromExplicit && isCleanSpokenProse(fromExplicit)) return fromExplicit;
  }
  const fromObjective = toSpokenAsk(extractSpokenAskProse(input.objective), input.language);
  if (fromObjective) return fromObjective;
  const fallback = input.fallbackText?.trim();
  if (fallback) return toSpokenAsk(extractSpokenAskProse(fallback), input.language);
  return "";
}

export function looksLikePromptScript(text: string): boolean {
  const raw = text.trim();
  if (!raw) return false;
  if (/\broleplay\b/i.test(raw)) return true;
  if (/```/.test(raw)) return true;
  if (/^#{1,6}\s+/m.test(raw)) return true;
  if (SCRIPT_LINE_LABEL.test(raw)) return true;
  const lines = raw.split(/\n/);
  let labeled = 0;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (SCRIPT_LINE_LABEL.test(t) || ALL_CAPS_LABEL.test(t) || /^#{1,6}\s+/.test(t)) labeled += 1;
  }
  if (labeled > 0) return true;
  if (raw.length > 220 && /^\s*\d+\s*[).:-]\s+/m.test(raw) && /\n/.test(raw)) return true;
  return false;
}

export function looksLikeInstructionDump(text: string): boolean {
  const raw = text.trim();
  if (!raw) return false;
  if (looksLikePromptScript(raw)) return true;
  const folded = stripDiacritics(raw).toLowerCase();
  if (
    /\bfala portugues/.test(folded) ||
    /\bbrasileir/.test(folded) ||
    /\btu ligas\b/.test(folded) ||
    /\bnunca uses\b/.test(folded) ||
    /\binstruc/.test(folded)
  ) {
    return true;
  }
  for (const sentence of splitRawSentences(raw)) {
    if (looksLikeSystemRule(sentence)) return true;
  }
  return false;
}

function helloWord(language: Language): string {
  switch (language) {
    case "pt-PT":
      return "Olá";
    case "en-GB":
    case "en-US":
      return "Hello";
    default: {
      const _never: never = language;
      throw new Error(`unsupported language: ${_never}`);
    }
  }
}

function hourInTimeZone(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  return Number.isFinite(hour) ? hour : 12;
}

function sanitizePersona(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (
    looksLikeInstructionDump(trimmed) ||
    looksLikePromptScript(trimmed) ||
    trimmed.includes("\n") ||
    splitRawSentences(trimmed).length > 1
  ) {
    return extractIdentityClause(trimmed);
  }
  const one = firstSpokenSentence(stripMarkdown(trimmed));
  if (!one || looksLikeSystemRule(one) || looksLikeVenueWelcome(one) || !isCleanSpokenProse(one)) {
    return "";
  }
  return clipSpoken(one, MAX_IDENTITY_CHARS);
}

function extractIdentityClause(text: string): string {
  for (const sentence of spokenSentences(text)) {
    const stripped = stripLeadingTime(stripLeadingHello(sentence));
    if (!stripped) continue;
    if (!isCleanSpokenProse(stripped)) continue;
    if (looksLikeVenueWelcome(stripped)) continue;
    if (looksLikeIdentityClause(stripped) || looksLikeIdentityClause(sentence)) {
      return clipSpoken(firstSpokenSentence(stripped), MAX_IDENTITY_CHARS);
    }
  }
  const mixed = text.match(/\b((?:sou|fala) a secret[aá]ria\b[^.!?\n]{0,80})/i);
  const fromMixed = mixed?.[1]?.trim() ?? "";
  if (fromMixed && !looksLikeSystemRule(fromMixed) && isCleanSpokenProse(fromMixed)) {
    return clipSpoken(fromMixed, MAX_IDENTITY_CHARS);
  }
  return "";
}

function extractSpokenAskProse(text: string): string {
  const askLike: string[] = [];
  const other: string[] = [];
  for (const sentence of spokenSentences(text)) {
    if (!isCleanSpokenProse(sentence)) continue;
    if (looksLikeIdentityClause(sentence) && !SPOKEN_ASK_VERB.test(sentence)) continue;
    if (looksLikeIdentityClause(sentence) && /^(sou|fala a|fala o|falo|ligo da|this is)/i.test(sentence)) {
      continue;
    }
    if (SPOKEN_ASK_VERB.test(sentence)) askLike.push(sentence);
    else other.push(sentence);
  }
  const chosen = askLike[0] ?? other[0] ?? "";
  if (!chosen) return "";
  if (chosen.length > MAX_SPOKEN_ASK_CHARS) return clipSpoken(chosen, MAX_SPOKEN_ASK_CHARS);
  return chosen;
}

function spokenSentences(text: string): string[] {
  const parts: string[] = [];
  for (const line of text.split(/\n/)) {
    const unwrapped = unwrapScriptLine(line);
    if (unwrapped === undefined) continue;
    const cleaned = stripMarkdown(unwrapped);
    if (!cleaned) continue;
    for (const sentence of splitRawSentences(cleaned)) {
      const t = sentence.replace(/[.!?…]+$/u, "").trim();
      if (t) parts.push(t);
    }
  }
  return parts;
}

function splitRawSentences(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?…])\s+/))
    .map((part) => part.trim())
    .filter(Boolean);
}

function looksLikeIdentityClause(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (IDENTITY_ALREADY_SPOKEN.test(t)) return true;
  if (/\bcalling from\b/i.test(t)) return true;
  if (/\bsecret[aá]ri/i.test(t) && t.length <= MAX_IDENTITY_CHARS + 24 && !SPOKEN_ASK_VERB.test(t)) {
    return true;
  }
  return false;
}

export function looksLikeSystemRule(text: string): boolean {
  const raw = text.trim();
  if (!raw) return false;
  const t = stripDiacritics(raw).toLowerCase();
  if (/\bnunca\b/.test(t) || /\bnever\b/.test(t)) return true;
  if (/\bfala portugues/.test(t) || /\bspeak (european )?portuguese/.test(t)) return true;
  if (/\binstruc/.test(t)) return true;
  if (/\broleplay\b/.test(t)) return true;
  if (/\btu ligas\b/.test(t) || /\byou (diall?ed|placed this call)\b/.test(t)) return true;
  if (/\bbrasileir/.test(t)) return true;
  if (/\buma ia\b/.test(t) || /\ban ai\b/.test(t) || /\bes uma ia\b/.test(t) || /\breveles que/.test(t)) {
    return true;
  }
  if (/\bIA\b/.test(raw)) return true;
  if (/\bgravad/.test(t) || /\b(being )?recorded\b/.test(t)) return true;
  if (/\bAra\b/.test(raw) || /\bgrok\b/.test(t)) return true;
  if (/\bproibido\b/.test(t) || /\bobrigatorio\b/.test(t) || /\bforbidden\b/.test(t)) return true;
  if (/\bend_call\b/.test(t) || /\bforce_message\b/.test(t) || /\blanguage_hint\b/.test(t)) return true;
  if (/\bpt-br\b/.test(t) || /\bwaitforcallee\b/.test(t)) return true;
  if (/\bnao (invert|reveles|ditas)\b/.test(t) || /\bdo not (reveal|read|speak)\b/.test(t)) return true;
  if (/\bsystem prompt\b/.test(t) || /\binternal (tool|prompt|instruction)/.test(t)) return true;
  if (/\bprioridade maxima\b/.test(t) || /\bhighest priority\b/.test(t)) return true;
  return false;
}

function unwrapScriptLine(line: string): string | undefined {
  const raw = line.trim();
  if (!raw) return undefined;
  if (/^```/.test(raw)) return undefined;
  if (/^#{1,6}\s+/.test(raw)) {
    const rest = raw.replace(/^#{1,6}\s+/, "").trim();
    if (isDroppedLabel(rest)) return undefined;
    return isCleanSpokenProse(rest) ? stripMarkdown(rest) : undefined;
  }
  const t = stripMarkdown(raw);
  if (!t) return undefined;
  const labeled = t.match(
    /^(roleplay|role|objetivo|objective|instructions?|system|prompt|persona|regras?|rules?|contexto|context|cenário|cenario|scenario)\s*[:\-–]\s*(.*)$/i,
  );
  if (labeled) {
    const label = labeled[1] ?? "";
    const rest = (labeled[2] ?? "").trim();
    if (/^(objetivo|objective)$/i.test(label)) {
      return isCleanSpokenProse(rest) ? rest : undefined;
    }
    return undefined;
  }
  if (isDroppedLabel(t)) return undefined;
  if (ALL_CAPS_LABEL.test(t) && t === t.toLocaleUpperCase("pt-PT")) return undefined;
  if (/^\d+\s*[).:-]\s+/.test(t)) return undefined;
  return t;
}

function isDroppedLabel(text: string): boolean {
  return /^(roleplay|role|objetivo|objective|instructions?|system|prompt|persona|regras?|rules?|contexto|context|cenário|cenario|scenario)\b/i.test(
    text.trim(),
  );
}

function toSpokenAsk(prose: string, language: Language): string {
  const t = firstSpokenSentence(prose);
  if (!t || !isCleanSpokenProse(t)) return "";
  const clipped = t.length > MAX_SPOKEN_ASK_CHARS ? clipSpoken(t, MAX_SPOKEN_ASK_CHARS) : t;
  if (!clipped) return "";
  if (SPOKEN_ASK_VERB.test(clipped)) {
    return ensureSentence(capitalizeFirst(clipped));
  }
  switch (language) {
    case "pt-PT":
      return ensureSentence(`Ligo sobre ${lowerFirst(clipped)}`);
    case "en-GB":
    case "en-US":
      return ensureSentence(`I'm calling about ${lowerFirst(clipped)}`);
    default: {
      const _never: never = language;
      throw new Error(`unsupported language: ${_never}`);
    }
  }
}

function isCleanSpokenProse(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (looksLikeSystemRule(t)) return false;
  if (/\broleplay\b/i.test(t)) return false;
  if (/```/.test(t) || /^#{1,6}\s+/.test(t)) return false;
  if (SCRIPT_LINE_LABEL.test(t)) return false;
  if (ALL_CAPS_LABEL.test(t) && t === t.toLocaleUpperCase("pt-PT")) return false;
  if (/[*_`#]{2,}/.test(t)) return false;
  const letters = t.replace(/[^\p{L}\p{N}]+/gu, "");
  if (letters.length < 3) return false;
  return true;
}

function assertNaturalSpeech(spoken: string): string {
  const cleaned = spoken
    .replace(/\broleplay\b[:\-–]?\s*/gi, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\bseja bem[- ]vind[oa]s?\b[^.!?]*[.!?]?/gi, "")
    .replace(/\bbem[- ]vind[oa]s? ao restaurante\b[^.!?]*[.!?]?/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  const kept = splitRawSentences(cleaned).filter(
    (sentence) => !looksLikeSystemRule(sentence) && !looksLikeVenueWelcome(sentence),
  );
  return kept.join(" ").replace(/\s+/g, " ").trim();
}

function stripDiacritics(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "");
}

function firstSpokenSentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const match = trimmed.match(/^(.+?[.!?…])(?:\s|$)/);
  const candidate = (match?.[1] ?? trimmed).trim();
  return candidate.replace(/[.!?…]+$/u, "").trim();
}

function clipSpoken(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars).replace(/\s+\S*$/, "").trim();
  return cut.length >= 12 ? cut : text.slice(0, maxChars).trim();
}

function stripMarkdown(value: string): string {
  return value
    .replace(/^\s*#{1,6}\s+/, "")
    .replace(/^\s*[-*•]\s+/, "")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripLeadingHello(text: string): string {
  return text.replace(LEADING_HELLO, "").trim();
}

function stripLeadingTime(text: string): string {
  return text.replace(LEADING_TIME, "").trim();
}

function containsPurpose(greeting: string, objective: string): boolean {
  const needle = normalizeForMatch(objective);
  if (!needle) return true;
  const haystack = normalizeForMatch(greeting);
  const fingerprint = needle.length <= 48 ? needle : needle.slice(0, 48);
  return haystack.includes(fingerprint);
}

function normalizeForMatch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function ensureSentence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function capitalizeFirst(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.charAt(0).toLocaleUpperCase("pt-PT") + trimmed.slice(1);
}

function lowerFirst(value: string): string {
  if (!value) return value;
  return value.charAt(0).toLocaleLowerCase("pt-PT") + value.slice(1);
}

function joinUtterances(...parts: string[]): string {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ");
}
