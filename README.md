# outbound-voice-agent

Outbound-only **Grok Voice Live 2** agent over **Telnyx Call Control** (Alfaseguros).

Places PSTN calls from **+351210210260**, bridges bidirectional audio to xAI Grok Voice (`ara`), speaks a greeting, pursues an objective, hangs up. Languages: **`pt-PT` | `en-GB` | `en-US`** (default `pt-PT`). Not Alice.

Persona (`persona` preferred, or `greeting`) and objective always come from `POST /api/outbound`. The agent is the **caller who books** — never the restaurant. It speaks as a person on the phone — never a product name, never a recording notice, never «bem-vindo ao restaurante».

Set `waitForCallee: true` on `POST /api/outbound` to stay silent until the callee speaks (e.g. «Estou» / «estou?»), then deliver the composed greeting (Olá + time-of-day + caller identity + a short natural ask — never a ROLEPLAY dump), then pursue the objective. Callers may pass `persona` / `greeting` / `spokenAsk` or omit them — the service composes from persona + sanitized purpose + local time (`Europe/Lisbon` by default). Default remains immediate greeting (no wait).

Tests never place real phone calls.

## Telnyx (TRNSF)

| | |
| --- | --- |
| Call Control app | **TRNSX-Outbound-Grok** `TELNYX_CONNECTION_ID=3041732714274227469` |
| Outbound Voice Profile | `TELNYX_OUTBOUND_VOICE_PROFILE_ID=3041732644774610184` (bound to the app) |
| Caller ID | `FROM_NUMBER=+351210210260` |
| Webhook | `{PUBLIC_BASE_URL}/webhooks/telnyx` |

Secrets (`TELNYX_API_KEY`, `XAI_API_KEY`, `API_KEY`) are set on Railway after merge.

## Call flow

1. `POST /api/outbound` → Telnyx `POST /v2/calls` with bidirectional media streaming.
2. Telnyx connects to `wss://…/media-stream`.
3. This app opens `wss://api.x.ai/v1/realtime` (Grok Voice Live 2, voice `ara`).
4. Greeting is spoken verbatim exactly once (`force_message`): «Olá» + Lisbon time-of-day + caller identity + a **short natural ask**. The spoken line never includes raw `objective` dumps, `ROLEPLAY` blocks, markdown, system instructions, or venue-welcome lines (`composeSpokenGreeting` sanitizes). Optional `spokenAsk` supplies a clean ask when the objective is a prompt. Session instructions require a human phone voice (`ara`): warmth, intonation, «certo»/«perfeito», short sentences, never reading numbered lists. The bot is who **dialled** and requests the booking; the interlocutor is venue staff who answered. With `waitForCallee: true`, the bridge stays mute until **real callee words** (short greetings like «Estou»/«estou?»/«alô»/«sim», any non-empty transcript, or speech after a ~500ms grace window lasting at least `GROK_CALLEE_MIN_SPEECH_MS`, default **80ms**). Early `speech_started` from ringback/noise is ignored. Then the greeting is delivered once; `create_response` stays off until that greeting finishes so the model cannot immediately re-introduce itself.
5. The model calls `end_call`. The bridge waits for that turn’s `response.done` plus remaining PCMU playout and `GROK_HANGUP_PLAYOUT_MS` (default 1000ms) so the farewell/summary is not cut mid-sentence, then Telnyx hangup.
6. Optional `RESULT_WEBHOOK` receives the transcript and outcome.

## HTTP API

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health` | none | Liveness + config readiness |
| `POST` | `/api/outbound` | `Bearer API_KEY` | Place an outbound call |
| `GET` | `/api/calls/:id` | `Bearer API_KEY` | Call status + transcript |
| `POST` | `/webhooks/telnyx` | Telnyx Ed25519 (if `TELNYX_PUBLIC_KEY` set) | Call Control events |
| `WS` | `/media-stream?callId=&token=` | stream token | Telnyx ↔ Grok audio bridge |

### `POST /api/outbound`

`language` is optional: `pt-PT` | `en-GB` | `en-US` (default `pt-PT`). Invalid values are rejected. `pt-PT` is European Portuguese only — never Brazilian (`pt-BR`), including vocabulary and greeting patterns («Oi», «Tudo bem?», «bem-vindo ao restaurante»).

`tts_provider` is optional: `grok` | `elevenlabs` (default `grok`). Grok voice stays **`ara`**. `elevenlabs` is dual-ready: if `ELEVENLABS_API_KEY` or `ELEVENLABS_VOICE_ID` is missing, the API returns **503 `elevenlabs_not_configured`**. When both are set the call is accepted but audio still goes through Grok until the ElevenLabs pipeline is wired.

`bot_role` (default `caller_booking`) and `callee_role` (default `venue_staff`) are optional labels. The bot **always** placed the call and requests the booking. The callee answered (venue staff / reception). The bot never welcomes as the restaurant and never offers tables as the house.

`persona` is the optional spoken identity (preferred over `greeting` when both are sent). Compose: Olá/Hello + time-of-day + persona + sanitized ask from `objective`. `greeting` remains supported as the identity line when `persona` is omitted. If both identity fields are omitted, the service inserts a caller identity («Ligo da secretária.» / “I'm calling from the secretary.”). Raw `ROLEPLAY` / prompt dumps in `objective` are **never** copied into `force_message`. Optional `spokenAsk` is a clean one-line ask used when `objective` is a script. `waitForCallee` no longer requires `greeting`.

Optional `timezone` is an IANA name (default `Europe/Lisbon`). Invalid values are 400 `invalid_timezone`.

Time-of-day (`pt-PT`): `Bom dia` before 12:00, `Boa tarde` from 12:00 until 20:00, `Boa noite` from 20:00. English: Good morning before 12:00, Good afternoon until 17:00, Good evening after that.

`waitForCallee` is optional (default `false`). When `true`, the bridge does not speak on `session.updated`, stream start, or Grok session create. Grok `turn_detection.create_response` is `false` (so the model cannot auto-greet), outbound audio is dropped, and any premature `response.created` is cancelled. The greeting is spoken once via `force_message` after **real callee speech**: a short greeting transcript («estou», «estou?», «alô», «sim», «ok», «hello», including garbled «Two»), any other non-empty user transcription, or `speech_started`+`speech_stopped` after a ~500ms grace window (`GROK_CALLEE_SPEECH_GRACE_MS`) with duration ≥ `GROK_CALLEE_MIN_SPEECH_MS` (default **80ms**), even with empty ASR. A word-length utterance that finishes *during* grace is remembered and unlocks as soon as grace ends (next media frame or VAD event) so «estou» / «estou?» does not wait on ASR. `create_response` stays off until that greeting's `response.done`, and any model turn before the callee speaks again is cancelled so the greeting is not repeated. Ringback/`speech_started` in the grace window does not unlock mute immediately; a word-length utterance that *ends after* grace can unlock. Unlock logs include the reason, ms since stream start, and a transcript snippet. The unlocking user line is recorded before the greeting in the transcript when transcription is what unlocks. Extra `instructions` that ask to wait until the callee speaks also enable this unless `waitForCallee` is explicitly `false`. Prefer `waitForCallee: true` on the request. Prompt text alone is not what keeps the line silent. Session instructions treat the agent as the caller making/confirming a booking: never invent or deny reservation state the interlocutor already stated (e.g. «já estava marcado»); never greet as the restaurant.

- `pt-PT` — European Portuguese (never Brazilian). Spoken opening: `Olá, bom dia/boa tarde/boa noite.` plus persona and purpose.
- `en-GB` — natural British English. Spoken opening: `Hello, good morning/afternoon/evening.` plus persona and purpose.
- `en-US` — natural American English. Same English opening as `en-GB`.

```json
{
  "to": "+351912345678",
  "language": "pt-PT",
  "persona": "secretária da Alfaseguros",
  "greeting": "Olá, fala a secretária da Alfaseguros.",
  "objective": "Confirmar a marcação de quinta-feira às 16h.",
  "spokenAsk": "Confirmar a marcação de quinta-feira às 16h.",
  "timezone": "Europe/Lisbon",
  "instructions": "optional extra prompt rules",
  "waitForCallee": true,
  "tts_provider": "grok",
  "bot_role": "caller_booking",
  "callee_role": "venue_staff",
  "metadata": { "ticketId": "abc" },
  "maxDurationSeconds": 300
}
```

Example spoken `force_message` from that body at 13:00 Lisbon: `Olá, boa tarde. Fala a secretária da Alfaseguros. Confirmar a marcação de quinta-feira às 16h.`

TRNSF can omit `greeting` and send only `persona` + `objective` + `waitForCallee: true`. Roles default to caller booking vs venue staff even when omitted.

## Telnyx dial

`POST https://api.telnyx.com/v2/calls` with:

- `connection_id` = `TELNYX_CONNECTION_ID` (TRNSX-Outbound-Grok)
- `from` = `+351210210260`
- `stream_url` → this service’s media WebSocket
- `stream_bidirectional_mode=rtp`, codec `PCMU`, `stream_bidirectional_target_legs=self`
- `webhook_url` = `{PUBLIC_BASE_URL}/webhooks/telnyx`

The OVP is associated with the Call Control application in Mission Control, not sent on each dial.

## Environment

See [`.env.example`](.env.example).

## Run locally

```bash
npm ci
cp .env.example .env   # tests do not need live Telnyx/xAI keys
npm test
npm run typecheck
npm run dev            # http://localhost:3000/health
```

## Railway

`railway.json` health-checks `GET /health`. Point the Telnyx Call Control app webhook at `https://<service>/webhooks/telnyx` once `PUBLIC_BASE_URL` is known.

In-memory call state is per replica. Run a single instance.

## Audio

Telnyx bidirectional PCMU 8 kHz ↔ Grok Voice `audio/pcmu`. Caller barge-in sends Telnyx `clear` **and** Grok `response.cancel` so playback and the in-flight model turn both stop mid-sentence (except while `end_call` hangup is waiting for goodbye playout). Grok `server_vad` uses a short end-of-turn silence (`GROK_VAD_SILENCE_MS`, default **160ms**) so replies start as soon as the callee finishes. Leave this at 160 — dropping it further can chop barge-in. `turn_detection.interrupt_response` is enabled. The Telnyx↔Grok bridge forwards audio immediately (no extra debounce after `speech_stopped`). Optional `GROK_VOICE_SPEED` maps to xAI `audio.output.speed` (0.7–1.5, default **1.05** — leave this as-is; liveliness comes from the prompt, not speed). Voice id stays `ara` unless `GROK_VOICE` is set. xAI Speech-to-Speech prompting forbids stage directions; TTS `[pause]` tags are **not** injected into `force_message` or the realtime stream.
