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
3. This app opens `wss://api.x.ai/v1/realtime` (Grok Voice Live 2, voice `ara`) for **STT + dialogue**. With `tts_provider=elevenlabs`, Grok `response.output_audio.delta` is **not** forwarded to Telnyx; assistant text is spoken with ElevenLabs TTS (Benedita) as Telnyx `media` PCMU frames. With `tts_provider=grok`, Grok audio is forwarded as today.
4. Greeting is spoken verbatim exactly once. On `grok`, that is Grok `force_message` audio. On `elevenlabs`, Grok still receives `force_message` for conversation state, but Telnyx hears ElevenLabs TTS of the composed greeting — «Olá» + Lisbon time-of-day + caller identity + a **short natural ask**. The spoken line never includes raw `objective` dumps, `ROLEPLAY` blocks, markdown, system instructions, or venue-welcome lines (`composeSpokenGreeting` sanitizes). Optional `spokenAsk` supplies a clean ask when the objective is a prompt. Session instructions require a human phone voice: warmth, intonation, «certo»/«perfeito», short sentences, never reading numbered lists, and **never inventing venue facts** (opening hours, menus, prices, policies, «só abre às X») the callee did not state. The bot is who **dialled** and requests the booking; the interlocutor is venue staff who answered. With `waitForCallee: true`, the bridge stays mute until **real callee words** (short greetings like «Estou»/«estou?»/«Still?»/«Esto?»/«Hello?»/«alô»/«sim», any non-empty transcript, a post-grace word-length burst of speech even before ASR, or speech after a ~350ms grace window lasting at least `GROK_CALLEE_MIN_SPEECH_MS`, default **80ms**). Early `speech_started` from ringback/noise is ignored. **Generate early, speak late:** ElevenLabs synthesizes the greeting into a PCMU frame cache at dial (and again on media-stream attach if needed). `waitForCallee` mute stays hard — cached audio is not sent to Telnyx until unlock. Unlock is **playback only** of already-ready frames (no ElevenLabs HTTP on the critical path when the cache hit). Grok path primes `session.update` on stream attach the same way, still silent until unlock, then `force_message`. Then the greeting is delivered once; `create_response` stays off until that greeting finishes so the model cannot immediately re-introduce itself.
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

`tts_provider` is optional: `grok` | `elevenlabs` (default `grok`). Grok and ElevenLabs are **interchangeable on the same API/call**. Same dial flow, same `persona` / `objective` / roles / `pt-PT` fields — only Telnyx TTS/voice changes. `tts_provider=grok` → real Grok **ara** PCMU. `tts_provider=elevenlabs` → real Benedita (`ELEVENLABS_VOICE_ID`, default `NkpT2jezTenCDRKHkWiX`) + `eleven_v3` PCMU. Grok Voice Live still does STT and dialogue on every call. **Never** fall back to ara when `elevenlabs` is requested: if the key is missing, `POST /api/outbound` returns **503 `elevenlabs_not_configured`** and does not dial; if the key is present, Telnyx hears Benedita (or silence on TTS failure), never silent ara. Set `ELEVENLABS_MODEL=eleven_flash_v2_5` for lower TTFB (quality tradeoff); the default stays `eleven_v3` unless that env is set.

**TRNSF:** send `tts_provider: "elevenlabs"` on `POST /api/outbound` (snake_case). The JSON field is `tts_provider`; the API echoes `ttsProvider`. Developer sets `ELEVENLABS_API_KEY` on Railway (secret, never in git). `GET /health` reports `tts.elevenlabs.configured` (key present) and `tts.elevenlabs.audioPathActive` (the Benedita → Telnyx pipeline is live, not a stub). Anti-invent venue facts apply to both providers.

`bot_role` (default `caller_booking`) and `callee_role` (default `venue_staff`) are optional labels. The bot **always** placed the call and requests the booking. The callee answered (venue staff / reception). The bot never welcomes as the restaurant and never offers tables as the house.

`persona` is the optional spoken identity (preferred over `greeting` when both are sent). Compose: Olá/Hello + time-of-day + **one short identity clause** + sanitized ask from `objective`. Instruction-stuffed `persona`/`greeting` lines («Fala português…», «Nunca uses brasileiroismos», «Tu LIGAS», ROLEPLAY, IA, Ara, gravada) are stripped and never spoken. `greeting` remains supported as the identity line when `persona` is omitted; a polluted `greeting` is ignored when `persona` + `objective`/`spokenAsk` can compose a clean line. If both identity fields are omitted, the service inserts a caller identity («Ligo da secretária.» / “I'm calling from the secretary.”). Raw `ROLEPLAY` / prompt dumps in `objective` are **never** copied into `force_message`. Optional `spokenAsk` is a clean one-line ask used when `objective` is a script. `waitForCallee` no longer requires `greeting`.

Optional `timezone` is an IANA name (default `Europe/Lisbon`). Invalid values are 400 `invalid_timezone`.

Time-of-day (`pt-PT`): `Bom dia` before 12:00, `Boa tarde` from 12:00 until 20:00, `Boa noite` from 20:00. English: Good morning before 12:00, Good afternoon until 17:00, Good evening after that.

`waitForCallee` is optional (default `false`). When `true`, the bridge does not speak on `session.updated`, stream start, or Grok session create. Grok `turn_detection.create_response` is `false` (so the model cannot auto-greet), outbound audio is dropped, and any premature `response.created` is cancelled. The greeting is spoken once via `force_message` after **real callee speech**: a short greeting transcript («estou», «estou?», «Still?», «Esto?», «Hello?», «alô», «sim», «ok», «hello», including garbled «Two»), any other non-empty user transcription, a post-grace word-length burst (`short_answer`, no wait for slow ASR), or `speech_started`+`speech_stopped` after a ~350ms grace window (`GROK_CALLEE_SPEECH_GRACE_MS`) with duration ≥ `GROK_CALLEE_MIN_SPEECH_MS` (default **80ms**), even with empty ASR. A word-length utterance that finishes *during* grace is remembered and unlocks as soon as grace ends (next media frame or VAD event) so «estou» / «estou?» does not wait on ASR. `create_response` stays off until that greeting's `response.done`, and any model turn before the callee speaks again is cancelled so the greeting is not repeated. Ringback/`speech_started` in the grace window does not unlock mute immediately; a word-length utterance that *ends after* grace can unlock. Unlock logs include the reason, ms since stream start, and a transcript snippet. On `tts_provider=elevenlabs`, greeting PCMU is **prefetched at dial** (`el_latency` `prefetch_start` / `el_http_start` / `el_first_byte` with `source=dial`). Unlock logs `cache=hit` when Telnyx media is playback of that cache (`unlock` → `first_telnyx_media_frame`, `unlock_to_telnyx_ms` near 0). Later turns still log `speech_stopped` → `transcript` → `el_http_start` → `el_first_byte` → `first_telnyx_media_frame`, and the next sentence is synthesized into a PCMU buffer while the current sentence plays. The unlocking user line is recorded before the greeting in the transcript when transcription is what unlocks. Extra `instructions` that ask to wait until the callee speaks also enable this unless `waitForCallee` is explicitly `false`. Prefer `waitForCallee: true` on the request. Prompt text alone is not what keeps the line silent. Session instructions treat the agent as the caller making/confirming a booking: never invent or deny reservation state the interlocutor already stated (e.g. «já estava marcado»); never greet as the restaurant; **never invent venue facts** (opening hours, availability, prices, menus, policies). If reception proposes a time (~18h), accept or negotiate from *their* statement — never invent «o restaurante só abre às 19h».

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
  "tts_provider": "elevenlabs",
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

Telnyx bidirectional PCMU 8 kHz. **`tts_provider=grok`:** Telnyx ↔ Grok Voice `audio/pcmu`. **`tts_provider=elevenlabs`:** Telnyx inbound PCMU still goes to Grok for STT; outbound Telnyx `media` is ElevenLabs μ-law 8 kHz (`ulaw_8000` cached after the first successful format, with `pcm_8000` / `pcm_16000` resample fallback only until that success). Stream URL includes `optimize_streaming_latency` (default **3**). PCMU frames are sent to Telnyx as soon as the first EL bytes arrive (partial first frame, then 20ms frames). Later turns start TTS on the first complete transcript sentence, not only `transcript.done`. Caller barge-in sends Telnyx `clear`, cancels in-flight ElevenLabs playback, **and** Grok `response.cancel` so playback and the in-flight model turn both stop mid-sentence (except while `end_call` hangup is waiting for goodbye playout). Grok `server_vad` uses a short end-of-turn silence (`GROK_VAD_SILENCE_MS`, default **160ms** on the Grok-audio path; `ELEVENLABS_VAD_SILENCE_MS`, default **130ms**, when Telnyx hears Benedita). `turn_detection.interrupt_response` is enabled. The Telnyx↔Grok bridge forwards inbound audio immediately (no extra debounce after `speech_stopped`). Optional `GROK_VOICE_SPEED` maps to xAI `audio.output.speed` (0.7–1.5, default **1.05** — leave this as-is; liveliness comes from the prompt, not speed). Voice id stays `ara` unless `GROK_VOICE` is set. xAI Speech-to-Speech prompting forbids stage directions; TTS `[pause]` tags are **not** injected into `force_message` or the realtime stream.
