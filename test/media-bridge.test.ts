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
    greeting: "Olá, fala a Ara.",
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

  it("forwards Grok audio deltas back to Telnyx as media frames", () => {
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

    bridge.onGrokEvent({ type: "response.output_audio.delta", delta: "UlRQQQ==" });
    expect(telnyxSend).toHaveBeenCalledWith({
      event: "media",
      media: { payload: "UlRQQQ==" },
    });

    telnyxSend.mockClear();
    bridge.onGrokEvent({ type: "response.audio.delta", delta: "UlRQQQ==" });
    expect(telnyxSend).toHaveBeenCalledWith({
      event: "media",
      media: { payload: "UlRQQQ==" },
    });
  });

  it("clears Telnyx playback on barge-in", () => {
    const grokSend = vi.fn();
    const telnyxSend = vi.fn();
    const telnyx: TelnyxClient = { dial: vi.fn(), hangup: vi.fn() };
    const bridge = new MediaBridge({
      call: sampleCall(),
      sendGrok: grokSend,
      sendTelnyx: telnyxSend,
      telnyx,
    });
    bridge.onGrokEvent({ type: "input_audio_buffer.speech_started" });
    expect(telnyxSend).toHaveBeenCalledWith({ event: "clear" });
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
    expect(update.session.audio.input.transcription.language_hint).toBe("pt-PT");
    expect(update.session.tools[0].name).toBe("end_call");
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
        content: [{ type: "output_text", text: "Olá, fala a Ara." }],
      },
    });
    expect(grokSend.mock.calls.some((c) => c[0]?.type === "response.create")).toBe(false);
  });
});
