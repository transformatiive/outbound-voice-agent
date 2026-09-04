import { describe, expect, it } from "vitest";
import { parseOutboundBody } from "../src/outbound.js";

const base = {
  to: "+351912345678",
  language: "pt-PT",
  greeting: "Olá, fala a secretária.",
  objective: "Confirmar a marcação de quinta às 16h",
};

describe("parseOutboundBody waitForCallee", () => {
  it("defaults waitForCallee to false when omitted", () => {
    const parsed = parseOutboundBody(base);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.waitForCallee).toBe(false);
  });

  it("accepts explicit waitForCallee true", () => {
    const parsed = parseOutboundBody({ ...base, waitForCallee: true });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.waitForCallee).toBe(true);
  });

  it("keeps explicit waitForCallee false even if instructions mention waiting", () => {
    const parsed = parseOutboundBody({
      ...base,
      waitForCallee: false,
      instructions: "Wait silently until the callee speaks, then greet.",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.waitForCallee).toBe(false);
  });

  it("infers waitForCallee from instructions when the flag is omitted", () => {
    const pt = parseOutboundBody({
      ...base,
      instructions: "Espera em silêncio até o destinatário falar (por exemplo Estou).",
    });
    expect(pt.ok).toBe(true);
    if (!pt.ok) return;
    expect(pt.value.waitForCallee).toBe(true);

    const en = parseOutboundBody({
      ...base,
      language: "en-GB",
      greeting: "Hello, this is the secretary.",
      instructions: "Wait silently until the callee speaks before you greet.",
    });
    expect(en.ok).toBe(true);
    if (!en.ok) return;
    expect(en.value.waitForCallee).toBe(true);
  });

  it("rejects non-boolean waitForCallee", () => {
    const parsed = parseOutboundBody({ ...base, waitForCallee: "true" });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatchObject({ status: 400, error: "invalid_waitForCallee" });
  });
});
