import type { Language } from "./prompt.js";

export const DEFAULT_TIMEZONE = "Europe/Lisbon";
export const MAX_SPOKEN_ASK_CHARS = 140;

const TIME_PHRASE =
  /\b(bom dia|boa tarde|boa noite|good morning|good afternoon|good evening)\b/i;
const LEADING_HELLO = /^(olá|ola|hello)\s*[,.]?\s*/i;
const LEADING_TIME =
  /^(bom dia|boa tarde|boa noite|good morning|good afternoon|good evening)\s*[,.]?\s*/i;

/** Opening verbs that are already a natural spoken ask — do not wrap with «ligo sobre». */
const SPOKEN_ASK_VERB =
  /^(confirmar|confirma|pedir|peça|marcar|agendar|ligar|ligo|quero|gostaria|preciso|confirm|please|i\b|we\b|calling|call|ask)\b/i;

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

/**
 * Spoken force_message text only: Olá/Hello + time-of-day + brief persona + a short
 * natural ask. Never dumps ROLEPLAY, system instructions, markdown, or the raw objective.
 */
export function composeSpokenGreeting(input: {
  language: Language;
  greeting?: string;
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
  const persona = sanitizePersona(input.greeting ?? "");
  const ask = spokenAskFromObjective({
    language: input.language,
    objective: input.objective,
    ...(input.spokenAsk !== undefined ? { spokenAsk: input.spokenAsk } : {}),
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

export function spokenAskFromObjective(input: {
  language: Language;
  objective: string;
  spokenAsk?: string;
}): string {
  const explicit = input.spokenAsk?.trim();
  if (explicit) {
    const fromExplicit = toSpokenAsk(extractCleanProse(explicit), input.language);
    if (fromExplicit && isCleanSpokenProse(fromExplicit)) return fromExplicit;
  }
  return toSpokenAsk(extractCleanProse(input.objective), input.language);
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
  if (!looksLikePromptScript(trimmed) && !trimmed.includes("\n") && !/\broleplay\b/i.test(trimmed)) {
    return stripMarkdown(trimmed);
  }
  const extracted = extractCleanProse(trimmed, { allowLong: true });
  if (!extracted || /\broleplay\b/i.test(extracted)) return "";
  return extracted;
}

function extractCleanProse(text: string, opts: { allowLong?: boolean } = {}): string {
  const raw = text.trim();
  if (!raw) return "";
  const parts: string[] = [];
  for (const line of raw.split(/\n/)) {
    const unwrapped = unwrapScriptLine(line);
    if (unwrapped === undefined) continue;
    const cleaned = stripMarkdown(unwrapped);
    if (!cleaned) continue;
    if (!isCleanSpokenProse(cleaned)) continue;
    parts.push(cleaned);
  }
  const joined = parts.join(" ").replace(/\s+/g, " ").trim();
  if (!joined || /\broleplay\b/i.test(joined)) return "";
  const sentence = firstSpokenSentence(joined);
  if (!sentence) return "";
  if (!opts.allowLong && sentence.length > MAX_SPOKEN_ASK_CHARS) {
    return clipSpoken(sentence, MAX_SPOKEN_ASK_CHARS);
  }
  return sentence;
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
    .replace(/\s+/g, " ")
    .trim();
  return cleaned;
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
