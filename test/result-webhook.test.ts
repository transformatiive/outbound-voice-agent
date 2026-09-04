import { describe, expect, it, vi } from "vitest";
import { notifyResultWebhook } from "../src/result-webhook.js";
import type { CallRecord } from "../src/calls/types.js";

describe("result webhook", () => {
  it("POSTs call outcome JSON to RESULT_WEBHOOK", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("ok", { status: 200 }));
    const call: CallRecord = {
      id: "call-1",
      status: "completed",
      to: "+351912345678",
      from: "+351210210260",
      language: "pt-PT",
      greeting: "Olá",
      objective: "Confirmar",
      voice: "ara",
      model: "grok-voice-think-fast-2.0",
      streamToken: "t",
      telnyx: { callControlId: "v2:x" },
      transcript: [{ role: "assistant", text: "Olá" }],
      endedReason: "end_call",
      createdAt: "2026-09-04T00:00:00.000Z",
      endedAt: "2026-09-04T00:01:00.000Z",
    };
    await notifyResultWebhook("https://n8n.example/hook", call, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0]?.[1];
    const body = JSON.parse(String(init?.body));
    expect(body.id).toBe("call-1");
    expect(body.origem).toBe("outbound-voice-agent");
    expect(body.status).toBe("completed");
    expect(body.endedReason).toBe("end_call");
  });

  it("does nothing when RESULT_WEBHOOK is empty", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await notifyResultWebhook(undefined, {} as CallRecord, fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
