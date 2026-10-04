import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { MediaBridge } from "../src/bridge/media-bridge.js";
import { composeSpokenGreeting } from "../src/greeting.js";
import {
  DEFAULT_SILENCE_ADVANCE_MS,
  isBackchannelUtterance,
  nextSpokenTurn,
  openerLeaksBookingFacts,
  parseObjectiveFacts,
  speakingSpecInstructions,
  type TableFactKey,
} from "../src/objective.js";
import { parseOutboundBody } from "../src/outbound.js";
import { buildSessionInstructions } from "../src/prompt.js";
import type { CallRecord } from "../src/calls/types.js";

const LISBON_AFTERNOON = new Date("2026-09-04T12:00:00.000Z");

const RESTAURANT_OBJECTIVE =
  "Marcar mesa para 2 pessoas hoje às 21:00, em nome de Nuno Barreto.";

describe("spec de fala outbound", () => {
  it("lives in the repo in European Portuguese", () => {
    const spec = readFileSync(new URL("../docs/spec-fala-outbound.md", import.meta.url), "utf8");
    expect(spec).toMatch(/Tem mesa para hoje\?/);
    expect(spec).toMatch(/Um bot, muitos objectivos/);
    expect(spec).toMatch(/diga/);
    expect(spec).toMatch(/pessoas/);
    expect(spec).toMatch(/hora/);
    expect(spec).toMatch(/nome/);
    expect(spec).toMatch(/Nunca dois factos/);
    expect(spec).toMatch(/Alice inbound/);
  });
});

describe("restaurant opener", () => {
  it("is a fixed line that does not dump persona, time, party size, or name", () => {
    const facts = parseObjectiveFacts(RESTAURANT_OBJECTIVE);
    expect(facts).toMatchObject({
      kind: "table",
      partySize: "2",
      time: "21:00",
      name: "Nuno Barreto",
      date: "hoje",
    });

    const spoken = composeSpokenGreeting({
      language: "pt-PT",
      persona: "cliente",
      objective: RESTAURANT_OBJECTIVE,
      now: LISBON_AFTERNOON,
    });
    expect(spoken).toBe("Boa tarde. Tem mesa para hoje?");
    expect(openerLeaksBookingFacts(spoken, facts)).toBe(false);
    expect(spoken).not.toMatch(/\b2\b/);
    expect(spoken).not.toMatch(/duas/i);
    expect(spoken).not.toMatch(/21:00|21h|às 21/i);
    expect(spoken).not.toMatch(/Nuno|Barreto/i);
    expect(spoken).not.toMatch(/sou a cliente/i);
    expect(spoken).not.toMatch(/Marcar mesa/i);

    const parsed = parseOutboundBody(
      {
        to: "+351912345678",
        language: "pt-PT",
        persona: "cliente",
        objective: RESTAURANT_OBJECTIVE,
        waitForCallee: true,
      },
      { now: LISBON_AFTERNOON },
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.greeting).toBe("Boa tarde. Tem mesa para hoje?");
  });
});

describe("restaurant turns: answer first, else advance one fact", () => {
  const facts = parseObjectiveFacts(RESTAURANT_OBJECTIVE);
  const greeting = "Boa tarde. Tem mesa para hoje?";

  it("answers the callee's question with one fact and does not repeat the script", () => {
    const turn = nextSpokenTurn({
      language: "pt-PT",
      facts,
      spokenFacts: [],
      calleeText: "Para quantas pessoas?",
      greeting,
    });
    expect(turn.reason).toBe("answer");
    expect(turn.fact).toBe("party_size");
    expect(turn.utterance).toBe("Para duas pessoas.");
    expect(turn.utterance).not.toBe(greeting);
    expect(turn.utterance).not.toMatch(/21:00/);
    expect(turn.utterance).not.toMatch(/Nuno/);
    expect(countFactsInUtterance(turn.utterance, facts)).toBe(1);
  });

  it("advances intent then party size then time then name on diga or wait", () => {
    const spoken: TableFactKey[] = [];
    const diga = nextSpokenTurn({
      language: "pt-PT",
      facts,
      spokenFacts: spoken,
      calleeText: "diga",
      greeting,
    });
    expect(diga.reason).toBe("advance");
    expect(diga.fact).toBe("intent");
    expect(diga.utterance).toBe("Queria uma mesa.");
    expect(countFactsInUtterance(diga.utterance, facts)).toBe(0);
    spoken.push("intent");

    const wait = nextSpokenTurn({
      language: "pt-PT",
      facts,
      spokenFacts: spoken,
      calleeText: "",
      greeting,
    });
    expect(wait.reason).toBe("advance");
    expect(wait.fact).toBe("party_size");
    expect(wait.utterance).toBe("Para duas pessoas.");
    spoken.push("party_size");

    const time = nextSpokenTurn({
      language: "pt-PT",
      facts,
      spokenFacts: spoken,
      calleeText: "diga",
      greeting,
    });
    expect(time.fact).toBe("time");
    expect(time.utterance).toBe("Às 21:00.");
    spoken.push("time");

    const name = nextSpokenTurn({
      language: "pt-PT",
      facts,
      spokenFacts: spoken,
      calleeText: "",
      greeting,
    });
    expect(name.fact).toBe("name");
    expect(name.utterance).toBe("Em nome de Nuno Barreto.");
    expect(countFactsInUtterance(name.utterance, facts)).toBe(1);
  });

  it("answers a question first, then continues the remaining list on the next turn", () => {
    const asked = nextSpokenTurn({
      language: "pt-PT",
      facts,
      spokenFacts: [],
      calleeText: "Para quantas pessoas?",
      greeting,
    });
    expect(asked.utterance).toBe("Para duas pessoas.");
    expect(asked.utterance).not.toMatch(/21:00|Nuno/);

    const continued = nextSpokenTurn({
      language: "pt-PT",
      facts,
      spokenFacts: asked.fact ? [asked.fact] : [],
      calleeText: "diga",
      greeting,
    });
    expect(continued.reason).toBe("advance");
    expect(continued.fact).toBe("time");
    expect(continued.utterance).toBe("Às 21:00.");
    expect(continued.utterance).not.toMatch(/duas|Nuno/i);
  });

  it("does not treat a lone hum/ah/ok as end of turn", () => {
    expect(isBackchannelUtterance("hum")).toBe(true);
    expect(isBackchannelUtterance("ah")).toBe(true);
    expect(isBackchannelUtterance("ok")).toBe(true);
    const turn = nextSpokenTurn({
      language: "pt-PT",
      facts,
      spokenFacts: [],
      calleeText: "ok",
      greeting,
    });
    expect(turn.reason).toBe("backchannel");
    expect(turn.utterance).toBe("");
  });

  it("encodes the spec in session instructions without a readable dump", () => {
    const text = buildSessionInstructions({
      language: "pt-PT",
      greeting,
      persona: "cliente",
      objective: RESTAURANT_OBJECTIVE,
      waitForCallee: true,
    });
    expect(text).toMatch(/um facto por turno/i);
    expect(text).toMatch(/diga/);
    expect(text).toMatch(/Pessoas: 2/);
    expect(text).toMatch(/Hora: 21:00/);
    expect(text).toMatch(/Nome: Nuno Barreto/);
    expect(speakingSpecInstructions("pt-PT")).toMatch(/Não ditas que a conversa está a ser registada/);
    expect(text).not.toMatch(/Marcar mesa para 2 pessoas hoje às 21:00, em nome de Nuno Barreto/);
  });
});

describe("restaurant session: callee speech must become a new model turn", () => {
  it("requests a second model turn when the callee asks after the opener", async () => {
    const grokSend = vi.fn();
    const telnyxSend = vi.fn();
    const greeting = "Boa tarde. Tem mesa para hoje?";
    const bridge = new MediaBridge({
      call: restaurantCall(greeting),
      sendGrok: grokSend,
      sendTelnyx: telnyxSend,
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
      silenceAdvanceMs: 0,
    });
    await unlockAndPlayGreeting(bridge, grokSend);
    grokSend.mockClear();

    await bridge.onGrokEvent({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "u2",
      transcript: "Para quantas pessoas?",
    });

    const created = grokSend.mock.calls.some((c) => (c[0] as { type?: string }).type === "response.create");
    if (!created) {
      throw new Error(
        "session bug: callee audio never became a new model turn (no response.create after the restaurant question)",
      );
    }

    const second = nextSpokenTurn({
      language: "pt-PT",
      facts: parseObjectiveFacts(RESTAURANT_OBJECTIVE),
      spokenFacts: [],
      calleeText: "Para quantas pessoas?",
      greeting,
    });
    expect(second.utterance).toBe("Para duas pessoas.");
    expect(second.utterance).not.toBe(greeting);
  });

  it("advances on silence after the opener (wait, not a question)", async () => {
    let now = 0;
    const grokSend = vi.fn();
    const bridge = new MediaBridge({
      call: restaurantCall("Boa tarde. Tem mesa para hoje?"),
      sendGrok: grokSend,
      sendTelnyx: vi.fn(),
      telnyx: { dial: vi.fn(), hangup: vi.fn() },
      clockMs: () => now,
      silenceAdvanceMs: DEFAULT_SILENCE_ADVANCE_MS,
    });
    await unlockAndPlayGreeting(bridge, grokSend);
    grokSend.mockClear();
    now = DEFAULT_SILENCE_ADVANCE_MS;
    bridge.onTelnyxMessage({ event: "media", media: { payload: "QUJDRA==" } });
    const created = grokSend.mock.calls.some((c) => (c[0] as { type?: string }).type === "response.create");
    if (!created) {
      throw new Error("session bug: callee wait never became a new model turn");
    }
  });
});

function restaurantCall(greeting: string): CallRecord {
  return {
    id: "call-rest",
    status: "answered",
    to: "+351912345678",
    from: "+351210210260",
    language: "pt-PT",
    greeting,
    objective: RESTAURANT_OBJECTIVE,
    persona: "cliente",
    waitForCallee: true,
    voice: "ara",
    model: "grok-voice-think-fast-2.0",
    ttsProvider: "grok",
    streamToken: "tok",
    telnyx: { callControlId: "v2:control-id" },
    transcript: [],
    createdAt: new Date().toISOString(),
  };
}

async function unlockAndPlayGreeting(
  bridge: MediaBridge,
  grokSend: ReturnType<typeof vi.fn>,
): Promise<void> {
  await bridge.onGrokEvent({ type: "session.updated" });
  await bridge.onGrokEvent({ type: "response.created", response_id: "greet-warm" });
  await bridge.onGrokEvent({ type: "response.output_audio.delta", delta: "WARMFRAME" });
  await bridge.onGrokEvent({ type: "response.done", response_id: "greet-warm" });
  bridge.onTelnyxMessage({ event: "start" });
  await bridge.onGrokEvent({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "u1",
    transcript: "Estou",
  });
  await bridge.onGrokEvent({ type: "response.created", response_id: "greeting" });
  await bridge.onGrokEvent({ type: "response.output_audio.delta", delta: "R1JFVQ==" });
  await bridge.onGrokEvent({ type: "response.done", response_id: "greeting" });
  expect(grokSend.mock.calls.some((c) => (c[0] as { item?: { type?: string } }).item?.type === "force_message")).toBe(
    true,
  );
}

function countFactsInUtterance(
  utterance: string,
  facts: ReturnType<typeof parseObjectiveFacts>,
): number {
  const folded = utterance.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  let n = 0;
  if (facts.partySize) {
    const word = facts.partySize === "2" ? "duas" : "";
    if (new RegExp(String.raw`\b${facts.partySize}\s+pessoas?\b`).test(folded) || (word && folded.includes(word))) {
      n += 1;
    }
  }
  if (facts.time && (folded.includes(facts.time) || folded.includes(facts.time.replace(":", "h")))) n += 1;
  if (facts.name && folded.includes("nuno")) n += 1;
  return n;
}
