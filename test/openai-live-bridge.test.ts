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
    telnyxSend.mockClear();
    await bridge.onLiveEvent({ type: "session.input_transcript.delta", delta: "Estou?" });
    expect(telnyxSend).not.toHaveBeenCalledWith({ event: "clear" });
  });

  it("unlocks waitForCallee on post-grace PCMU speech without an ASR transcript", async () => {
    let now = 0;
    const liveSend = vi.fn();
    const telnyxSend = vi.fn();
    const speech = Buffer.alloc(160, 0x20).toString("base64");
    const bridge = new GptLiveMediaBridge({
      call: { ...sampleCall(), waitForCallee: true },
      sendLive: liveSend,
      sendTelnyx: telnyxSend,
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
      clockMs: () => now,
      postOpeningPauseMs: 0,
    });
    bridge.attachTelnyx(telnyxSend);
    await bridge.onLiveEvent({ type: "session.started", session: { id: "s1" } });
    bridge.onTelnyxMessage({ event: "start" });
    await bridge.onLiveEvent({ type: "session.output_audio.delta", delta: "UlRQQQ==" });
    expect(telnyxSend).not.toHaveBeenCalled();
    now = 400;
    bridge.onTelnyxMessage({ event: "media", media: { payload: speech } });
    bridge.onTelnyxMessage({ event: "media", media: { payload: speech } });
    expect(telnyxSend).toHaveBeenCalledWith({ event: "media", media: { payload: "UlRQQQ==" } });
  });

  it("buffers inbound PCMU until the live session is ready", async () => {
    const liveSend = vi.fn();
    const bridge = new GptLiveMediaBridge({
      call: sampleCall(),
      sendLive: liveSend,
      sendTelnyx: vi.fn(),
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
    });
    bridge.onTelnyxMessage({ event: "start" });
    liveSend.mockClear();
    bridge.onTelnyxMessage({
      event: "media",
      media: { track: "inbound", payload: "QUJDRA==" },
    });
    expect(liveSend.mock.calls.some((c) => c[0]?.type === "session.input_audio.append")).toBe(false);
    await bridge.onLiveEvent({ type: "session.started" });
    expect(liveSend).toHaveBeenCalledWith({ type: "session.input_audio.append", audio: "QUJDRA==" });
  });

  it("plays opening then intro as two beats when the greeting has a period split", async () => {
    const liveSend = vi.fn();
    const telnyxSend = vi.fn();
    const bridge = new GptLiveMediaBridge({
      call: {
        ...sampleCall(),
        waitForCallee: true,
        greeting: "Boa tarde. Sou a secretária do Nuno Barreto.",
      },
      sendLive: liveSend,
      sendTelnyx: telnyxSend,
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
      postOpeningPauseMs: 0,
    });
    bridge.attachTelnyx(telnyxSend);
    await bridge.onLiveEvent({ type: "session.started" });
    const first = liveSend.mock.calls.find((c) => c[0]?.type === "session.instructions.append")?.[0] as {
      content: string;
    };
    expect(first.content).toContain("Boa tarde.");
    expect(first.content).not.toContain("Sou a secretária do Nuno Barreto.");
    await bridge.onLiveEvent({ type: "session.output_audio.delta", delta: "T1BFTg==" });
    await bridge.onLiveEvent({ type: "session.output_transcript.done" });
    const introInstruct = liveSend.mock.calls
      .filter((c) => c[0]?.type === "session.instructions.append")
      .at(-1)?.[0] as { content: string };
    expect(introInstruct.content).toContain("Sou a secretária do Nuno Barreto.");
    await bridge.onLiveEvent({ type: "session.output_audio.delta", delta: "SU5UUg==" });
    await bridge.onLiveEvent({ type: "session.input_transcript.delta", delta: "Estou" });
    const payloads = telnyxSend.mock.calls
      .filter((c) => c[0]?.event === "media")
      .map((c) => (c[0] as { media: { payload: string } }).media.payload);
    expect(payloads).toContain("T1BFTg==");
    expect(payloads).toContain("SU5UUg==");
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

  it("after waitForCallee=false two-beat greeting, later callee turns trigger a spoken reply", async () => {
    const liveSend = vi.fn();
    const telnyxSend = vi.fn();
    const bridge = new GptLiveMediaBridge({
      call: {
        ...sampleCall(),
        greeting:
          "Boa tarde. Sou a secretária do Nuno. Queria marcar um jantar na Capricciosa para sexta-feira.",
      },
      sendLive: liveSend,
      sendTelnyx: telnyxSend,
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
      postOpeningPauseMs: 0,
    });
    bridge.attachTelnyx(telnyxSend);
    bridge.onTelnyxMessage({ event: "start" });
    await bridge.onLiveEvent({ type: "session.started" });
    await bridge.onLiveEvent({ type: "session.output_audio.delta", delta: "T1BFTg==" });
    await bridge.onLiveEvent({ type: "session.output_transcript.done" });
    await bridge.onLiveEvent({ type: "session.output_audio.delta", delta: "SU5UUg==" });
    await bridge.onLiveEvent({ type: "session.output_transcript.done" });
    liveSend.mockClear();
    telnyxSend.mockClear();
    await bridge.onLiveEvent({ type: "session.input_transcript.delta", delta: "o que precisa" });
    await bridge.onLiveEvent({ type: "session.input_transcript.done", transcript: "o que precisa" });
    const commentary = liveSend.mock.calls
      .map((c) => c[0] as { type?: string; content?: string })
      .filter((e) => e.type === "session.commentary.append");
    expect(commentary.length).toBeGreaterThan(0);
    expect(commentary.some((e) => /responde/i.test(e.content ?? ""))).toBe(true);
    expect(telnyxSend).not.toHaveBeenCalledWith({ event: "clear" });

    await bridge.onLiveEvent({ type: "session.output_audio.delta", delta: "UklQ" });
    await bridge.onLiveEvent({ type: "session.output_transcript.done", transcript: "Queria marcar um jantar." });
    liveSend.mockClear();
    await bridge.onLiveEvent({ type: "session.input_transcript.delta", delta: "para quando" });
    await bridge.onLiveEvent({ type: "session.input_transcript.done", transcript: "para quando" });
    const second = liveSend.mock.calls
      .map((c) => c[0] as { type?: string; content?: string })
      .filter((e) => e.type === "session.commentary.append");
    expect(second.some((e) => /responde/i.test(e.content ?? ""))).toBe(true);
  });

  it("after waitForCallee PCMU unlock + two-beat greeting, later callee turns still get a reply", async () => {
    let now = 0;
    const liveSend = vi.fn();
    const telnyxSend = vi.fn();
    const speech = Buffer.alloc(160, 0x20).toString("base64");
    const bridge = new GptLiveMediaBridge({
      call: {
        ...sampleCall(),
        waitForCallee: true,
        greeting:
          "Boa tarde. Sou a secretária do Nuno. Queria marcar um jantar na Capricciosa para sexta-feira.",
      },
      sendLive: liveSend,
      sendTelnyx: telnyxSend,
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
      clockMs: () => now,
      postOpeningPauseMs: 0,
    });
    bridge.attachTelnyx(telnyxSend);
    await bridge.onLiveEvent({ type: "session.started", session: { id: "s1" } });
    bridge.onTelnyxMessage({ event: "start" });
    await bridge.onLiveEvent({ type: "session.output_audio.delta", delta: "T1BFTg==" });
    await bridge.onLiveEvent({ type: "session.output_transcript.done" });
    await bridge.onLiveEvent({ type: "session.output_audio.delta", delta: "SU5UUg==" });
    now = 400;
    bridge.onTelnyxMessage({ event: "media", media: { payload: speech } });
    bridge.onTelnyxMessage({ event: "media", media: { payload: speech } });
    await bridge.onLiveEvent({ type: "session.output_transcript.done" });
    liveSend.mockClear();
    telnyxSend.mockClear();
    await bridge.onLiveEvent({ type: "session.input_transcript.delta", delta: "o que precisa" });
    await bridge.onLiveEvent({ type: "session.input_transcript.done", transcript: "o que precisa" });
    const commentary = liveSend.mock.calls
      .map((c) => c[0] as { type?: string; content?: string })
      .filter((e) => e.type === "session.commentary.append");
    expect(commentary.some((e) => /responde/i.test(e.content ?? ""))).toBe(true);
    expect(telnyxSend).not.toHaveBeenCalledWith({ event: "clear" });
  });

  it("holds inbound PCMU during the two-beat greeting then flushes after intro so later turns are heard", async () => {
    const liveSend = vi.fn();
    const telnyxSend = vi.fn();
    const bridge = new GptLiveMediaBridge({
      call: {
        ...sampleCall(),
        greeting: "Boa tarde. Sou a secretária do Nuno.",
      },
      sendLive: liveSend,
      sendTelnyx: telnyxSend,
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
      postOpeningPauseMs: 0,
    });
    bridge.attachTelnyx(telnyxSend);
    bridge.onTelnyxMessage({ event: "start" });
    await bridge.onLiveEvent({ type: "session.started" });
    await bridge.onLiveEvent({ type: "session.output_audio.delta", delta: "T1BFTg==" });
    liveSend.mockClear();
    bridge.onTelnyxMessage({
      event: "media",
      media: { track: "inbound", payload: "Q0FMTEU=" },
    });
    expect(liveSend.mock.calls.some((c) => c[0]?.type === "session.input_audio.append")).toBe(false);
    await bridge.onLiveEvent({ type: "session.output_transcript.done" });
    await bridge.onLiveEvent({ type: "session.output_audio.delta", delta: "SU5UUg==" });
    await bridge.onLiveEvent({ type: "session.output_transcript.done" });
    expect(liveSend).toHaveBeenCalledWith({ type: "session.input_audio.append", audio: "Q0FMTEU=" });
  });

  it("still requests a reply when the callee speaks during the post-opening pause", async () => {
    const liveSend = vi.fn();
    const telnyxSend = vi.fn();
    const bridge = new GptLiveMediaBridge({
      call: {
        ...sampleCall(),
        greeting: "Boa tarde. Sou a secretária do Nuno. Queria marcar um jantar na Capricciosa.",
      },
      sendLive: liveSend,
      sendTelnyx: telnyxSend,
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
      postOpeningPauseMs: 0,
    });
    bridge.attachTelnyx(telnyxSend);
    bridge.onTelnyxMessage({ event: "start" });
    await bridge.onLiveEvent({ type: "session.started" });
    await bridge.onLiveEvent({ type: "session.output_audio.delta", delta: "T1BFTg==" });
    await bridge.onLiveEvent({
      type: "session.input_transcript.delta",
      delta: "o que precisa",
    });
    await bridge.onLiveEvent({
      type: "session.input_transcript.done",
      transcript: "o que precisa",
    });
    expect(telnyxSend).not.toHaveBeenCalledWith({ event: "clear" });
    await bridge.onLiveEvent({ type: "session.output_transcript.done" });
    await bridge.onLiveEvent({ type: "session.output_audio.delta", delta: "SU5UUg==" });
    await bridge.onLiveEvent({ type: "session.output_transcript.done" });
    const commentary = liveSend.mock.calls
      .map((c) => c[0] as { type?: string; content?: string; event_id?: string })
      .filter((e) => e.type === "session.commentary.append");
    expect(commentary.some((e) => /responde/i.test(e.content ?? ""))).toBe(true);
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
