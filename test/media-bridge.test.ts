import { describe, expect, it, vi } from "vitest";
import { MediaBridge } from "../src/bridge/media-bridge.js";
import type { CallRecord } from "../src/calls/types.js";
import type { TelnyxClient } from "../src/telnyx/client.js";

function sampleCall(): CallRecord {
  return {
    id: "call-1",
    status: "answered",
    to: "+351912345678",
    from: "+351210210260",
    language: "pt-PT",
    greeting: "Olá, fala a secretária.",
    objective: "Confirmar quinta às 16h",
    voice: "ara",
    model: "grok-voice-think-fast-2.0",
    streamToken: "tok",
    telnyx: { callControlId: "v2:control-id" },
    transcript: [],
    createdAt: new Date().toISOString(),
  };
}

describe("media bridge Telnyx ↔ Grok", () => {
  it("forwards Telnyx PCMU media to Grok input_audio_buffer.append", () => {
    const grokSend = vi.fn();
    const telnyxSend = vi.fn();
    const telnyx: TelnyxClient = { dial: vi.fn(), hangup: vi.fn() };
    const bridge = new MediaBridge({
      call: sampleCall(),
      sendGrok: grokSend,
      sendTelnyx: telnyxSend,
      telnyx,
    });

    bridge.onTelnyxMessage({
      event: "start",
      stream_id: "stream-1",
      start: {
        call_control_id: "v2:control-id",
        media_format: { encoding: "PCMU", sample_rate: 8000, channels: 1 },
      },
    });
    bridge.onTelnyxMessage({
      event: "media",
      stream_id: "stream-1",
      media: { track: "inbound", payload: "QUJDRA==" },
    });

    expect(grokSend).toHaveBeenCalledWith({
      type: "input_audio_buffer.append",
      audio: "QUJDRA==",
    });
  });

  it("forwards Grok audio deltas back to Telnyx as media frames", async () => {
    const grokSend = vi.fn();
    const telnyxSend = vi.fn();
    const telnyx: TelnyxClient = { dial: vi.fn(), hangup: vi.fn() };
    const bridge = new MediaBridge({
      call: sampleCall(),
      sendGrok: grokSend,
      sendTelnyx: telnyxSend,
      telnyx,
    });
    bridge.onTelnyxMessage({
      event: "start",
      stream_id: "stream-1",
      start: { call_control_id: "v2:control-id" },
    });
    await playGreeting(bridge);

    await bridge.onGrokEvent({ type: "response.output_audio.delta", delta: "UlRQQQ==" });
    expect(telnyxSend).toHaveBeenCalledWith({
      event: "media",
      media: { payload: "UlRQQQ==" },
    });

    telnyxSend.mockClear();
    await bridge.onGrokEvent({ type: "response.audio.delta", delta: "UlRQQQ==" });
    expect(telnyxSend).toHaveBeenCalledWith({
      event: "media",
      media: { payload: "UlRQQQ==" },
    });
  });

  it("clears Telnyx playback and cancels the in-flight Grok response on barge-in", async () => {
    const grokSend = vi.fn();
    const telnyxSend = vi.fn();
    const telnyx: TelnyxClient = { dial: vi.fn(), hangup: vi.fn() };
    const bridge = new MediaBridge({
      call: sampleCall(),
      sendGrok: grokSend,
      sendTelnyx: telnyxSend,
      telnyx,
    });
    await playGreeting(bridge);
    grokSend.mockClear();
    telnyxSend.mockClear();

    await bridge.onGrokEvent({ type: "input_audio_buffer.speech_started" });
    await bridge.onGrokEvent({ type: "input_audio_buffer.speech_stopped" });
    await bridge.onGrokEvent({ type: "response.created", response_id: "asst-1" });
    await bridge.onGrokEvent({ type: "response.output_audio.delta", delta: "UlRQQQ==" });
    expect(telnyxSend).toHaveBeenCalledWith({
      event: "media",
      media: { payload: "UlRQQQ==" },
    });

    grokSend.mockClear();
    telnyxSend.mockClear();
    await bridge.onGrokEvent({ type: "input_audio_buffer.speech_started" });
    expect(telnyxSend).toHaveBeenCalledWith({ event: "clear" });
    expect(grokSend).toHaveBeenCalledWith({ type: "response.cancel" });

    telnyxSend.mockClear();
    await bridge.onGrokEvent({ type: "response.output_audio.delta", delta: "TEZGVQ==" });
    expect(telnyxSend).not.toHaveBeenCalled();
  });

  it("hangs up Telnyx when Grok calls end_call after the greeting/objective flow", async () => {
    const grokSend = vi.fn();
    const telnyxSend = vi.fn();
    const hangup = vi.fn(async () => undefined);
    const telnyx: TelnyxClient = { dial: vi.fn(), hangup };
    const call = sampleCall();
    const bridge = new MediaBridge({
      call,
      sendGrok: grokSend,
      sendTelnyx: telnyxSend,
      telnyx,
      hangupDelayMs: 0,
    });

    await bridge.onGrokEvent({
      type: "response.function_call_arguments.done",
      name: "end_call",
      call_id: "tool-1",
      arguments: JSON.stringify({ reason: "objective_complete" }),
    });

    expect(grokSend).toHaveBeenCalledWith({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: "tool-1",
        output: JSON.stringify({ ok: true }),
      },
    });
    expect(hangup).toHaveBeenCalledWith("v2:control-id");
    expect(call.endedReason).toBe("end_call");
  });

  it("records assistant and user transcripts", () => {
    const bridge = new MediaBridge({
      call: sampleCall(),
      sendGrok: vi.fn(),
      sendTelnyx: vi.fn(),
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
    });
    bridge.onGrokEvent({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "u1",
      transcript: "Sim, está confirmado",
    });
    bridge.onGrokEvent({
      type: "response.output_audio_transcript.done",
      transcript: "Perfeito, até quinta.",
    });
    expect(bridge.call.transcript).toEqual([
      { role: "user", text: "Sim, está confirmado" },
      { role: "assistant", text: "Perfeito, até quinta." },
    ]);
  });

  it("builds the Grok session.update for voice ara, PCMU, and end_call", () => {
    const grokSend = vi.fn();
    const bridge = new MediaBridge({
      call: sampleCall(),
      sendGrok: grokSend,
      sendTelnyx: vi.fn(),
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
      voice: "ara",
      model: "grok-voice-think-fast-2.0",
    });
    bridge.configureGrokSession();
    const update = grokSend.mock.calls.find((c) => c[0]?.type === "session.update")?.[0];
    expect(update.session.voice).toBe("ara");
    expect(update.session.audio.input.format).toEqual({ type: "audio/pcmu" });
    expect(update.session.audio.output.format).toEqual({ type: "audio/pcmu" });
    expect(update.session.audio.output.speed).toBe(1.05);
    expect(update.session.audio.input.transcription.language_hint).toBe("pt-PT");
    expect(update.session.tools[0].name).toBe("end_call");
    expect(update.session.turn_detection).toEqual({
      type: "server_vad",
      threshold: 0.5,
      silence_duration_ms: 160,
      prefix_padding_ms: 200,
      create_response: false,
      interrupt_response: true,
    });
  });

  it("speaks the greeting with force_message and does not also response.create that turn", () => {
    const grokSend = vi.fn();
    const bridge = new MediaBridge({
      call: sampleCall(),
      sendGrok: grokSend,
      sendTelnyx: vi.fn(),
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
    });
    bridge.speakGreeting();
    expect(grokSend).toHaveBeenCalledWith({
      type: "conversation.item.create",
      item: {
        type: "force_message",
        role: "assistant",
        interruptible: false,
        content: [{ type: "output_text", text: "Olá, fala a secretária." }],
      },
    });
    expect(grokSend.mock.calls.some((c) => c[0]?.type === "response.create")).toBe(false);
  });

  it("does not let the model re-greet after waitForCallee force_message", async () => {
    const grokSend = vi.fn();
    const telnyxSend = vi.fn();
    const bridge = new MediaBridge({
      call: { ...sampleCall(), waitForCallee: true },
      sendGrok: grokSend,
      sendTelnyx: telnyxSend,
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
    });
    await bridge.onGrokEvent({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "u1",
      transcript: "Estou",
    });
    expect(forceMessageCount(grokSend)).toBe(1);
    expect(responseCreateCount(grokSend)).toBe(0);
    await bridge.onGrokEvent({ type: "input_audio_buffer.speech_started" });
    expect(telnyxSend).not.toHaveBeenCalledWith({ event: "clear" });
    await finishGreetingPlayback(bridge);

    grokSend.mockClear();
    telnyxSend.mockClear();
    await bridge.onGrokEvent({ type: "response.created", response_id: "dup-1" });
    await bridge.onGrokEvent({ type: "response.output_audio.delta", delta: "QUJDRA==" });
    expect(grokSend).toHaveBeenCalledWith({ type: "response.cancel" });
    expect(telnyxSend).not.toHaveBeenCalled();
    expect(responseCreateCount(grokSend)).toBe(0);
    expect(forceMessageCount(grokSend)).toBe(0);
  });

  it("speaks the greeting immediately on session.updated by default", async () => {
    const grokSend = vi.fn();
    const bridge = new MediaBridge({
      call: sampleCall(),
      sendGrok: grokSend,
      sendTelnyx: vi.fn(),
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
    });
    await bridge.onGrokEvent({ type: "session.updated" });
    expect(forceMessageCount(grokSend)).toBe(1);
    expect(grokSend.mock.calls[0]?.[0]).toMatchObject({
      type: "conversation.item.create",
      item: { type: "force_message" },
    });
  });

  it("does not invoke speakGreeting on session.updated when waitForCallee is true, then invokes it once after real callee words", async () => {
    const grokSend = vi.fn();
    const telnyxSend = vi.fn();
    const bridge = new MediaBridge({
      call: { ...sampleCall(), waitForCallee: true },
      sendGrok: grokSend,
      sendTelnyx: telnyxSend,
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
    });
    const spy = vi.spyOn(bridge, "speakGreeting");

    bridge.configureGrokSession();
    await bridge.onGrokEvent({ type: "session.created" });
    await bridge.onGrokEvent({ type: "session.updated" });
    bridge.onTelnyxMessage({ event: "start" });
    await bridge.onGrokEvent({ type: "response.created", response_id: "auto-1" });
    await bridge.onGrokEvent({ type: "response.output_audio.delta", delta: "QUJDRA==" });

    expect(spy).not.toHaveBeenCalled();
    expect(forceMessageCount(grokSend)).toBe(0);
    expect(responseCreateCount(grokSend)).toBe(0);
    expect(telnyxSend).not.toHaveBeenCalled();
    expect(grokSend).toHaveBeenCalledWith({ type: "response.cancel" });

    grokSend.mockClear();
    await bridge.onGrokEvent({ type: "input_audio_buffer.speech_started" });
    expect(spy).not.toHaveBeenCalled();
    expect(forceMessageCount(grokSend)).toBe(0);
    expect(telnyxSend).not.toHaveBeenCalledWith({ event: "clear" });

    await bridge.onGrokEvent({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "u1",
      transcript: "Estou",
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(forceMessageCount(grokSend)).toBe(1);
    expect(responseCreateCount(grokSend)).toBe(0);
    expect(bridge.call.transcript).toEqual([
      { role: "user", text: "Estou" },
      { role: "assistant", text: "Olá, fala a secretária." },
    ]);
  });

  it("does not speak on session.updated when waitForCallee is true", async () => {
    const grokSend = vi.fn();
    const telnyxSend = vi.fn();
    const bridge = new MediaBridge({
      call: { ...sampleCall(), waitForCallee: true },
      sendGrok: grokSend,
      sendTelnyx: telnyxSend,
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
    });
    await bridge.onGrokEvent({ type: "session.updated" });
    expect(forceMessageCount(grokSend)).toBe(0);
    expect(responseCreateCount(grokSend)).toBe(0);
    expect(telnyxSend).not.toHaveBeenCalled();
  });

  it("mutes Grok auto-speech until the callee speaks when waitForCallee is true", async () => {
    const grokSend = vi.fn();
    const telnyxSend = vi.fn();
    const bridge = new MediaBridge({
      call: { ...sampleCall(), waitForCallee: true },
      sendGrok: grokSend,
      sendTelnyx: telnyxSend,
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
    });
    bridge.configureGrokSession();
    const waitingUpdate = grokSend.mock.calls.find((c) => c[0]?.type === "session.update")?.[0];
    expect(waitingUpdate.session.turn_detection.create_response).toBe(false);
    expect(waitingUpdate.session.turn_detection.idle_timeout_ms).toBeUndefined();

    await bridge.onGrokEvent({ type: "session.updated" });
    await bridge.onGrokEvent({ type: "response.created" });
    await bridge.onGrokEvent({ type: "response.output_audio.delta", delta: "UlRQQQ==" });
    await bridge.onGrokEvent({
      type: "response.output_audio_transcript.done",
      transcript: "Olá, sou a secretária.",
    });
    expect(telnyxSend).not.toHaveBeenCalled();
    expect(bridge.call.transcript).toEqual([]);

    await bridge.onGrokEvent({ type: "input_audio_buffer.speech_started" });
    expect(forceMessageCount(grokSend)).toBe(0);

    await bridge.onGrokEvent({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "u1",
      transcript: "Estou",
    });
    expect(forceMessageCount(grokSend)).toBe(1);
    const greetingUpdate = grokSend.mock.calls.filter((c) => c[0]?.type === "session.update").at(-1)?.[0];
    expect(greetingUpdate.session.turn_detection.create_response).toBe(false);

    telnyxSend.mockClear();
    await finishGreetingPlayback(bridge);
    const talkingUpdate = grokSend.mock.calls.filter((c) => c[0]?.type === "session.update").at(-1)?.[0];
    expect(talkingUpdate.session.turn_detection.create_response).toBe(true);
    expect(talkingUpdate.session.turn_detection.idle_timeout_ms).toBe(12_000);

    grokSend.mockClear();
    telnyxSend.mockClear();
    await bridge.onGrokEvent({ type: "response.created", response_id: "re-greet" });
    expect(grokSend).toHaveBeenCalledWith({ type: "response.cancel" });

    await bridge.onGrokEvent({ type: "input_audio_buffer.speech_started" });
    grokSend.mockClear();
    telnyxSend.mockClear();
    await bridge.onGrokEvent({ type: "response.created", response_id: "turn-1" });
    await bridge.onGrokEvent({ type: "response.output_audio.delta", delta: "UlRQQQ==" });
    expect(telnyxSend).toHaveBeenCalledWith({
      event: "media",
      media: { payload: "UlRQQQ==" },
    });
    expect(grokSend.mock.calls.some((c) => (c[0] as { type?: string }).type === "response.cancel")).toBe(false);
  });

  it("ignores early speech_started during grace and empty transcripts when waitForCallee is true", async () => {
    const clock = { ms: 0 };
    const grokSend = vi.fn();
    const telnyxSend = vi.fn();
    const logs: string[] = [];
    const spyLog = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    const bridge = new MediaBridge({
      call: { ...sampleCall(), waitForCallee: true },
      sendGrok: grokSend,
      sendTelnyx: telnyxSend,
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
      clockMs: () => clock.ms,
    });
    const spy = vi.spyOn(bridge, "speakGreeting");
    bridge.onTelnyxMessage({ event: "start" });
    await bridge.onGrokEvent({ type: "session.updated" });

    clock.ms = 200;
    await bridge.onGrokEvent({ type: "input_audio_buffer.speech_started" });
    expect(spy).not.toHaveBeenCalled();
    expect(forceMessageCount(grokSend)).toBe(0);
    expect(telnyxSend).not.toHaveBeenCalledWith({ event: "clear" });
    expect(logs.some((line) => /grace/i.test(line))).toBe(true);

    clock.ms = 800;
    await bridge.onGrokEvent({ type: "input_audio_buffer.speech_stopped" });
    expect(spy).not.toHaveBeenCalled();

    await bridge.onGrokEvent({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "noise",
      transcript: "   ",
    });
    expect(spy).not.toHaveBeenCalled();
    expect(forceMessageCount(grokSend)).toBe(0);
    expect(bridge.call.transcript).toEqual([]);
    spyLog.mockRestore();
  });

  it("speaks the greeting once after grace when callee speech lasts the minimum duration", async () => {
    const clock = { ms: 0 };
    const grokSend = vi.fn();
    const telnyxSend = vi.fn();
    const bridge = new MediaBridge({
      call: { ...sampleCall(), waitForCallee: true },
      sendGrok: grokSend,
      sendTelnyx: telnyxSend,
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
      clockMs: () => clock.ms,
    });
    bridge.onTelnyxMessage({ event: "start" });
    await bridge.onGrokEvent({ type: "session.updated" });

    clock.ms = 1000;
    await bridge.onGrokEvent({ type: "input_audio_buffer.speech_started" });
    expect(forceMessageCount(grokSend)).toBe(0);

    clock.ms = 1200;
    await bridge.onGrokEvent({ type: "input_audio_buffer.speech_stopped" });
    expect(forceMessageCount(grokSend)).toBe(0);

    clock.ms = 2000;
    await bridge.onGrokEvent({ type: "input_audio_buffer.speech_started" });
    clock.ms = 2250;
    await bridge.onGrokEvent({ type: "input_audio_buffer.speech_stopped" });
    expect(forceMessageCount(grokSend)).toBe(1);
    expect(telnyxSend).not.toHaveBeenCalledWith({ event: "clear" });

    await finishGreetingPlayback(bridge);
    grokSend.mockClear();
    telnyxSend.mockClear();
    await bridge.onGrokEvent({ type: "input_audio_buffer.speech_started" });
    expect(forceMessageCount(grokSend)).toBe(0);
    expect(telnyxSend).toHaveBeenCalledWith({ event: "clear" });
    expect(grokSend).toHaveBeenCalledWith({ type: "response.cancel" });
  });

  it("speaks the greeting once on first non-empty user transcription when waitForCallee is true", async () => {
    const grokSend = vi.fn();
    const bridge = new MediaBridge({
      call: { ...sampleCall(), waitForCallee: true },
      sendGrok: grokSend,
      sendTelnyx: vi.fn(),
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
    });
    const spy = vi.spyOn(bridge, "speakGreeting");
    await bridge.onGrokEvent({ type: "session.updated" });
    expect(spy).not.toHaveBeenCalled();
    await bridge.onGrokEvent({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "u1",
      transcript: "   ",
    });
    expect(forceMessageCount(grokSend)).toBe(0);
    expect(spy).not.toHaveBeenCalled();

    await bridge.onGrokEvent({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "u2",
      transcript: "Estou",
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(forceMessageCount(grokSend)).toBe(1);
    expect(bridge.call.transcript[0]).toEqual({ role: "user", text: "Estou" });
    expect(bridge.call.transcript[1]).toEqual({
      role: "assistant",
      text: "Olá, fala a secretária.",
    });

    spy.mockClear();
    grokSend.mockClear();
    await bridge.onGrokEvent({
      type: "conversation.item.input_audio_transcription.updated",
      item_id: "u3",
      transcript: "Estou sim",
    });
    expect(spy).not.toHaveBeenCalled();
    expect(forceMessageCount(grokSend)).toBe(0);
  });

  it("includes waitForCallee in session.update instructions", () => {
    const grokSend = vi.fn();
    const bridge = new MediaBridge({
      call: { ...sampleCall(), waitForCallee: true },
      sendGrok: grokSend,
      sendTelnyx: vi.fn(),
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
    });
    bridge.configureGrokSession();
    const update = grokSend.mock.calls.find((c) => c[0]?.type === "session.update")?.[0];
    expect(String((update.session as { instructions: string }).instructions)).toMatch(
      /Espera em silêncio até o destinatário falar/i,
    );
    expect(
      (update.session as { turn_detection: { create_response: boolean } }).turn_detection.create_response,
    ).toBe(false);
  });
});

function forceMessageCount(grokSend: ReturnType<typeof vi.fn>): number {
  return grokSend.mock.calls.filter((c) => {
    const msg = c[0] as { type?: string; item?: { type?: string } };
    return msg?.type === "conversation.item.create" && msg.item?.type === "force_message";
  }).length;
}

function responseCreateCount(grokSend: ReturnType<typeof vi.fn>): number {
  return grokSend.mock.calls.filter((c) => (c[0] as { type?: string })?.type === "response.create").length;
}

async function playGreeting(bridge: MediaBridge): Promise<void> {
  bridge.speakGreeting();
  await finishGreetingPlayback(bridge);
}

async function finishGreetingPlayback(bridge: MediaBridge): Promise<void> {
  await bridge.onGrokEvent({ type: "response.created", response_id: "greeting" });
  await bridge.onGrokEvent({ type: "response.output_audio.delta", delta: "R1JFVQ==" });
  await bridge.onGrokEvent({ type: "response.done" });
}
