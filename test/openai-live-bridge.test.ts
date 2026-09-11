import { describe, expect, it, vi } from "vitest";
import { GptLiveMediaBridge } from "../src/openai/live-bridge.js";
import type { CallRecord } from "../src/calls/types.js";

function sampleCall(): CallRecord {
  return {
    id: "call-1",
    status: "answered",
    to: "+351912345678",
    from: "+351210210260",
    language: "pt-PT",
    greeting: "Boa tarde, sou a secretária.",
    objective: "Confirmar quinta às 16h",
    voice: "marin",
    model: "gpt-live-1",
    ttsProvider: "gpt-live",
    streamToken: "tok",
    telnyx: { callControlId: "v2:control-id" },
    transcript: [],
    createdAt: new Date().toISOString(),
  };
}

describe("GPT-Live media bridge", () => {
  it("requests the greeting on session.started without Telnyx media until unlock", async () => {
    const liveSend = vi.fn();
    const telnyxSend = vi.fn();
    const bridge = new GptLiveMediaBridge({
      call: { ...sampleCall(), waitForCallee: true },
      sendLive: liveSend,
      sendTelnyx: telnyxSend,
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
    });
    bridge.attachTelnyx(telnyxSend);
    await bridge.onLiveEvent({ type: "session.started", session: { id: "s1" } });
    expect(liveSend.mock.calls.some((c) => c[0]?.type === "session.instructions.append")).toBe(true);
    expect(liveSend.mock.calls.some((c) => c[0]?.type === "session.commentary.append")).toBe(true);
    const instruct = liveSend.mock.calls.find((c) => c[0]?.type === "session.instructions.append")?.[0] as {
      content: string;
    };
    expect(instruct.content).toMatch(/português europeu/i);
    expect(instruct.content).toContain("Boa tarde, sou a secretária.");

    await bridge.onLiveEvent({ type: "session.output_audio.delta", delta: "UlRQQQ==" });
    expect(telnyxSend).not.toHaveBeenCalled();

    await bridge.onLiveEvent({ type: "session.input_transcript.delta", delta: "Estou" });
    expect(telnyxSend).toHaveBeenCalledWith({ event: "media", media: { payload: "UlRQQQ==" } });
  });

  it("forwards Telnyx PCMU to session.input_audio.append after the session is ready", async () => {
    const liveSend = vi.fn();
    const bridge = new GptLiveMediaBridge({
      call: sampleCall(),
      sendLive: liveSend,
      sendTelnyx: vi.fn(),
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
    });
    await bridge.onLiveEvent({ type: "session.started" });
    liveSend.mockClear();
    bridge.onTelnyxMessage({
      event: "media",
      media: { track: "inbound", payload: "QUJDRA==" },
    });
    expect(liveSend).toHaveBeenCalledWith({ type: "session.input_audio.append", audio: "QUJDRA==" });
  });

  it("hangs up Telnyx when the delegated backend calls end_call", async () => {
    const hangup = vi.fn(async () => undefined);
    const liveSend = vi.fn();
    const call = sampleCall();
    const bridge = new GptLiveMediaBridge({
      call,
      sendLive: liveSend,
      sendTelnyx: vi.fn(),
      telnyx: { dial: vi.fn(), hangup },
      hangupDelayMs: 0,
    });
    await bridge.onLiveEvent({
      type: "response.event",
      event: {
        type: "response.output_item.done",
        item: { type: "function_call", status: "completed", name: "end_call", call_id: "tool-1" },
      },
    });
    expect(liveSend).toHaveBeenCalledWith({
      type: "response.item.create",
      item: {
        type: "function_call_output",
        call_id: "tool-1",
        output: JSON.stringify({ ok: true }),
      },
    });
    expect(hangup).toHaveBeenCalledWith("v2:control-id");
    expect(call.endedReason).toBe("end_call");
  });

  it("sends Telnyx DTMF on delegated send_dtmf and does not hang up", async () => {
    const hangup = vi.fn(async () => undefined);
    const sendDtmf = vi.fn(async () => undefined);
    const liveSend = vi.fn();
    const telnyxSend = vi.fn();
    const call = sampleCall();
    const bridge = new GptLiveMediaBridge({
      call,
      sendLive: liveSend,
      sendTelnyx: telnyxSend,
      telnyx: { dial: vi.fn(), hangup, sendDtmf },
      hangupDelayMs: 0,
    });
    await bridge.onLiveEvent({
      type: "response.event",
      event: {
        type: "response.output_item.done",
        item: {
          type: "function_call",
          status: "completed",
          name: "send_dtmf",
          call_id: "tool-dtmf",
          arguments: JSON.stringify({ digits: "2" }),
        },
      },
    });
    expect(sendDtmf).toHaveBeenCalledWith("v2:control-id", "2");
    expect(hangup).not.toHaveBeenCalled();
    expect(call.endedReason).toBeUndefined();
    expect(telnyxSend).toHaveBeenCalledWith({ event: "clear" });
    expect(liveSend).toHaveBeenCalledWith({ type: "response.create" });
  });
});
