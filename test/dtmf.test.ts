import { describe, expect, it, vi } from "vitest";
import { parseDtmfDigits, digitsFromToolArguments, executeSendDtmf, MAX_DTMF_DIGITS } from "../src/dtmf.js";

describe("DTMF digits", () => {
  it("accepts 0-9 A-D * # and rejects other characters", () => {
    expect(parseDtmfDigits("1#")).toEqual({ ok: true, digits: "1#" });
    expect(parseDtmfDigits(" *0 ")).toEqual({ ok: true, digits: "*0" });
    expect(parseDtmfDigits("ab")).toEqual({ ok: true, digits: "AB" });
    expect(parseDtmfDigits("1 2 3")).toEqual({ ok: true, digits: "123" });
    expect(parseDtmfDigits("abc!")).toEqual({ ok: false, error: "invalid_digits" });
    expect(parseDtmfDigits("")).toEqual({ ok: false, error: "invalid_digits" });
    expect(parseDtmfDigits("1".repeat(MAX_DTMF_DIGITS + 1))).toEqual({
      ok: false,
      error: "invalid_digits",
    });
  });

  it("reads digits from realtime tool arguments JSON", () => {
    expect(digitsFromToolArguments('{"digits":"9"}')).toBe("9");
    expect(digitsFromToolArguments({ digits: "0" })).toBe("0");
    expect(digitsFromToolArguments("not-json")).toBeUndefined();
  });

  it("calls Telnyx sendDtmf and does not treat digits as secrets", async () => {
    const sendDtmf = vi.fn(async () => undefined);
    const result = await executeSendDtmf({
      telnyx: { dial: vi.fn(), hangup: vi.fn(), sendDtmf },
      callControlId: "v2:control",
      callId: "call-1",
      arguments: JSON.stringify({ digits: "12#" }),
    });
    expect(result).toEqual({ ok: true, digits: "12#" });
    expect(sendDtmf).toHaveBeenCalledWith("v2:control", "12#");
  });
});
