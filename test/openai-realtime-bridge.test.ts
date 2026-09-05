import { describe, expect, it, vi } from "vitest";
import { OpenAIMediaBridge } from "../src/openai/realtime-bridge.js";
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
    voice: "coral",
    model: "gpt-realtime-2.1",
    ttsProvider: "openai",
    streamToken: "tok",
    telnyx: { callControlId: "v2:control-id" },
    transcript: [],
    createdAt: new Date().toISOString(),
  };
}

describe("OpenAI Realtime media bridge", () => {
  it("requests greeting audio on session.updated without sending Telnyx media until unlock", async () => {
    const openaiSend = vi.fn();
    const telnyxSend = vi.fn();
    const bridge = new OpenAIMediaBridge({
      call: { ...sampleCall(), waitForCallee: true },
      sendOpenAI: openaiSend,
      sendTelnyx: telnyxSend,
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
    });
    bridge.attachTelnyx(telnyxSend);
    await bridge.onOpenAIEvent({ type: "session.updated" });
    expect(openaiSend.mock.calls.some((c) => c[0]?.type === "response.create")).toBe(true);
    const create = openaiSend.mock.calls.find((c) => c[0]?.type === "response.create")?.[0] as {
      response: { conversation: string };
    };
    expect(create.response.conversation).toBe("none");

    await bridge.onOpenAIEvent({
      type: "response.created",
      response: { id: "greet-1", metadata: { purpose: "greeting" } },
    });
    await bridge.onOpenAIEvent({ type: "response.output_audio.delta", response_id: "greet-1", delta: "UlRQQQ==" });
    expect(telnyxSend).not.toHaveBeenCalled();

    await bridge.onOpenAIEvent({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "u1",
      transcript: "Estou",
    });
    expect(telnyxSend).toHaveBeenCalledWith({ event: "media", media: { payload: "UlRQQQ==" } });
    expect(openaiSend.mock.calls.some((c) => c[0]?.type === "conversation.item.create")).toBe(true);
  });

  it("forwards Telnyx PCMU to OpenAI input_audio_buffer.append", () => {
    const openaiSend = vi.fn();
    const bridge = new OpenAIMediaBridge({
      call: sampleCall(),
      sendOpenAI: openaiSend,
      sendTelnyx: vi.fn(),
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
    });
    bridge.onTelnyxMessage({
      event: "media",
      media: { track: "inbound", payload: "QUJDRA==" },
    });
    expect(openaiSend).toHaveBeenCalledWith({ type: "input_audio_buffer.append", audio: "QUJDRA==" });
  });

  it("clears Telnyx playback and cancels the in-flight OpenAI response on barge-in", async () => {
    const openaiSend = vi.fn();
    const telnyxSend = vi.fn();
    const bridge = new OpenAIMediaBridge({
      call: sampleCall(),
      sendOpenAI: openaiSend,
      sendTelnyx: telnyxSend,
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
    });
    bridge.attachTelnyx(telnyxSend);
    await bridge.onOpenAIEvent({ type: "session.updated" });
    await bridge.onOpenAIEvent({
      type: "response.created",
      response: { id: "greet-1", metadata: { purpose: "greeting" } },
    });
    await bridge.onOpenAIEvent({ type: "response.output_audio.delta", response_id: "greet-1", delta: "UlRQQQ==" });
    await bridge.onOpenAIEvent({ type: "response.done", response: { id: "greet-1", metadata: { purpose: "greeting" } } });
    openaiSend.mockClear();
    telnyxSend.mockClear();

    await bridge.onOpenAIEvent({ type: "response.created", response_id: "asst-1" });
    await bridge.onOpenAIEvent({ type: "response.output_audio.delta", response_id: "asst-1", delta: "TEZGVQ==" });
    expect(telnyxSend).toHaveBeenCalledWith({ event: "media", media: { payload: "TEZGVQ==" } });

    telnyxSend.mockClear();
    openaiSend.mockClear();
    await bridge.onOpenAIEvent({ type: "input_audio_buffer.speech_started" });
    expect(telnyxSend).toHaveBeenCalledWith({ event: "clear" });
    expect(openaiSend).toHaveBeenCalledWith({ type: "response.cancel" });
    expect(openaiSend).toHaveBeenCalledWith({ type: "output_audio_buffer.clear" });

    telnyxSend.mockClear();
    await bridge.onOpenAIEvent({ type: "response.output_audio.delta", response_id: "asst-1", delta: "QUFBQQ==" });
    expect(telnyxSend).not.toHaveBeenCalled();
  });

  it("does not speak on session.updated when waitForCallee is true", async () => {
    const telnyxSend = vi.fn();
    const bridge = new OpenAIMediaBridge({
      call: { ...sampleCall(), waitForCallee: true },
      sendOpenAI: vi.fn(),
      sendTelnyx: telnyxSend,
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
    });
    bridge.attachTelnyx(telnyxSend);
    await bridge.onOpenAIEvent({ type: "session.updated" });
    await bridge.onOpenAIEvent({
      type: "response.created",
      response: { id: "greet-1", metadata: { purpose: "greeting" } },
    });
    await bridge.onOpenAIEvent({ type: "response.output_audio.delta", response_id: "greet-1", delta: "UlRQQQ==" });
    expect(telnyxSend).not.toHaveBeenCalled();
  });

  it("hangs up Telnyx when OpenAI calls end_call", async () => {
    const hangup = vi.fn(async () => undefined);
    const openaiSend = vi.fn();
    const call = sampleCall();
    const bridge = new OpenAIMediaBridge({
      call,
      sendOpenAI: openaiSend,
      sendTelnyx: vi.fn(),
      telnyx: { dial: vi.fn(), hangup },
      hangupDelayMs: 0,
    });
    await bridge.onOpenAIEvent({
      type: "response.function_call_arguments.done",
      name: "end_call",
      call_id: "tool-1",
    });
    expect(openaiSend).toHaveBeenCalledWith({
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

  it("enables create_response only after the scripted greeting has finished", async () => {
    const openaiSend = vi.fn();
    const telnyxSend = vi.fn();
    const bridge = new OpenAIMediaBridge({
      call: sampleCall(),
      sendOpenAI: openaiSend,
      sendTelnyx: telnyxSend,
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
    });
    bridge.attachTelnyx(telnyxSend);
    bridge.configureSession();
    const first = openaiSend.mock.calls.find((c) => c[0]?.type === "session.update")?.[0] as {
      session: { audio: { input: { turn_detection: { create_response: boolean } } } };
    };
    expect(first.session.audio.input.turn_detection.create_response).toBe(false);

    await bridge.onOpenAIEvent({ type: "session.updated" });
    await bridge.onOpenAIEvent({
      type: "response.created",
      response: { id: "greet-1", metadata: { purpose: "greeting" } },
    });
    await bridge.onOpenAIEvent({ type: "response.output_audio.delta", response_id: "greet-1", delta: "UlRQQQ==" });
    await bridge.onOpenAIEvent({ type: "response.done", response: { id: "greet-1", metadata: { purpose: "greeting" } } });

    const talking = openaiSend.mock.calls
      .map((c) => c[0] as { type?: string; session?: { audio?: { input?: { turn_detection?: { create_response?: boolean } } } } })
      .filter((m) => m.type === "session.update")
      .at(-1);
    expect(talking?.session?.audio?.input?.turn_detection?.create_response).toBe(true);
  });
});
