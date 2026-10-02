import { describe, expect, it, vi } from "vitest";
import { GptLiveMediaBridge } from "../src/openai/live-bridge.js";
import type { CallRecord } from "../src/calls/types.js";
import { PCMU_SILENCE_FRAME } from "../src/bridge/greeting-cadence.js";

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
  it("requests the greeting on waitForCallee unlock, not on session.started during ring", async () => {
    const liveSend = vi.fn();
    const telnyxSend = vi.fn();
    const bridge = new GptLiveMediaBridge({
      call: { ...sampleCall(), waitForCallee: true },
      sendLive: liveSend,
      sendTelnyx: telnyxSend,
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
    });
    bridge.attachTelnyx(telnyxSend);
    bridge.onTelnyxMessage({ event: "start" });
    await bridge.onLiveEvent({ type: "session.started", session: { id: "s1" } });
    expect(liveSend.mock.calls.some((c) => c[0]?.type === "session.instructions.append")).toBe(false);
    expect(liveSend.mock.calls.some((c) => c[0]?.type === "session.commentary.append")).toBe(false);
    expect(telnyxSend).not.toHaveBeenCalled();

    await bridge.onLiveEvent({ type: "session.input_transcript.delta", delta: "Estou" });
    expect(liveSend.mock.calls.some((c) => c[0]?.type === "session.instructions.append")).toBe(true);
    expect(liveSend.mock.calls.some((c) => c[0]?.type === "session.commentary.append")).toBe(true);
    const instruct = liveSend.mock.calls.find((c) => c[0]?.type === "session.instructions.append")?.[0] as {
      content: string;
    };
    expect(instruct.content).toMatch(/português europeu/i);
    expect(instruct.content).toContain("Boa tarde, sou a secretária.");
    const commentary = liveSend.mock.calls.find((c) => c[0]?.type === "session.commentary.append")?.[0] as {
      content: string;
    };
    expect(commentary.content).toContain("Boa tarde, sou a secretária.");
    expect(commentary.content).not.toMatch(/Começa agora/);

    await bridge.onLiveEvent({ type: "session.output_audio.delta", delta: "UlRQQQ==" });
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
    expect(telnyxSend).not.toHaveBeenCalled();
    now = 400;
    bridge.onTelnyxMessage({ event: "media", media: { payload: speech } });
    bridge.onTelnyxMessage({ event: "media", media: { payload: speech } });
    expect(liveSend.mock.calls.some((c) => c[0]?.type === "session.commentary.append")).toBe(true);
    await bridge.onLiveEvent({ type: "session.output_audio.delta", delta: "UlRQQQ==" });
    expect(telnyxSend).toHaveBeenCalledWith({ event: "media", media: { payload: "UlRQQQ==" } });
  });

  it("buffers inbound PCMU until the live session is ready", async () => {
    const liveSend = vi.fn();
    const bridge = new GptLiveMediaBridge({
      call: sampleCall(),
      sendLive: liveSend,
      sendTelnyx: vi.fn(),
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
      inputAudioKeepaliveMs: 0,
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
    bridge.onTelnyxMessage({ event: "start" });
    await bridge.onLiveEvent({ type: "session.started" });
    expect(liveSend.mock.calls.some((c) => c[0]?.type === "session.instructions.append")).toBe(false);
    await bridge.onLiveEvent({ type: "session.input_transcript.delta", delta: "Estou" });
    const first = liveSend.mock.calls.find((c) => c[0]?.type === "session.instructions.append")?.[0] as {
      content: string;
    };
    expect(first.content).toContain("Boa tarde.");
    expect(first.content).not.toContain("Sou a secretária do Nuno Barreto.");
    const firstCommentary = liveSend.mock.calls.find((c) => c[0]?.type === "session.commentary.append")?.[0] as {
      content: string;
    };
    expect(firstCommentary.content).toBe("Boa tarde.");
    await bridge.onLiveEvent({ type: "session.output_audio.delta", delta: "T1BFTg==" });
    await bridge.onLiveEvent({ type: "session.output_transcript.done" });
    const introInstruct = liveSend.mock.calls
      .filter((c) => c[0]?.type === "session.instructions.append")
      .at(-1)?.[0] as { content: string };
    expect(introInstruct.content).toContain("Sou a secretária do Nuno Barreto.");
    await bridge.onLiveEvent({ type: "session.output_audio.delta", delta: "SU5UUg==" });
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
    now = 400;
    bridge.onTelnyxMessage({ event: "media", media: { payload: speech } });
    bridge.onTelnyxMessage({ event: "media", media: { payload: speech } });
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
    expect(commentary.some((e) => /responde/i.test(e.content ?? ""))).toBe(true);
    expect(telnyxSend).not.toHaveBeenCalledWith({ event: "clear" });
  });

  it("forwards inbound PCMU during the greeting so the GPT-Live session timeline keeps moving", async () => {
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
      inputAudioKeepaliveMs: 0,
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
    expect(liveSend).toHaveBeenCalledWith({ type: "session.input_audio.append", audio: "Q0FMTEU=" });
    await bridge.onLiveEvent({ type: "session.output_transcript.done" });
    await bridge.onLiveEvent({ type: "session.output_audio.delta", delta: "SU5UUg==" });
    await bridge.onLiveEvent({ type: "session.output_transcript.done" });
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

  it("does not flush waitForCallee=false greeting PCMU until Telnyx start (prewarm / attach race)", async () => {
    const liveSend = vi.fn();
    const telnyxSend = vi.fn();
    const call = {
      ...sampleCall(),
      greeting: "Boa tarde. Sou a secretária do Nuno. Queria marcar um jantar na Capricciosa.",
    };
    const bridge = new GptLiveMediaBridge({
      call,
      sendLive: liveSend,
      sendTelnyx: telnyxSend,
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
      postOpeningPauseMs: 0,
    });

    await bridge.onLiveEvent({ type: "session.started" });
    expect(liveSend.mock.calls.some((c) => c[0]?.type === "session.instructions.append")).toBe(false);
    expect(telnyxSend).not.toHaveBeenCalled();
    expect(call.transcript).toEqual([]);

    bridge.attachTelnyx(telnyxSend);
    expect(telnyxSend).not.toHaveBeenCalled();
    expect(call.transcript).toEqual([]);

    bridge.onTelnyxMessage({ event: "start" });
    expect(liveSend.mock.calls.some((c) => c[0]?.type === "session.commentary.append")).toBe(true);
    await bridge.onLiveEvent({ type: "session.output_audio.delta", delta: "T1BFTg==" });
    await bridge.onLiveEvent({ type: "session.output_transcript.done" });
    const introInstruct = liveSend.mock.calls
      .filter((c) => c[0]?.type === "session.instructions.append")
      .at(-1)?.[0] as { content: string };
    expect(introInstruct.content).toContain("Sou a secretária do Nuno");
    await bridge.onLiveEvent({ type: "session.output_audio.delta", delta: "SU5UUg==" });
    await bridge.onLiveEvent({ type: "session.output_transcript.done" });
    const payloads = telnyxSend.mock.calls
      .filter((c) => c[0]?.event === "media")
      .map((c) => (c[0] as { media: { payload: string } }).media.payload);
    expect(payloads).toContain("T1BFTg==");
    expect(payloads).toContain("SU5UUg==");
    expect(call.transcript).toEqual([{ role: "assistant", text: call.greeting }]);
    expect(liveSend.mock.calls.some((c) => c[0]?.type === "session.thinking.append")).toBe(true);
  });

  it("does not flush waitForCallee=false greeting PCMU on start during ring (Telnyx connects at dial)", async () => {
    const liveSend = vi.fn();
    const telnyxSend = vi.fn();
    const call = {
      ...sampleCall(),
      status: "ringing" as const,
      greeting: "Boa tarde. Sou a secretária do Nuno. Queria marcar um jantar na Capricciosa.",
    };
    const bridge = new GptLiveMediaBridge({
      call,
      sendLive: liveSend,
      sendTelnyx: telnyxSend,
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
      postOpeningPauseMs: 0,
    });
    await bridge.onLiveEvent({ type: "session.started" });
    expect(liveSend.mock.calls.some((c) => c[0]?.type === "session.commentary.append")).toBe(false);
    bridge.attachTelnyx(telnyxSend);
    bridge.onTelnyxMessage({ event: "start" });
    expect(telnyxSend).not.toHaveBeenCalled();
    expect(call.transcript).toEqual([]);
    expect(liveSend.mock.calls.some((c) => c[0]?.type === "session.thinking.append")).toBe(false);
    expect(call.status).toBe("ringing");

    bridge.notifyCallAnswered();
    expect(liveSend.mock.calls.some((c) => c[0]?.type === "session.commentary.append")).toBe(true);
    await bridge.onLiveEvent({ type: "session.output_audio.delta", delta: "T1BFTg==" });
    await bridge.onLiveEvent({ type: "session.output_transcript.done" });
    await bridge.onLiveEvent({ type: "session.output_audio.delta", delta: "SU5UUg==" });
    await bridge.onLiveEvent({ type: "session.output_transcript.done" });
    const payloads = telnyxSend.mock.calls
      .filter((c) => c[0]?.event === "media")
      .map((c) => (c[0] as { media: { payload: string } }).media.payload);
    expect(payloads).toContain("T1BFTg==");
    expect(payloads).toContain("SU5UUg==");
    expect(call.transcript).toEqual([{ role: "assistant", text: call.greeting }]);
  });

  it("still plays greeting when opening transcript.done arrives before any PCMU (GPT-Live text-first)", async () => {
    const liveSend = vi.fn();
    const telnyxSend = vi.fn();
    const call = {
      ...sampleCall(),
      greeting: "Boa tarde. Sou a secretária do Nuno. Queria marcar um jantar na Capricciosa.",
    };
    const bridge = new GptLiveMediaBridge({
      call,
      sendLive: liveSend,
      sendTelnyx: telnyxSend,
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
      postOpeningPauseMs: 0,
    });
    bridge.attachTelnyx(telnyxSend);
    bridge.onTelnyxMessage({ event: "start" });
    await bridge.onLiveEvent({ type: "session.started" });
    await bridge.onLiveEvent({ type: "session.output_transcript.done" });
    expect(liveSend.mock.calls.filter((c) => (c[0] as { event_id?: string }).event_id === "greeting-call-1-intro").length).toBe(
      0,
    );
    await bridge.onLiveEvent({ type: "session.output_audio.delta", delta: "T1BFTg==" });
    const introInstruct = liveSend.mock.calls
      .filter((c) => c[0]?.type === "session.instructions.append")
      .at(-1)?.[0] as { content: string; event_id?: string };
    expect(introInstruct.content).toContain("Sou a secretária do Nuno");
    await bridge.onLiveEvent({ type: "session.output_audio.delta", delta: "SU5UUg==" });
    await bridge.onLiveEvent({ type: "session.output_transcript.done" });
    const payloads = telnyxSend.mock.calls
      .filter((c) => c[0]?.event === "media")
      .map((c) => (c[0] as { media: { payload: string } }).media.payload);
    expect(payloads).toContain("T1BFTg==");
    expect(payloads).toContain("SU5UUg==");
    expect(call.transcript).toEqual([{ role: "assistant", text: call.greeting }]);
  });

  it("does not send greeting commands on session.started during prewarm (Telnyx start is ring)", async () => {
    const liveSend = vi.fn();
    const telnyxSend = vi.fn();
    const call = {
      ...sampleCall(),
      status: "dialing" as const,
      greeting: "Boa tarde. Sou a secretária do Nuno. Queria marcar um jantar na Capricciosa.",
    };
    const bridge = new GptLiveMediaBridge({
      call,
      sendLive: liveSend,
      sendTelnyx: telnyxSend,
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
      postOpeningPauseMs: 0,
    });

    await bridge.onLiveEvent({
      type: "session.started",
      session: { id: "live_prod", audio: { format: { type: "audio/pcmu", rate: 8000 } } },
    });
    expect(liveSend.mock.calls.some((c) => c[0]?.type === "session.instructions.append")).toBe(false);
    expect(liveSend.mock.calls.some((c) => c[0]?.type === "session.commentary.append")).toBe(false);
    expect(bridge.snapshotAudioPipeline()).toMatchObject({
      sessionReady: true,
      greetingCommandsSent: false,
      outputAudioDeltas: 0,
      outboundMediaFrames: 0,
    });

    bridge.attachTelnyx(telnyxSend);
    bridge.onTelnyxMessage({ event: "start", stream_id: "32DE0DEA-53CB-4B21-89A4-9E1819C043BC" });
    expect(liveSend.mock.calls.some((c) => c[0]?.type === "session.commentary.append")).toBe(false);
    expect(telnyxSend).not.toHaveBeenCalled();

    bridge.notifyCallAnswered();
    const commentary = liveSend.mock.calls
      .map((c) => c[0] as { type?: string; content?: string })
      .find((e) => e.type === "session.commentary.append");
    expect(commentary?.content).toContain("Boa tarde.");
    expect(commentary?.content).not.toMatch(/Começa agora/);
    expect(bridge.snapshotAudioPipeline().greetingCommandsSent).toBe(true);
    expect(telnyxSend).not.toHaveBeenCalled();
    expect(call.transcript).toEqual([{ role: "assistant", text: call.greeting }]);

    await bridge.onLiveEvent({ type: "session.output_audio.delta", delta: "T1BFTg==" });
    expect(telnyxSend).toHaveBeenCalledWith({ event: "media", media: { payload: "T1BFTg==" } });
    expect(bridge.snapshotAudioPipeline()).toMatchObject({
      outputAudioDeltas: 1,
      outboundMediaFrames: 1,
    });
  });

  it("does not send greeting commands on answer before session.started (OpenAI: wait for session.started)", async () => {
    const liveSend = vi.fn();
    const telnyxSend = vi.fn();
    const call = { ...sampleCall(), status: "ringing" as const };
    const bridge = new GptLiveMediaBridge({
      call,
      sendLive: liveSend,
      sendTelnyx: telnyxSend,
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
      postOpeningPauseMs: 0,
      inputAudioKeepaliveMs: 0,
    });
    bridge.attachTelnyx(telnyxSend);
    bridge.onTelnyxMessage({ event: "start" });
    bridge.notifyCallAnswered();
    expect(liveSend.mock.calls.some((c) => c[0]?.type === "session.instructions.append")).toBe(false);
    expect(liveSend.mock.calls.some((c) => c[0]?.type === "session.commentary.append")).toBe(false);
    expect(call.transcript).toEqual([{ role: "assistant", text: call.greeting }]);

    await bridge.onLiveEvent({ type: "session.started", session: { id: "s-late" } });
    expect(liveSend.mock.calls.some((c) => c[0]?.type === "session.commentary.append")).toBe(true);
    expect(bridge.snapshotAudioPipeline()).toMatchObject({
      sessionReady: true,
      callAnswered: true,
      streamStarted: true,
      greetingCommandsSent: true,
      outputAudioDeltas: 0,
      outboundMediaFrames: 0,
    });
    const silenceAppends = liveSend.mock.calls.filter(
      (c) => c[0]?.type === "session.input_audio.append" && c[0]?.audio === PCMU_SILENCE_FRAME,
    );
    expect(silenceAppends.length).toBeGreaterThan(0);
    bridge.markEnded("callee_hangup");
  });

  it("logs a silent-call pipeline when the greeting is marked but no output_audio.delta arrives", async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    const liveSend = vi.fn();
    const telnyxSend = vi.fn();
    const call = { ...sampleCall(), status: "ringing" as const };
    const bridge = new GptLiveMediaBridge({
      call,
      sendLive: liveSend,
      sendTelnyx: telnyxSend,
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
      hangupDelayMs: 0,
      postOpeningPauseMs: 0,
      inputAudioKeepaliveMs: 0,
    });
    bridge.attachTelnyx(telnyxSend);
    bridge.onTelnyxMessage({ event: "start" });
    await bridge.onLiveEvent({ type: "session.started" });
    bridge.notifyCallAnswered();
    expect(call.transcript[0]?.text).toBe(call.greeting);
    expect(bridge.snapshotAudioPipeline()).toMatchObject({
      greetingCommandsSent: true,
      outputAudioDeltas: 0,
      outboundMediaFrames: 0,
    });

    bridge.markEnded("callee_hangup");
    spy.mockRestore();
    const pipeline = errors.find((line) => line.includes("audio pipeline"));
    expect(pipeline).toMatch(/deltas=0/);
    expect(pipeline).toMatch(/telnyx_media_frames=0/);
    expect(pipeline).toMatch(/greeting_commands=true/);
    expect(pipeline).toMatch(/openai_events_after_greeting=/);
  });

  it("does not mark the greeting delivered when waitForCallee=false attach happens with no Telnyx start", async () => {
    const liveSend = vi.fn();
    const telnyxSend = vi.fn();
    const call = sampleCall();
    const bridge = new GptLiveMediaBridge({
      call,
      sendLive: liveSend,
      sendTelnyx: telnyxSend,
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
      postOpeningPauseMs: 0,
    });
    await bridge.onLiveEvent({ type: "session.started" });
    await bridge.onLiveEvent({ type: "session.output_audio.delta", delta: "T1BFTg==" });
    await bridge.onLiveEvent({ type: "session.output_transcript.done" });
    bridge.attachTelnyx(telnyxSend);
    expect(telnyxSend).not.toHaveBeenCalled();
    expect(call.transcript).toEqual([]);
    expect(liveSend.mock.calls.some((c) => c[0]?.type === "session.thinking.append")).toBe(false);
    expect(liveSend.mock.calls.some((c) => (c[0] as { event_id?: string }).event_id === "converse-call-1")).toBe(
      false,
    );
  });

  it("keeps GPT-Live input audio running after greeting commands so output_audio.delta can arrive", async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    const liveSend = vi.fn();
    const telnyxSend = vi.fn();
    const call = {
      ...sampleCall(),
      status: "dialing" as const,
      greeting: "Boa tarde. Sou a secretária do Nuno.",
    };
    const bridge = new GptLiveMediaBridge({
      call,
      sendLive: liveSend,
      sendTelnyx: telnyxSend,
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
      hangupDelayMs: 0,
      postOpeningPauseMs: 0,
      inputAudioKeepaliveMs: 0,
    });

    await bridge.onLiveEvent({
      type: "session.started",
      session: { id: "live_u1_EURERp3oNEbqV7rK7XKAOVGH0emhDKpK", audio: { format: { type: "audio/pcmu", rate: 8000 } } },
    });
    bridge.attachTelnyx(telnyxSend);
    bridge.onTelnyxMessage({ event: "start" });
    liveSend.mockClear();
    bridge.onTelnyxMessage({ event: "media", media: { payload: "UklORw==" } });
    expect(liveSend.mock.calls.some((c) => c[0]?.type === "session.input_audio.append")).toBe(false);

    bridge.notifyCallAnswered();
    const instruct = liveSend.mock.calls.find((c) => c[0]?.type === "session.instructions.append")?.[0] as {
      content?: string;
    };
    expect(instruct?.content).toMatch(/AGORA|imediatamente/);
    expect(instruct?.content).toContain("Boa tarde.");
    const silenceAppends = liveSend.mock.calls.filter(
      (c) => c[0]?.type === "session.input_audio.append" && c[0]?.audio === PCMU_SILENCE_FRAME,
    );
    expect(silenceAppends.length).toBeGreaterThan(0);

    liveSend.mockClear();
    bridge.onTelnyxMessage({ event: "media", media: { payload: "Q0FMTEU=" } });
    expect(liveSend).toHaveBeenCalledWith({ type: "session.input_audio.append", audio: "Q0FMTEU=" });

    await bridge.onLiveEvent({ type: "session.usage.updated", usage: { seconds: 2 } });
    await bridge.onLiveEvent({ type: "session.instructions.appended", client_event_id: "greeting-call-1" });
    expect(bridge.snapshotAudioPipeline()).toMatchObject({
      greetingCommandsSent: true,
      greetingSent: true,
      outputAudioDeltas: 0,
      outboundMediaFrames: 0,
      liveEventTypesAfterGreeting: {
        "session.instructions.appended": 1,
        "session.usage.updated": 1,
      },
    });

    bridge.markEnded("callee_hangup");
    spy.mockRestore();
    const pipeline = errors.find((line) => line.includes("audio pipeline"));
    expect(pipeline).toMatch(/deltas=0/);
    expect(pipeline).toMatch(/greeting_commands=true/);
    expect(pipeline).toMatch(/openai_events_after_greeting=session\.instructions\.appended:1,session\.usage\.updated:1/);
    expect(pipeline).toMatch(/inbound_media_frames=/);
  });

  it("does not forward Telnyx ring inbound to GPT-Live before answer", async () => {
    const liveSend = vi.fn();
    const telnyxSend = vi.fn();
    const call = { ...sampleCall(), status: "ringing" as const };
    const bridge = new GptLiveMediaBridge({
      call,
      sendLive: liveSend,
      sendTelnyx: telnyxSend,
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
      postOpeningPauseMs: 0,
      inputAudioKeepaliveMs: 0,
    });
    bridge.attachTelnyx(telnyxSend);
    bridge.onTelnyxMessage({ event: "start" });
    await bridge.onLiveEvent({ type: "session.started" });
    liveSend.mockClear();
    bridge.onTelnyxMessage({ event: "media", media: { payload: "UklORw==" } });
    expect(liveSend.mock.calls.some((c) => c[0]?.type === "session.input_audio.append")).toBe(false);
    bridge.markEnded("callee_hangup");
  });
});
