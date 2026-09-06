import { describe, expect, it } from "vitest";
import {
  inferElevenLabsSpeechMoment,
  stripElevenLabsAudioTags,
  tagElevenLabsSpeech,
} from "../src/el-v3-tags.js";
import { elevenLabsModelIsV3, elevenLabsModelSupportsAudioTags } from "../src/tts.js";

describe("ElevenLabs v3 audio tags", () => {
  it("tags greeting warmth, questions as curious, and empathy as a soft sigh", () => {
    expect(tagElevenLabsSpeech("Boa tarde, sou a secretária. Queria marcar um jantar.")).toBe(
      "[warmly] Boa tarde, sou a secretária. Queria marcar um jantar.",
    );
    expect(tagElevenLabsSpeech("Pode ser às 20h?")).toBe("[curious] Pode ser às 20h?");
    expect(tagElevenLabsSpeech("Percebo, não faz mal.")).toBe("[sighs] Percebo, não faz mal.");
    expect(tagElevenLabsSpeech("Muito obrigada, até já.")).toBe("[warmly] Muito obrigada, até já.");
  });

  it("does not double-tag and never leaves a tag as the only spoken content", () => {
    expect(tagElevenLabsSpeech("[warmly] Boa noite, sou a Alice.")).toBe(
      "[warmly] Boa noite, sou a Alice.",
    );
    expect(tagElevenLabsSpeech("   ")).toBe("");
  });

  it("strips control tags so transcripts and Grok dialogue stay speakable-clean", () => {
    expect(stripElevenLabsAudioTags("[warmly] Boa tarde, sou a secretária.")).toBe(
      "Boa tarde, sou a secretária.",
    );
    expect(stripElevenLabsAudioTags("[curious] Pode ser às 20h? [sighs]")).toBe("Pode ser às 20h?");
    expect(stripElevenLabsAudioTags("Mesa para 2.")).toBe("Mesa para 2.");
  });

  it("infers moments from conversational phone text", () => {
    expect(inferElevenLabsSpeechMoment("Bom dia, sou o Nuno.")).toBe("greeting");
    expect(inferElevenLabsSpeechMoment("Good evening, I'm calling from the secretary.")).toBe(
      "greeting",
    );
    expect(inferElevenLabsSpeechMoment("Tem mesa para as 20h?")).toBe("question");
    expect(inferElevenLabsSpeechMoment("Sinto muito, não insisto.")).toBe("empathy");
    expect(inferElevenLabsSpeechMoment("Certo, mesa para duas.")).toBe("neutral");
  });

  it("enables tags on eleven_v3 and eleven_v3_conversational only", () => {
    expect(elevenLabsModelIsV3("eleven_v3")).toBe(true);
    expect(elevenLabsModelIsV3("eleven_v3_conversational")).toBe(true);
    expect(elevenLabsModelSupportsAudioTags("eleven_v3")).toBe(true);
    expect(elevenLabsModelSupportsAudioTags("eleven_v3_conversational")).toBe(true);
    expect(elevenLabsModelSupportsAudioTags("eleven_flash_v2_5")).toBe(false);
    expect(elevenLabsModelIsV3("eleven_flash_v2_5")).toBe(false);
  });
});
