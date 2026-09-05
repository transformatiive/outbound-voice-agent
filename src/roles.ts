export const DEFAULT_BOT_ROLE = "caller_booking";
export const DEFAULT_CALLEE_ROLE = "venue_staff";

const MAX_ROLE_CHARS = 80;

export function parseRoleLabel(
  value: unknown,
  fallback: string,
): { ok: true; value: string } | { ok: false } {
  if (value === undefined || value === null || value === "") {
    return { ok: true, value: fallback };
  }
  if (typeof value !== "string") return { ok: false };
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: fallback };
  if (trimmed.length > MAX_ROLE_CHARS) return { ok: false };
  return { ok: true, value: trimmed };
}
