import type { Language } from "./prompt.js";

export const DEFAULT_TIMEZONE = "Europe/Lisbon";

const TIME_PHRASE =
  /\b(bom dia|boa tarde|boa noite|good morning|good afternoon|good evening)\b/i;
const LEADING_HELLO = /^(olá|ola|hello)\s*[,.]?\s*/i;
const LEADING_TIME =
  /^(bom dia|boa tarde|boa noite|good morning|good afternoon|good evening)\s*[,.]?\s*/i;

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

export function composeSpokenGreeting(input: {
  language: Language;
  greeting?: string;
  objective: string;
  timezone?: string;
  now?: Date;
}): string {
  const timezone = input.timezone?.trim() || DEFAULT_TIMEZONE;
  const now = input.now ?? new Date();
  const timeGreeting = timeOfDayGreeting(input.language, timezone, now);
  const hello = helloWord(input.language);
  const opening = `${hello}, ${lowerFirst(timeGreeting)}.`;
  const objective = ensureSentence(input.objective.trim());
  const raw = input.greeting?.trim() ?? "";

  if (!raw) {
    return joinUtterances(opening, objective);
  }

  const hasTime = TIME_PHRASE.test(raw);
  const hasHello = LEADING_HELLO.test(raw);
  let spoken: string;

  if (hasTime && hasHello) {
    spoken = ensureSentence(raw);
  } else if (hasTime && !hasHello) {
    spoken = ensureSentence(`${hello}, ${lowerFirst(raw)}`);
  } else {
    const rest = stripLeadingTime(stripLeadingHello(raw));
    spoken = rest ? joinUtterances(opening, ensureSentence(capitalizeFirst(rest))) : opening;
  }

  if (objective && !containsPurpose(spoken, objective)) {
    spoken = joinUtterances(spoken, ensureSentence(capitalizeFirst(objective)));
  }
  return spoken;
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
