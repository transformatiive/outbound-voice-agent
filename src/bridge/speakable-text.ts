/** Split a streaming assistant transcript into finished sentences vs a trailing fragment. */
export function takeCompleteSentences(buffer: string): { complete: string[]; rest: string } {
  const text = buffer.trimStart();
  if (!text) return { complete: [], rest: "" };
  const pieces = text.split(/(?<=[.!?…])\s+/);
  if (pieces.length === 1) {
    const only = (pieces[0] ?? "").trim();
    if (/[.!?…]$/.test(only)) return { complete: [only], rest: "" };
    return { complete: [], rest: text };
  }
  const last = (pieces[pieces.length - 1] ?? "").trim();
  const head = pieces
    .slice(0, -1)
    .map((part) => part.trim())
    .filter(Boolean);
  if (/[.!?…]$/.test(last)) {
    if (last) head.push(last);
    return { complete: head, rest: "" };
  }
  return { complete: head, rest: last };
}

/** Text in `full` that has not already been spoken as `spoken` (prefix match). */
export function remainingUnspoken(full: string, spoken: string): string {
  const f = full.trim();
  const s = spoken.trim();
  if (!f) return "";
  if (!s) return f;
  if (f === s) return "";
  if (f.startsWith(s)) return f.slice(s.length).replace(/^\s+/, "");
  return "";
}
