/**
 * ElevenLabs eleven_v3 / eleven_v3_conversational audio tags.
 * Bracketed cues are performance direction, not words to speak.
 *
 * | Tag        | When |
 * | ---------- | ---- |
 * | `[warmly]` | Opening greeting, thanks, confirmations, default phone tone |
 * | `[curious]`| Questions (booking time, a missing preference) |
 * | `[sighs]`  | Empathy / decline / the callee sounds busy or apologetic |
 *
 * Never inject these into Grok `force_message`, session instructions, or
 * transcripts. Only the ElevenLabs HTTP TTS body may contain them.
 */
export const EL_V3_TAG_WARMLY = "[warmly]";
export const EL_V3_TAG_CURIOUS = "[curious]";
export const EL_V3_TAG_SIGHS = "[sighs]";

export type ElevenLabsSpeechMoment = "greeting" | "question" | "empathy" | "thanks" | "neutral";

const AUDIO_TAG = /\[[a-zA-Z][a-zA-Z\s']{0,40}\]/g;

const TIME_OR_HELLO =
  /^(olá|ola|hello|bom dia|boa tarde|boa noite|good morning|good afternoon|good evening|sou a|sou o|this is|i'm calling)\b/i;

const EMPATHY =
  /\b(sinto muito|sinto|desculpe|desculpa|pena|percebo|compreendo|lamento|ocupad|recus|sorry|unfortunately)\b/i;

const THANKS = /\b(obrigad[oa]s?|thank you|thanks)\b/i;

export function stripElevenLabsAudioTags(text: string): string {
  return text.replace(AUDIO_TAG, " ").replace(/\s+/g, " ").trim();
}

export function inferElevenLabsSpeechMoment(text: string): ElevenLabsSpeechMoment {
  const t = stripElevenLabsAudioTags(text);
  if (!t) return "neutral";
  if (TIME_OR_HELLO.test(t)) return "greeting";
  if (/\?/.test(t)) return "question";
  if (EMPATHY.test(t)) return "empathy";
  if (THANKS.test(t)) return "thanks";
  return "neutral";
}

export function tagForSpeechMoment(moment: ElevenLabsSpeechMoment): string {
  switch (moment) {
    case "greeting":
    case "thanks":
    case "neutral":
      return EL_V3_TAG_WARMLY;
    case "question":
      return EL_V3_TAG_CURIOUS;
    case "empathy":
      return EL_V3_TAG_SIGHS;
    default: {
      const _never: never = moment;
      throw new Error(`unsupported speech moment: ${_never}`);
    }
  }
}

export function tagElevenLabsSpeech(text: string, moment?: ElevenLabsSpeechMoment): string {
  const clean = stripElevenLabsAudioTags(text);
  if (!clean) return "";
  const tag = tagForSpeechMoment(moment ?? inferElevenLabsSpeechMoment(clean));
  return `${tag} ${clean}`;
}
