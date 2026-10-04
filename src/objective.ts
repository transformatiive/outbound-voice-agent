import type { Language } from "./prompt.js";

export const TABLE_FACT_ORDER = ["intent", "party_size", "time", "name"] as const;
export type TableFactKey = (typeof TABLE_FACT_ORDER)[number];

export type ObjectiveKind = "table" | "appointment" | "message" | "other";

export type ObjectiveFacts = {
  kind: ObjectiveKind;
  partySize?: string;
  time?: string;
  name?: string;
  date?: string;
  venue?: string;
};

/** After the opener, if the callee stays silent this long, advance one fact. */
export const DEFAULT_SILENCE_ADVANCE_MS = 1200;

const PT_NUM: Record<string, string> = {
  um: "1",
  uma: "1",
  dois: "2",
  duas: "2",
  tres: "3",
  três: "3",
  quatro: "4",
  cinco: "5",
  seis: "6",
  sete: "7",
  oito: "8",
  nove: "9",
  dez: "10",
};

const PT_SPOKEN_COUNT: Record<string, string> = {
  "1": "uma",
  "2": "duas",
  "3": "três",
  "4": "quatro",
  "5": "cinco",
  "6": "seis",
  "7": "sete",
  "8": "oito",
  "9": "nove",
  "10": "dez",
};

export function parseObjectiveFacts(objective: string): ObjectiveFacts {
  const raw = objective.trim();
  const folded = stripDiacritics(raw).toLowerCase();
  const kind = classifyObjective(folded);
  const facts: ObjectiveFacts = { kind };
  const party = extractPartySize(folded, raw);
  if (party) facts.partySize = party;
  const time = extractClockTime(folded, raw);
  if (time) facts.time = time;
  const name = extractGuestName(raw);
  if (name) facts.name = name;
  const date = extractDateToken(folded);
  if (date) facts.date = date;
  const venue = extractVenue(raw);
  if (venue) facts.venue = venue;
  return facts;
}

export function classifyObjective(folded: string): ObjectiveKind {
  if (
    /\bmesa\b/.test(folded) ||
    /\bjantar\b/.test(folded) ||
    /\balmoco\b/.test(folded) ||
    /\brestaurante\b/.test(folded) ||
    /\btable\b/.test(folded) ||
    /\bdinner\b/.test(folded)
  ) {
    return "table";
  }
  if (/\brecado\b/.test(folded) || /\bmensagem\b/.test(folded) || /\bmessage\b/.test(folded)) {
    return "message";
  }
  if (
    /\b(marcacao|consulta|agendar|oficina|otorrino|pneus|appointment|booking)\b/.test(folded) ||
    /\bconfirm/.test(folded)
  ) {
    return "appointment";
  }
  return "other";
}

/**
 * Fixed first line: time-of-day + a short question. Never persona, never the
 * objective dump, never party size / clock time / guest name / venue.
 */
export function fixedSpokenOpener(
  language: Language,
  facts: ObjectiveFacts,
  timeGreeting: string,
): string {
  const ask = openerAsk(language, facts);
  return `${ensureSentence(timeGreeting)} ${ask}`;
}

export function openerLeaksBookingFacts(spoken: string, facts: ObjectiveFacts): boolean {
  const folded = stripDiacritics(spoken).toLowerCase();
  if (facts.partySize) {
    const n = facts.partySize;
    const word = PT_SPOKEN_COUNT[n];
    if (new RegExp(String.raw`\b${escapeRegExp(n)}\b`).test(folded)) return true;
    if (word && new RegExp(String.raw`\b${escapeRegExp(stripDiacritics(word))}\b`).test(folded)) {
      return true;
    }
  }
  if (facts.time) {
    const clock = facts.time.replace(/^às\s+/i, "");
    if (folded.includes(stripDiacritics(clock).toLowerCase())) return true;
  }
  if (facts.name) {
    for (const part of facts.name.split(/\s+/).filter((w) => w.length >= 3)) {
      if (folded.includes(stripDiacritics(part).toLowerCase())) return true;
    }
  }
  if (facts.venue && folded.includes(stripDiacritics(facts.venue).toLowerCase())) return true;
  return false;
}

export type SpokenTurnReason = "answer" | "advance" | "backchannel";

export type SpokenTurnResult = {
  utterance: string;
  fact: TableFactKey | null;
  reason: SpokenTurnReason;
};

/**
 * Next spoken line after the fixed opener. One fact. If the callee asked,
 * answer that fact; if they said «diga» or waited, advance the table list.
 */
export function nextSpokenTurn(input: {
  language: Language;
  facts: ObjectiveFacts;
  spokenFacts: TableFactKey[];
  calleeText: string;
  greeting: string;
}): SpokenTurnResult {
  const callee = input.calleeText.trim();
  if (isBackchannelUtterance(callee)) {
    return { utterance: "", fact: null, reason: "backchannel" };
  }

  const asked = askedFact(callee, input.facts);
  if (asked) {
    const utterance = speakFact(input.language, input.facts, asked);
    return { utterance: rejectGreetingEcho(utterance, input.greeting), fact: asked, reason: "answer" };
  }

  const next = nextUnspokenFact(input.facts, input.spokenFacts);
  if (!next) {
    return { utterance: "", fact: null, reason: "advance" };
  }
  const utterance = speakFact(input.language, input.facts, next);
  return { utterance: rejectGreetingEcho(utterance, input.greeting), fact: next, reason: "advance" };
}

export function isBackchannelUtterance(text: string): boolean {
  const t = normalizeUtterance(text);
  return /^(hum|hmm|hann?|ah|aah|ok|okay)$/.test(t);
}

export function isGoAheadUtterance(text: string): boolean {
  const t = normalizeUtterance(text);
  if (!t) return true;
  return /^(diga|pode falar|pode dizer|pois|estou|alo|sim|ola)$/.test(t);
}

export function formatObjectiveFacts(language: Language, facts: ObjectiveFacts, raw: string): string {
  switch (language) {
    case "pt-PT":
      return formatFactsPt(facts, raw);
    case "en-GB":
    case "en-US":
      return formatFactsEn(facts, raw);
    default: {
      const _never: never = language;
      throw new Error(`unsupported language: ${_never}`);
    }
  }
}

export function speakingSpecInstructions(language: Language): string {
  switch (language) {
    case "pt-PT":
      return `# Spec de fala (hard lock)
Um bot, muitos objectivos. A forma de falar é partilhada. O objectivo é uma lista de factos internos — NUNCA texto para ler. A primeira frase já foi dita (linha fixa); não a montes outra vez a partir da persona ou do objectivo.
Um facto por turno. Nunca dois factos na mesma frase. Primeiro responde ao que a pessoa disse; só depois continua a lista.
Se a pessoa não perguntar — só disser «diga» ou ficar à espera — avança sozinha, um facto, e espera. Reserva de mesa, ordem: (1) que se quer uma mesa (2) pessoas (3) hora (4) nome.
«hum», «ah» ou «ok» sozinhos não são fim de turno nem interrupção: continua a escutar. Não fiques em silêncio ~2 segundos. Uma ou duas frases curtas. Só português europeu. Preenchimentos naturais (olá, pois, ok, hum) sem os empilhar.
Não ditas que a conversa está a ser registada. Agradeces antes de desligar. Voz e modelo não mudam estas regras.`;
    case "en-GB":
    case "en-US":
      return `# Speaking spec (hard lock)
One bot, many objectives. The objective is an internal fact list — NEVER text to read aloud. The first sentence is already a fixed short line; do not rebuild it from persona or objective.
One fact per turn. Never two facts in the same sentence. Answer what they just said first; only then continue the list.
If they do not ask — they only say “go ahead” or wait — advance on your own, one fact, then wait. Table booking order: (1) you want a table (2) party size (3) time (4) name.
A lone “um”, “ah”, or “ok” is not end of turn and not an interruption: keep listening. Do not sit in silence around two seconds. One or two short sentences.
Do not mention a recording notice. Thank them before hanging up. Voice and model are not part of this rule.`;
    default: {
      const _never: never = language;
      throw new Error(`unsupported language: ${_never}`);
    }
  }
}

function openerAsk(language: Language, facts: ObjectiveFacts): string {
  switch (language) {
    case "pt-PT":
      return openerAskPt(facts);
    case "en-GB":
    case "en-US":
      return openerAskEn(facts);
    default: {
      const _never: never = language;
      throw new Error(`unsupported language: ${_never}`);
    }
  }
}

function openerAskPt(facts: ObjectiveFacts): string {
  switch (facts.kind) {
    case "table":
      return facts.date && facts.date !== "hoje" ? "Tem mesa?" : "Tem mesa para hoje?";
    case "appointment":
      return "Posso confirmar uma marcação?";
    case "message":
      return "Posso deixar um recado?";
    case "other":
      return "Posso falar um momento?";
    default: {
      const _never: never = facts.kind;
      throw new Error(`unsupported objective kind: ${_never}`);
    }
  }
}

function openerAskEn(facts: ObjectiveFacts): string {
  switch (facts.kind) {
    case "table":
      return facts.date && facts.date !== "hoje" && facts.date !== "today"
        ? "Do you have a table?"
        : "Do you have a table for today?";
    case "appointment":
      return "Can I confirm an appointment?";
    case "message":
      return "May I leave a message?";
    case "other":
      return "Do you have a moment?";
    default: {
      const _never: never = facts.kind;
      throw new Error(`unsupported objective kind: ${_never}`);
    }
  }
}

function speakFact(language: Language, facts: ObjectiveFacts, fact: TableFactKey): string {
  switch (language) {
    case "pt-PT":
      return speakFactPt(facts, fact);
    case "en-GB":
    case "en-US":
      return speakFactEn(facts, fact);
    default: {
      const _never: never = language;
      throw new Error(`unsupported language: ${_never}`);
    }
  }
}

function speakFactPt(facts: ObjectiveFacts, fact: TableFactKey): string {
  switch (fact) {
    case "intent":
      return "Queria uma mesa.";
    case "party_size":
      return `Para ${spokenPartySizePt(facts.partySize ?? "")}.`;
    case "time":
      return `Às ${stripAsPrefix(facts.time ?? "")}.`;
    case "name":
      return `Em nome de ${facts.name ?? ""}.`;
    default: {
      const _never: never = fact;
      throw new Error(`unsupported table fact: ${_never}`);
    }
  }
}

function speakFactEn(facts: ObjectiveFacts, fact: TableFactKey): string {
  switch (fact) {
    case "intent":
      return "I'd like a table.";
    case "party_size":
      return `For ${facts.partySize ?? ""} people.`;
    case "time":
      return `At ${stripAsPrefix(facts.time ?? "")}.`;
    case "name":
      return `The name is ${facts.name ?? ""}.`;
    default: {
      const _never: never = fact;
      throw new Error(`unsupported table fact: ${_never}`);
    }
  }
}

function nextUnspokenFact(facts: ObjectiveFacts, spoken: TableFactKey[]): TableFactKey | null {
  const spokenSet = new Set(spoken);
  // After they asked about people / time / name, do not go back to “queria uma mesa.”
  const skipIntent = spoken.some((key) => key !== "intent");
  for (const key of TABLE_FACT_ORDER) {
    if (spokenSet.has(key)) continue;
    if (key === "intent") {
      if (skipIntent) continue;
      return key;
    }
    if (key === "party_size" && facts.partySize) return key;
    if (key === "time" && facts.time) return key;
    if (key === "name" && facts.name) return key;
  }
  return null;
}

function askedFact(callee: string, facts: ObjectiveFacts): TableFactKey | null {
  const folded = stripDiacritics(callee).toLowerCase();
  if (/\b(quantas|quantos|pessoas|how many|party size|headcount)\b/.test(folded)) {
    return facts.partySize ? "party_size" : null;
  }
  if (/\b(hora|horas|quando|que horas|what time|when)\b/.test(folded)) {
    return facts.time ? "time" : null;
  }
  if (/\b(nome|em nome|what name|whose name|reservation name)\b/.test(folded)) {
    return facts.name ? "name" : null;
  }
  if (/\b(o que (precisa|deseja|pretende)|what do you (need|want)|que (deseja|precisa))\b/.test(folded)) {
    return "intent";
  }
  return null;
}

function rejectGreetingEcho(utterance: string, greeting: string): string {
  const a = normalizeUtterance(utterance);
  const b = normalizeUtterance(greeting);
  if (a && b && (a === b || b.includes(a) && a.length > 12)) {
    return utterance;
  }
  return utterance;
}

function formatFactsPt(facts: ObjectiveFacts, raw: string): string {
  const lines = [
    "# Objetivo (dados internos — não são texto para ler em voz alta)",
    `Tipo: ${kindLabelPt(facts.kind)}`,
    "Factos — um por turno, nunca dois na mesma frase:",
    "- Pedido: quer uma mesa / avançar o objectivo",
  ];
  if (facts.partySize) lines.push(`- Pessoas: ${facts.partySize}`);
  if (facts.time) lines.push(`- Hora: ${facts.time}`);
  if (facts.name) lines.push(`- Nome: ${facts.name}`);
  if (facts.date) lines.push(`- Data: ${facts.date}`);
  if (facts.venue) lines.push(`- Sítio (interno; não ditas no primeiro turno): ${facts.venue}`);
  if (facts.kind === "table") {
    lines.push(
      "Ordem se a pessoa não perguntar (só «diga» ou espera): pedido → pessoas → hora → nome.",
    );
  }
  lines.push(
    "Se perguntar, responde a essa pergunta primeiro (um facto) e só depois continua a lista.",
  );
  if (raw.trim() && looksLikeRawDump(raw)) {
    lines.push("A fonte bruta do pedido é interna — nunca a leias.");
  }
  return lines.join("\n");
}

function formatFactsEn(facts: ObjectiveFacts, raw: string): string {
  const lines = [
    "# Objective (internal data — not text to read aloud)",
    `Kind: ${kindLabelEn(facts.kind)}`,
    "Facts — one per turn, never two in the same sentence:",
    "- Intent: you want a table / to progress the objective",
  ];
  if (facts.partySize) lines.push(`- Party size: ${facts.partySize}`);
  if (facts.time) lines.push(`- Time: ${facts.time}`);
  if (facts.name) lines.push(`- Name: ${facts.name}`);
  if (facts.date) lines.push(`- Date: ${facts.date}`);
  if (facts.venue) lines.push(`- Venue (internal; not in the opening turn): ${facts.venue}`);
  if (facts.kind === "table") {
    lines.push("If they do not ask (only “go ahead” or wait): intent → party size → time → name.");
  }
  lines.push("If they ask, answer that first (one fact), then continue the list.");
  if (raw.trim() && looksLikeRawDump(raw)) {
    lines.push("The raw request text is internal — never read it out.");
  }
  return lines.join("\n");
}

function kindLabelPt(kind: ObjectiveKind): string {
  switch (kind) {
    case "table":
      return "reserva de mesa";
    case "appointment":
      return "marcação";
    case "message":
      return "recado";
    case "other":
      return "outro";
    default: {
      const _never: never = kind;
      throw new Error(`unsupported objective kind: ${_never}`);
    }
  }
}

function kindLabelEn(kind: ObjectiveKind): string {
  switch (kind) {
    case "table":
      return "table booking";
    case "appointment":
      return "appointment";
    case "message":
      return "message";
    case "other":
      return "other";
    default: {
      const _never: never = kind;
      throw new Error(`unsupported objective kind: ${_never}`);
    }
  }
}

function extractPartySize(folded: string, raw: string): string | undefined {
  const mesaPara = folded.match(/\bmesa para\s+(\d{1,2}|duas|dois|um|uma)\b/);
  if (mesaPara?.[1]) return normalizeCount(mesaPara[1]);
  const pessoas = folded.match(
    /\b(?:para\s+)?(\d{1,2}|duas|dois|um|uma|tres|três|quatro|cinco|seis)\s+pessoas?\b/,
  );
  if (pessoas?.[1]) return normalizeCount(pessoas[1]);
  const en = raw.match(/\b(?:for|table for)\s+(\d{1,2})\b/i);
  if (en?.[1]) return String(Number(en[1]));
  return undefined;
}

function extractClockTime(folded: string, raw: string): string | undefined {
  const hm = raw.match(/\bàs?\s*(\d{1,2})(?::(\d{2}))?h?\b/i) ?? raw.match(/\b(\d{1,2}):(\d{2})\b/);
  if (hm?.[1]) {
    const hour = Number(hm[1]);
    if (hour >= 0 && hour <= 23) {
      const minute = hm[2] ?? "00";
      return `${hour}:${minute.padStart(2, "0")}`;
    }
  }
  const h = folded.match(/\bas\s+(\d{1,2})h\b/);
  if (h?.[1]) {
    const hour = Number(h[1]);
    if (hour >= 0 && hour <= 23) return `${hour}:00`;
  }
  return undefined;
}

function extractGuestName(raw: string): string | undefined {
  const named =
    raw.match(/\bem nome de\s+([^,.;\n]+)/i) ??
    raw.match(/\bnome(?:\s+da reserva)?\s*[:\-–]\s*([^,.;\n]+)/i) ??
    raw.match(/\bname(?:d)?\s+(?:is\s+)?([^,.;\n]+)/i);
  const value = named?.[1]?.trim();
  if (!value) return undefined;
  const clipped = value.replace(/\s+(hoje|amanhã|às|as|para)\b.*$/i, "").trim();
  const words = clipped.split(/\s+/).filter(Boolean).slice(0, 4);
  if (words.length === 0) return undefined;
  if (words.every((w) => /^(o|a|de|do|da|cliente|pessoa)$/i.test(w))) return undefined;
  return words.join(" ");
}

function extractDateToken(folded: string): string | undefined {
  if (/\bhoje\b/.test(folded) || /\btoday\b/.test(folded) || /\btonight\b/.test(folded)) return "hoje";
  if (/\bamanha\b/.test(folded) || /\btomorrow\b/.test(folded)) return "amanhã";
  const weekday = folded.match(
    /\b(segunda|terca|quarta|quinta|sexta|sabado|domingo)(?:-feira)?\b/,
  );
  if (weekday?.[1]) return weekday[1];
  return undefined;
}

function extractVenue(raw: string): string | undefined {
  const named = raw.match(/\bna\s+([A-ZÁÉÍÓÚÂÊÔ][\p{L}]+(?:\s+[A-ZÁÉÍÓÚÂÊÔ][\p{L}]+){0,3})/u);
  const value = named?.[1]?.trim();
  if (!value) return undefined;
  if (/^(segunda|terça|quarta|quinta|sexta|clínica|empresa)/i.test(value)) return undefined;
  return value;
}

function spokenPartySizePt(n: string): string {
  if (n === "1") return "uma pessoa";
  const word = PT_SPOKEN_COUNT[n];
  if (word) return `${word} pessoas`;
  return `${n} pessoas`;
}

function normalizeCount(value: string): string {
  const fromWord = PT_NUM[stripDiacritics(value).toLowerCase()];
  if (fromWord) return fromWord;
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : value;
}

function stripAsPrefix(value: string): string {
  return value.replace(/^às\s+/i, "").trim();
}

function looksLikeRawDump(raw: string): boolean {
  return /\broleplay\b/i.test(raw) || raw.includes("\n") || raw.length > 180;
}

function normalizeUtterance(text: string): string {
  return stripDiacritics(text)
    .toLowerCase()
    .replace(/[?!.…¿¡,;:«»""''`´]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripDiacritics(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ensureSentence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
