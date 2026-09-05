import { describe, expect, it, vi } from "vitest";
import { MediaBridge } from "../src/bridge/media-bridge.js";
import { DEFAULT_CALLEE_SPEECH_GRACE_MS } from "../src/bridge/callee-speech.js";
import type { ElevenLabsTts } from "../src/elevenlabs.js";
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

  it("does not hang up on end_call until goodbye response.done plus playout buffer", async () => {
    vi.useFakeTimers();
    const hangup = vi.fn(async () => undefined);
    const telnyxSend = vi.fn();
    const call = sampleCall();
    const bridge = new MediaBridge({
      call,
      sendGrok: vi.fn(),
      sendTelnyx: telnyxSend,
      telnyx: { dial: vi.fn(), hangup },
      hangupDelayMs: 400,
      hangupMaxWaitMs: 20_000,
    });
    await playGreeting(bridge);
    telnyxSend.mockClear();

    await bridge.onGrokEvent({ type: "response.created", response_id: "bye" });
    await bridge.onGrokEvent({ type: "response.output_audio.delta", delta: "UlRQQQ==" });
    expect(telnyxSend).toHaveBeenCalled();

    const hangupP = bridge.onGrokEvent({
      type: "response.function_call_arguments.done",
      name: "end_call",
      call_id: "tool-bye",
    });
    await Promise.resolve();
    expect(hangup).not.toHaveBeenCalled();

    await bridge.onGrokEvent({ type: "response.done" });
    expect(hangup).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(399);
    expect(hangup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await hangupP;
    expect(hangup).toHaveBeenCalledWith("v2:control-id");
    expect(call.endedReason).toBe("end_call");
    vi.useRealTimers();
  });

  it("holds hangup for remaining PCMU playout of a long confirmation plus buffer", async () => {
    vi.useFakeTimers();
    const hangup = vi.fn(async () => undefined);
    const bridge = new MediaBridge({
      call: sampleCall(),
      sendGrok: vi.fn(),
      sendTelnyx: vi.fn(),
      telnyx: { dial: vi.fn(), hangup },
      hangupDelayMs: 200,
      hangupMaxWaitMs: 20_000,
    });
    await playGreeting(bridge);

    await bridge.onGrokEvent({ type: "response.created", response_id: "confirm" });
    const oneSecondPcmu = Buffer.alloc(8000).toString("base64");
    await bridge.onGrokEvent({ type: "response.output_audio.delta", delta: oneSecondPcmu });
    const hangupP = bridge.onGrokEvent({
      type: "response.function_call_arguments.done",
      name: "end_call",
      call_id: "tool-confirm",
    });
    await Promise.resolve();
    await bridge.onGrokEvent({ type: "response.done" });
    await vi.advanceTimersByTimeAsync(1199);
    expect(hangup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await hangupP;
    expect(hangup).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("unlocks waitForCallee on a 130ms post-grace utterance even with empty ASR", async () => {
    const clock = { ms: 0 };
    const grokSend = vi.fn();
    const bridge = new MediaBridge({
      call: { ...sampleCall(), waitForCallee: true },
      sendGrok: grokSend,
      sendTelnyx: vi.fn(),
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
      clockMs: () => clock.ms,
    });
    bridge.onTelnyxMessage({ event: "start" });
    clock.ms = 1100;
    await bridge.onGrokEvent({ type: "input_audio_buffer.speech_started" });
    clock.ms = 1230;
    await bridge.onGrokEvent({
      type: "input_audio_buffer.speech_stopped",
      audio_start_ms: 0,
      audio_end_ms: 130,
    });
    expect(forceMessageCount(grokSend)).toBe(1);
  });

  it("unlocks waitForCallee as soon as grace ends after a word-length «estou» with empty ASR", async () => {
    const clock = { ms: 0 };
    const grokSend = vi.fn();
    const logs: string[] = [];
    const spyLog = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    const bridge = new MediaBridge({
      call: { ...sampleCall(), waitForCallee: true },
      sendGrok: grokSend,
      sendTelnyx: vi.fn(),
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
      clockMs: () => clock.ms,
    });
    bridge.onTelnyxMessage({ event: "start" });
    clock.ms = 180;
    await bridge.onGrokEvent({ type: "input_audio_buffer.speech_started" });
    clock.ms = 330;
    await bridge.onGrokEvent({
      type: "input_audio_buffer.speech_stopped",
      audio_start_ms: 0,
      audio_end_ms: 150,
    });
    expect(forceMessageCount(grokSend)).toBe(0);

    clock.ms = DEFAULT_CALLEE_SPEECH_GRACE_MS;
    bridge.onTelnyxMessage({
      event: "media",
      media: { track: "inbound", payload: "QUJDRA==" },
    });
    expect(forceMessageCount(grokSend)).toBe(1);
    expect(
      logs.some((line) =>
        new RegExp(
          `unlock via grace_elapsed \\(media\\).*${DEFAULT_CALLEE_SPEECH_GRACE_MS}ms since stream start`,
        ).test(line),
      ),
    ).toBe(true);
    spyLog.mockRestore();
  });

  it("logs unlock reason and ms since stream start on short-greeting transcript", async () => {
    const clock = { ms: 0 };
    const logs: string[] = [];
    const spyLog = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    const grokSend = vi.fn();
    const bridge = new MediaBridge({
      call: { ...sampleCall(), waitForCallee: true },
      sendGrok: grokSend,
      sendTelnyx: vi.fn(),
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
      clockMs: () => clock.ms,
    });
    bridge.onTelnyxMessage({ event: "start" });
    clock.ms = 240;
    await bridge.onGrokEvent({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "u-estou",
      transcript: "Estou",
    });
    expect(forceMessageCount(grokSend)).toBe(1);
    expect(
      logs.some((line) => /unlock via short_greeting \(transcript\).*240ms since stream start/.test(line)),
    ).toBe(true);
    spyLog.mockRestore();
  });

  it("unlocks waitForCallee on «estou?» including nested transcript payloads", async () => {
    const clock = { ms: 0 };
    const logs: string[] = [];
    const spyLog = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    const grokSend = vi.fn();
    const bridge = new MediaBridge({
      call: { ...sampleCall(), waitForCallee: true },
      sendGrok: grokSend,
      sendTelnyx: vi.fn(),
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
      clockMs: () => clock.ms,
    });
    bridge.onTelnyxMessage({ event: "start" });
    clock.ms = 220;
    await bridge.onGrokEvent({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "u-estou-q",
      transcript: "estou?",
    });
    expect(forceMessageCount(grokSend)).toBe(1);
    expect(
      logs.some((line) => /unlock via short_greeting \(transcript\).*text="estou\?"/.test(line)),
    ).toBe(true);

    const grokSend2 = vi.fn();
    const bridge2 = new MediaBridge({
      call: { ...sampleCall(), id: "call-2", waitForCallee: true },
      sendGrok: grokSend2,
      sendTelnyx: vi.fn(),
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
      clockMs: () => 300,
    });
    bridge2.onTelnyxMessage({ event: "start" });
    await bridge2.onGrokEvent({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "u-nested",
      transcript: { text: "Estou?" },
    });
    expect(forceMessageCount(grokSend2)).toBe(1);
    spyLog.mockRestore();
  });

  it("unlocks waitForCallee on ASR mangled Still? / Hello? as short greetings", async () => {
    const clock = { ms: 0 };
    const logs: string[] = [];
    const spyLog = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    const grokSend = vi.fn();
    const bridge = new MediaBridge({
      call: { ...sampleCall(), waitForCallee: true },
      sendGrok: grokSend,
      sendTelnyx: vi.fn(),
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
      clockMs: () => clock.ms,
    });
    bridge.onTelnyxMessage({ event: "start" });
    clock.ms = 3205;
    await bridge.onGrokEvent({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "u-still",
      transcript: "Still?",
    });
    expect(forceMessageCount(grokSend)).toBe(1);
    expect(
      logs.some((line) =>
        /unlock via short_greeting \(transcript\).*3205ms since stream start.*text="Still\?"/.test(line),
      ),
    ).toBe(true);

    spyLog.mockRestore();

    const grokSend2 = vi.fn();
    const logs2: string[] = [];
    const spyLog2 = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
      logs2.push(args.map(String).join(" "));
    });
    const bridge2 = new MediaBridge({
      call: { ...sampleCall(), id: "call-hello", waitForCallee: true },
      sendGrok: grokSend2,
      sendTelnyx: vi.fn(),
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
      clockMs: () => 400,
    });
    bridge2.onTelnyxMessage({ event: "start" });
    await bridge2.onGrokEvent({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "u-hello",
      transcript: "Hello?",
    });
    expect(forceMessageCount(grokSend2)).toBe(1);
    expect(
      logs2.some((line) => /unlock via short_greeting \(transcript\).*text="Hello\?"/.test(line)),
    ).toBe(true);
    spyLog2.mockRestore();
  });

  it("unlocks waitForCallee on a short post-grace answer via media without waiting for ASR", async () => {
    const clock = { ms: 0 };
    const logs: string[] = [];
    const spyLog = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    const grokSend = vi.fn();
    const bridge = new MediaBridge({
      call: { ...sampleCall(), waitForCallee: true },
      sendGrok: grokSend,
      sendTelnyx: vi.fn(),
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
      clockMs: () => clock.ms,
    });
    bridge.onTelnyxMessage({ event: "start" });
    clock.ms = 600;
    await bridge.onGrokEvent({ type: "input_audio_buffer.speech_started" });
    expect(forceMessageCount(grokSend)).toBe(0);

    clock.ms = 650;
    bridge.onTelnyxMessage({
      event: "media",
      media: { track: "inbound", payload: "QUJDRA==" },
    });
    expect(forceMessageCount(grokSend)).toBe(0);

    clock.ms = 680;
    bridge.onTelnyxMessage({
      event: "media",
      media: { track: "inbound", payload: "QUJDRA==" },
    });
    expect(forceMessageCount(grokSend)).toBe(1);
    expect(
      logs.some((line) => /unlock via short_answer \(media\).*680ms since stream start/.test(line)),
    ).toBe(true);
    spyLog.mockRestore();
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
      silence_duration_ms: 130,
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
    expect(
      grokSend.mock.calls.some((c) => {
        const msg = c[0] as { type?: string; item?: { type?: string } };
        return msg?.type === "conversation.item.create" && msg.item?.type === "force_message";
      }),
    ).toBe(true);
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
    expect(forceMessageCount(grokSend)).toBe(1);
    expect(responseCreateCount(grokSend)).toBe(0);
    expect(telnyxSend).not.toHaveBeenCalled();
    expect(grokSend.mock.calls.some((c) => (c[0] as { type?: string }).type === "response.cancel")).toBe(
      false,
    );

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
    await flushMicrotasks();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(forceMessageCount(grokSend)).toBe(0);
    expect(responseCreateCount(grokSend)).toBe(0);
    expect(telnyxSend).toHaveBeenCalledWith({ event: "media", media: { payload: "QUJDRA==" } });
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
    expect(forceMessageCount(grokSend)).toBe(1);
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
    expect(forceMessageCount(grokSend)).toBe(1);

    await bridge.onGrokEvent({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "u1",
      transcript: "Estou",
    });
    await flushMicrotasks();
    expect(forceMessageCount(grokSend)).toBe(1);
    expect(telnyxSend).toHaveBeenCalledWith({ event: "media", media: { payload: "UlRQQQ==" } });
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
    expect(forceMessageCount(grokSend)).toBe(1);
    expect(telnyxSend).not.toHaveBeenCalledWith({ event: "clear" });
    expect(logs.some((line) => /grace/i.test(line))).toBe(true);
    expect(logs.some((line) => /200ms since stream start/.test(line))).toBe(true);

    clock.ms = 300;
    await bridge.onGrokEvent({ type: "input_audio_buffer.speech_stopped" });
    expect(spy).not.toHaveBeenCalled();

    await bridge.onGrokEvent({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "noise",
      transcript: "   ",
    });
    expect(spy).not.toHaveBeenCalled();
    expect(forceMessageCount(grokSend)).toBe(1);
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

    clock.ms = 500;
    await bridge.onGrokEvent({ type: "input_audio_buffer.speech_started" });
    expect(forceMessageCount(grokSend)).toBe(1);

    clock.ms = 550;
    await bridge.onGrokEvent({ type: "input_audio_buffer.speech_stopped" });
    expect(forceMessageCount(grokSend)).toBe(1);

    clock.ms = 2000;
    await bridge.onGrokEvent({ type: "input_audio_buffer.speech_started" });
    clock.ms = 2130;
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
    expect(forceMessageCount(grokSend)).toBe(1);
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

const EL_PCMU = Buffer.alloc(160, 0x7f).toString("base64");

function mockElevenLabsTts(): ElevenLabsTts & { texts: string[] } {
  const texts: string[] = [];
  return {
    texts,
    async *speakToPcmu(input) {
      texts.push(input.text);
      input.onHttpStart?.();
      input.onFirstByte?.();
      yield EL_PCMU;
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe("media bridge ElevenLabs TTS playback", () => {
  function elCall(): CallRecord {
    return { ...sampleCall(), ttsProvider: "elevenlabs" };
  }

  it("speaks the greeting via ElevenLabs PCMU and does not forward Grok audio deltas", async () => {
    const grokSend = vi.fn();
    const telnyxSend = vi.fn();
    const tts = mockElevenLabsTts();
    const bridge = new MediaBridge({
      call: elCall(),
      sendGrok: grokSend,
      sendTelnyx: telnyxSend,
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
      elevenLabsTts: tts,
    });
    bridge.speakGreeting();
    await flushMicrotasks();
    expect(tts.texts).toEqual(["Olá, fala a secretária."]);
    expect(telnyxSend).toHaveBeenCalledWith({ event: "media", media: { payload: EL_PCMU } });
    expect(forceMessageCount(grokSend)).toBe(1);

    telnyxSend.mockClear();
    await bridge.onGrokEvent({ type: "response.created", response_id: "greeting" });
    await bridge.onGrokEvent({ type: "response.output_audio.delta", delta: "GROKAUDIO" });
    await bridge.onGrokEvent({
      type: "response.output_audio_transcript.done",
      response_id: "greeting",
      transcript: "Olá, fala a secretária.",
    });
    expect(telnyxSend).not.toHaveBeenCalled();
    await bridge.onGrokEvent({ type: "response.done" });
    expect(tts.texts).toEqual(["Olá, fala a secretária."]);
  });

  it("never forwards Grok ara when tts_provider=elevenlabs even if the EL client is missing", async () => {
    const telnyxSend = vi.fn();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const bridge = new MediaBridge({
      call: elCall(),
      sendGrok: vi.fn(),
      sendTelnyx: telnyxSend,
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
    });
    bridge.speakGreeting();
    await flushMicrotasks();
    expect(spy.mock.calls.some((c) => String(c[0]).includes("not falling back to Grok ara"))).toBe(true);
    await finishGreetingPlayback(bridge);
    telnyxSend.mockClear();
    await bridge.onGrokEvent({ type: "response.created", response_id: "turn-1" });
    await bridge.onGrokEvent({ type: "response.output_audio.delta", delta: "GROKAUDIO" });
    await bridge.onGrokEvent({
      type: "response.output_audio_transcript.done",
      response_id: "turn-1",
      transcript: "Perfeito.",
    });
    expect(telnyxSend).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("TTS-synthesizes later assistant transcripts and still ignores Grok audio", async () => {
    const grokSend = vi.fn();
    const telnyxSend = vi.fn();
    const tts = mockElevenLabsTts();
    const bridge = new MediaBridge({
      call: elCall(),
      sendGrok: grokSend,
      sendTelnyx: telnyxSend,
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
      elevenLabsTts: tts,
    });
    bridge.speakGreeting();
    await flushMicrotasks();
    await finishGreetingPlayback(bridge);
    telnyxSend.mockClear();
    tts.texts.length = 0;

    await bridge.onGrokEvent({ type: "response.created", response_id: "turn-1" });
    await bridge.onGrokEvent({ type: "response.output_audio.delta", delta: "GROKAUDIO" });
    expect(telnyxSend).not.toHaveBeenCalled();
    await bridge.onGrokEvent({
      type: "response.output_audio_transcript.done",
      response_id: "turn-1",
      transcript: "Perfeito, mesa para as 18h.",
    });
    await flushMicrotasks();
    expect(tts.texts).toEqual(["Perfeito, mesa para as 18h."]);
    expect(telnyxSend).toHaveBeenCalledWith({ event: "media", media: { payload: EL_PCMU } });
    await bridge.onGrokEvent({ type: "response.done", response_id: "turn-1" });
  });

  it("barge-in clears Telnyx, cancels Grok, and aborts in-flight ElevenLabs playback", async () => {
    const grokSend = vi.fn();
    const telnyxSend = vi.fn();
    let abortSeen = false;
    let calls = 0;
    const hanging: ElevenLabsTts = {
      async *speakToPcmu(input) {
        calls += 1;
        yield EL_PCMU;
        if (calls === 1) return;
        await new Promise<void>((_resolve, reject) => {
          if (input.signal.aborted) {
            abortSeen = true;
            const err = new Error("Aborted");
            err.name = "AbortError";
            reject(err);
            return;
          }
          input.signal.addEventListener("abort", () => {
            abortSeen = true;
            const err = new Error("Aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      },
    };
    const bridge = new MediaBridge({
      call: elCall(),
      sendGrok: grokSend,
      sendTelnyx: telnyxSend,
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
      elevenLabsTts: hanging,
    });
    bridge.speakGreeting();
    await flushMicrotasks();
    await finishGreetingPlayback(bridge);
    grokSend.mockClear();
    telnyxSend.mockClear();

    await bridge.onGrokEvent({ type: "response.created", response_id: "turn-1" });
    const speakP = bridge.onGrokEvent({
      type: "response.output_audio_transcript.done",
      response_id: "turn-1",
      transcript: "Queria uma mesa.",
    });
    await flushMicrotasks();
    expect(telnyxSend).toHaveBeenCalledWith({ event: "media", media: { payload: EL_PCMU } });

    telnyxSend.mockClear();
    grokSend.mockClear();
    await bridge.onGrokEvent({ type: "input_audio_buffer.speech_started" });
    expect(telnyxSend).toHaveBeenCalledWith({ event: "clear" });
    expect(grokSend).toHaveBeenCalledWith({ type: "response.cancel" });
    await speakP.catch(() => undefined);
    await flushMicrotasks();
    expect(abortSeen).toBe(true);

    telnyxSend.mockClear();
    await bridge.onGrokEvent({ type: "response.output_audio.delta", delta: "GROKAFTER" });
    expect(telnyxSend).not.toHaveBeenCalled();
  });

  it("holds hangup until ElevenLabs goodbye PCMU has been queued", async () => {
    vi.useFakeTimers();
    const hangup = vi.fn(async () => undefined);
    const oneSecond = Buffer.alloc(8000, 0x7f).toString("base64");
    const tts: ElevenLabsTts = {
      async *speakToPcmu(input) {
        if (input.text === "Olá, fala a secretária.") {
          yield Buffer.alloc(160, 0x7f).toString("base64");
          return;
        }
        yield oneSecond;
      },
    };
    const bridge = new MediaBridge({
      call: elCall(),
      sendGrok: vi.fn(),
      sendTelnyx: vi.fn(),
      telnyx: { dial: vi.fn(), hangup },
      hangupDelayMs: 200,
      hangupMaxWaitMs: 20_000,
      elevenLabsTts: tts,
    });
    bridge.speakGreeting();
    await flushMicrotasks();
    await finishGreetingPlayback(bridge);

    await bridge.onGrokEvent({ type: "response.created", response_id: "bye" });
    await bridge.onGrokEvent({
      type: "response.output_audio_transcript.done",
      response_id: "bye",
      transcript: "Obrigado, até logo.",
    });
    await flushMicrotasks();
    const hangupP = bridge.onGrokEvent({
      type: "response.function_call_arguments.done",
      name: "end_call",
      call_id: "tool-bye",
    });
    await Promise.resolve();
    expect(hangup).not.toHaveBeenCalled();
    await bridge.onGrokEvent({ type: "response.done" });
    expect(hangup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1199);
    expect(hangup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await hangupP;
    expect(hangup).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("prefetches ElevenLabs greeting PCMU on stream start and stays mute until waitForCallee unlock", async () => {
    const clock = { ms: 0 };
    const logs: string[] = [];
    const spyLog = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    const tts = mockElevenLabsTts();
    const grokSend = vi.fn();
    const telnyxSend = vi.fn();
    const bridge = new MediaBridge({
      call: { ...elCall(), waitForCallee: true },
      sendGrok: grokSend,
      sendTelnyx: telnyxSend,
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
      elevenLabsTts: tts,
      clockMs: () => clock.ms,
    });
    bridge.onTelnyxMessage({ event: "start" });
    await flushMicrotasks();

    expect(tts.texts).toEqual(["Olá, fala a secretária."]);
    expect(telnyxSend.mock.calls.some((c) => (c[0] as { event?: string }).event === "media")).toBe(
      false,
    );
    expect(forceMessageCount(grokSend)).toBe(0);
    expect(logs.some((line) => /el_latency.*stage=el_http_start/.test(line))).toBe(true);
    expect(logs.some((line) => /el_latency.*stage=el_first_byte/.test(line))).toBe(true);

    await bridge.onGrokEvent({ type: "session.updated" });
    await bridge.onGrokEvent({ type: "response.created", response_id: "auto-1" });
    await bridge.onGrokEvent({ type: "response.output_audio.delta", delta: "GROKAUDIO" });
    expect(telnyxSend.mock.calls.some((c) => (c[0] as { event?: string }).event === "media")).toBe(
      false,
    );
    expect(forceMessageCount(grokSend)).toBe(1);

    clock.ms = 2122;
    await bridge.onGrokEvent({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "u1",
      transcript: "Estou",
    });
    await flushMicrotasks();

    expect(tts.texts).toEqual(["Olá, fala a secretária."]);
    expect(telnyxSend).toHaveBeenCalledWith({ event: "media", media: { payload: EL_PCMU } });
    expect(forceMessageCount(grokSend)).toBe(1);
    expect(logs.some((line) => /el_latency.*stage=unlock/.test(line))).toBe(true);
    expect(logs.some((line) => /el_latency.*cache=hit/.test(line))).toBe(true);
    expect(logs.some((line) => /unlock_to_telnyx_ms=0/.test(line))).toBe(true);
    spyLog.mockRestore();
  });

  it("on unlock plays already-buffered frames without starting a new ElevenLabs HTTP request", async () => {
    const clock = { ms: 50 };
    const logs: string[] = [];
    const spyLog = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let speakCalls = 0;
    const tts: ElevenLabsTts = {
      async *speakToPcmu(input) {
        speakCalls += 1;
        input.onHttpStart?.();
        await gate;
        input.onFirstByte?.();
        yield EL_PCMU;
      },
    };
    const grokSend = vi.fn();
    const telnyxSend = vi.fn();
    const bridge = new MediaBridge({
      call: { ...elCall(), waitForCallee: true },
      sendGrok: grokSend,
      sendTelnyx: telnyxSend,
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
      elevenLabsTts: tts,
      clockMs: () => clock.ms,
    });
    bridge.onTelnyxMessage({ event: "start" });
    await flushMicrotasks();
    expect(speakCalls).toBe(1);
    expect(telnyxSend.mock.calls.some((c) => (c[0] as { event?: string }).event === "media")).toBe(
      false,
    );

    clock.ms = 2122;
    await bridge.onGrokEvent({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "estou",
    });
    await flushMicrotasks();
    expect(speakCalls).toBe(1);
    expect(forceMessageCount(grokSend)).toBe(1);
    expect(telnyxSend.mock.calls.some((c) => (c[0] as { event?: string }).event === "media")).toBe(
      false,
    );
    expect(logs.some((line) => /el_latency.*stage=unlock/.test(line))).toBe(true);
    expect(logs.some((line) => /el_latency.*stage=el_http_start/.test(line))).toBe(true);

    await bridge.onGrokEvent({ type: "session.updated" });
    expect(telnyxSend.mock.calls.some((c) => (c[0] as { event?: string }).event === "media")).toBe(
      false,
    );

    clock.ms = 2300;
    release();
    await flushMicrotasks();
    expect(speakCalls).toBe(1);
    expect(telnyxSend).toHaveBeenCalledWith({ event: "media", media: { payload: EL_PCMU } });
    expect(logs.some((line) => /el_latency.*stage=first_telnyx_media_frame/.test(line))).toBe(true);
    expect(logs.some((line) => /unlock_to_telnyx_ms=178/.test(line))).toBe(true);
    spyLog.mockRestore();
  });

  it("holds Telnyx playback until output is ready while still generating the Grok greeting", async () => {
    const grokSend = vi.fn();
    const telnyxSend = vi.fn();
    const bridge = new MediaBridge({
      call: { ...sampleCall(), waitForCallee: true },
      sendGrok: grokSend,
      sendTelnyx: telnyxSend,
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
      outputReady: false,
    });
    await bridge.onGrokEvent({ type: "session.updated" });
    await bridge.onGrokEvent({ type: "response.created", response_id: "greet-prefetch" });
    await bridge.onGrokEvent({ type: "response.output_audio.delta", delta: "GROKAUDIO" });
    await bridge.onGrokEvent({ type: "response.done", response_id: "greet-prefetch" });
    expect(forceMessageCount(grokSend)).toBe(1);
    expect(telnyxSend).not.toHaveBeenCalled();

    bridge.markOutputReady();
    expect(telnyxSend).not.toHaveBeenCalled();

    await bridge.onGrokEvent({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "Estou",
    });
    expect(forceMessageCount(grokSend)).toBe(1);
    expect(telnyxSend).toHaveBeenCalledWith({ event: "media", media: { payload: "GROKAUDIO" } });
  });

  it("sends cached Grok greeting frames to Telnyx on the unlock call without waiting a microtask", async () => {
    const grokSend = vi.fn();
    const telnyxSend = vi.fn();
    const bridge = new MediaBridge({
      call: { ...sampleCall(), waitForCallee: true },
      sendGrok: grokSend,
      sendTelnyx: telnyxSend,
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
    });
    await bridge.onGrokEvent({ type: "session.updated" });
    await bridge.onGrokEvent({ type: "response.output_audio.delta", delta: "GROKAUDIO" });
    expect(telnyxSend).not.toHaveBeenCalled();

    await bridge.onGrokEvent({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "Estou",
    });
    expect(telnyxSend).toHaveBeenCalledWith({ event: "media", media: { payload: "GROKAUDIO" } });
    expect(forceMessageCount(grokSend)).toBe(1);
  });

  it("primes Grok greeting audio on session ready and only plays Telnyx media after waitForCallee unlock", async () => {
    const clock = { ms: 0 };
    const logs: string[] = [];
    const spyLog = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
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
    expect(grokSend.mock.calls.some((c) => (c[0] as { type?: string }).type === "session.update")).toBe(
      true,
    );
    expect(forceMessageCount(grokSend)).toBe(0);
    expect(telnyxSend).not.toHaveBeenCalled();

    clock.ms = 100;
    await bridge.onGrokEvent({ type: "session.updated" });
    await bridge.onGrokEvent({ type: "response.created", response_id: "greet-prefetch" });
    await bridge.onGrokEvent({ type: "response.output_audio.delta", delta: "GROKAUDIO" });
    await bridge.onGrokEvent({ type: "response.done", response_id: "greet-prefetch" });
    expect(forceMessageCount(grokSend)).toBe(1);
    expect(telnyxSend.mock.calls.some((c) => (c[0] as { event?: string }).event === "media")).toBe(
      false,
    );

    clock.ms = 2122;
    await bridge.onGrokEvent({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "Estou",
    });
    await flushMicrotasks();
    expect(forceMessageCount(grokSend)).toBe(1);
    expect(telnyxSend).toHaveBeenCalledWith({ event: "media", media: { payload: "GROKAUDIO" } });
    expect(logs.some((line) => /turn_latency.*provider=grok.*stage=unlock/.test(line))).toBe(true);
    expect(logs.some((line) => /turn_latency.*cache=hit/.test(line))).toBe(true);
    expect(logs.some((line) => /unlock_to_telnyx_ms=0/.test(line))).toBe(true);
    spyLog.mockRestore();
  });

  it("logs speech_stopped through first Telnyx media for later Grok turns", async () => {
    const clock = { ms: 0 };
    const logs: string[] = [];
    const spyLog = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    const grokSend = vi.fn();
    const telnyxSend = vi.fn();
    const bridge = new MediaBridge({
      call: sampleCall(),
      sendGrok: grokSend,
      sendTelnyx: telnyxSend,
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
      clockMs: () => clock.ms,
    });
    bridge.speakGreeting();
    await bridge.onGrokEvent({ type: "response.created", response_id: "greeting" });
    await bridge.onGrokEvent({ type: "response.output_audio.delta", delta: "R1JFVQ==" });
    await bridge.onGrokEvent({ type: "response.done", response_id: "greeting" });
    await flushMicrotasks();
    telnyxSend.mockClear();

    clock.ms = 5000;
    await bridge.onGrokEvent({ type: "input_audio_buffer.speech_stopped" });
    await bridge.onGrokEvent({ type: "response.created", response_id: "turn-1" });
    clock.ms = 5180;
    await bridge.onGrokEvent({ type: "response.output_audio.delta", delta: "UlRQQQ==" });
    expect(telnyxSend).toHaveBeenCalledWith({ event: "media", media: { payload: "UlRQQQ==" } });
    expect(logs.some((line) => /turn_latency.*provider=grok.*stage=speech_stopped/.test(line))).toBe(
      true,
    );
    expect(logs.some((line) => /turn_latency.*stage=first_telnyx_media_frame/.test(line))).toBe(true);
    spyLog.mockRestore();
  });

  it("prefetches the next ElevenLabs sentence while the current sentence is still playing", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const texts: string[] = [];
    const tts: ElevenLabsTts = {
      async *speakToPcmu(input) {
        texts.push(input.text);
        input.onHttpStart?.();
        input.onFirstByte?.();
        yield EL_PCMU;
        if (input.text === "Perfeito.") await firstGate;
      },
    };
    const telnyxSend = vi.fn();
    const bridge = new MediaBridge({
      call: elCall(),
      sendGrok: vi.fn(),
      sendTelnyx: telnyxSend,
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
      elevenLabsTts: tts,
    });
    bridge.speakGreeting();
    await flushMicrotasks();
    await finishGreetingPlayback(bridge);
    texts.length = 0;
    telnyxSend.mockClear();

    await bridge.onGrokEvent({ type: "response.created", response_id: "turn-1" });
    await bridge.onGrokEvent({
      type: "response.output_audio_transcript.delta",
      response_id: "turn-1",
      delta: "Perfeito. Mesa para as 18h.",
    });
    await flushMicrotasks();
    expect(texts).toEqual(["Perfeito.", "Mesa para as 18h."]);

    telnyxSend.mockClear();
    releaseFirst();
    await flushMicrotasks();
    expect(telnyxSend).toHaveBeenCalledWith({ event: "media", media: { payload: EL_PCMU } });
    expect(texts).toEqual(["Perfeito.", "Mesa para as 18h."]);
  });

  it("starts ElevenLabs on the first complete transcript sentence before transcript.done", async () => {
    const telnyxSend = vi.fn();
    const tts = mockElevenLabsTts();
    const bridge = new MediaBridge({
      call: elCall(),
      sendGrok: vi.fn(),
      sendTelnyx: telnyxSend,
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
      elevenLabsTts: tts,
    });
    bridge.speakGreeting();
    await flushMicrotasks();
    await finishGreetingPlayback(bridge);
    telnyxSend.mockClear();
    tts.texts.length = 0;

    await bridge.onGrokEvent({ type: "response.created", response_id: "turn-1" });
    await bridge.onGrokEvent({
      type: "response.output_audio_transcript.delta",
      response_id: "turn-1",
      delta: "Perfeito. Mesa para",
    });
    await flushMicrotasks();
    expect(tts.texts).toEqual(["Perfeito."]);
    expect(telnyxSend).toHaveBeenCalledWith({ event: "media", media: { payload: EL_PCMU } });

    telnyxSend.mockClear();
    await bridge.onGrokEvent({
      type: "response.output_audio_transcript.done",
      response_id: "turn-1",
      transcript: "Perfeito. Mesa para as 18h.",
    });
    await flushMicrotasks();
    expect(tts.texts).toEqual(["Perfeito.", "Mesa para as 18h."]);
    expect(telnyxSend).toHaveBeenCalledWith({ event: "media", media: { payload: EL_PCMU } });
  });

  it("logs speech_stopped through first Telnyx media for later ElevenLabs turns", async () => {
    const clock = { ms: 0 };
    const logs: string[] = [];
    const spyLog = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    const tts = mockElevenLabsTts();
    const bridge = new MediaBridge({
      call: elCall(),
      sendGrok: vi.fn(),
      sendTelnyx: vi.fn(),
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
      elevenLabsTts: tts,
      clockMs: () => clock.ms,
    });
    bridge.speakGreeting();
    await flushMicrotasks();
    await finishGreetingPlayback(bridge);

    clock.ms = 5000;
    await bridge.onGrokEvent({ type: "input_audio_buffer.speech_stopped" });
    await bridge.onGrokEvent({ type: "response.created", response_id: "turn-1" });
    clock.ms = 5180;
    await bridge.onGrokEvent({
      type: "response.output_audio_transcript.done",
      response_id: "turn-1",
      transcript: "Certo.",
    });
    await flushMicrotasks();
    expect(logs.some((line) => /el_latency.*stage=speech_stopped/.test(line))).toBe(true);
    expect(logs.some((line) => /el_latency.*stage=transcript/.test(line))).toBe(true);
    expect(logs.some((line) => /el_latency.*stage=el_http_start/.test(line))).toBe(true);
    expect(logs.some((line) => /el_latency.*stage=el_first_byte/.test(line))).toBe(true);
    expect(logs.some((line) => /el_latency.*stage=first_telnyx_media_frame/.test(line))).toBe(true);
    expect(logs.some((line) => /speech_stopped_to_transcript_ms=180/.test(line))).toBe(true);
    spyLog.mockRestore();
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
