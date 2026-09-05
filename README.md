# outbound-voice-agent

Outbound-only voice agent over **Telnyx Call Control** (Alfaseguros). Three interchangeable providers on the same dial API: **Grok Voice Live 2**, **ElevenLabs** (hybrid TTS), and **OpenAI Realtime** speech-to-speech.

Places PSTN calls from **+351210210260**, bridges bidirectional audio, speaks a greeting, pursues an objective, hangs up. Languages: **`pt-PT` | `en-GB` | `en-US`** (default `pt-PT`). Not Alice.

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

Secrets (`TELNYX_API_KEY`, `XAI_API_KEY`, `API_KEY`, `ELEVENLABS_API_KEY`, `OPENAI_API_KEY`) are set on Railway after merge.

## Call flow

1. `POST /api/outbound` → Telnyx `POST /v2/calls` with bidirectional media streaming. Warm-on-dial (generate early / speak late) starts **before answer**:
   - `tts_provider=openai`: OpenAI Realtime WebSocket is opened **before** dial so the session is already warm at answer.
   - `tts_provider=grok` / `elevenlabs`: Grok Voice WebSocket is opened at **dial**; ElevenLabs greeting PCMU is HTTP-prefetched into a cache at dial.
2. Telnyx connects to `wss://…/media-stream`.
3. Provider audio:
   - `tts_provider=grok` (default): this app opens `wss://api.x.ai/v1/realtime` (Grok Voice Live 2, voice `ara`) for **STT + dialogue + voice**. Grok audio is forwarded as Telnyx `media` PCMU frames.
   - `tts_provider=elevenlabs`: Grok still does STT + dialogue; Grok `response.output_audio.delta` is **not** forwarded to Telnyx; assistant text is spoken with ElevenLabs TTS (Benedita) as Telnyx `media` PCMU frames.
   - `tts_provider=openai`: OpenAI Realtime (`gpt-realtime-2.1`, voice `coral` by default) owns **speech-to-speech**. Telnyx PCMU is forwarded to `wss://api.openai.com/v1/realtime`; model PCMU (`audio/pcmu`) is streamed back. Grok is not used. Missing key or a failed Realtime session returns **503** and **does not dial** — never a silent fallback to ara.
4. Greeting is spoken verbatim exactly once. **Generate early, speak late (every provider):** Telnyx stays mute until the call is established and, with `waitForCallee`, until **real callee speech**. Unlock is **playback only** of already-ready frames (no TTS HTTP / no model generation on the critical path when the cache hit). On `grok`, that is Grok `force_message` audio cached from the warmup response. On `elevenlabs`, Grok still receives `force_message` for conversation state, but Telnyx hears ElevenLabs TTS of the composed greeting (HTTP at dial). On `openai`, greeting audio is generated out-of-band (`response.create` while muted) and flushed to Telnyx only after unlock / stream attach. The spoken line never includes raw `objective` dumps, `ROLEPLAY` blocks, markdown, system instructions, or venue-welcome lines (`composeSpokenGreeting` sanitizes). Optional `spokenAsk` supplies a clean ask when the objective is a prompt. Session instructions require a human phone voice: warmth, intonation, «certo»/«perfeito», short sentences, never reading numbered lists, and **never inventing venue facts** (opening hours, menus, prices, policies, «só abre às X») the callee did not state. The bot is who **dialled** and requests the booking; the interlocutor is venue staff who answered. With `waitForCallee: true`, the bridge stays mute until **real callee words** (short greetings like «Estou»/«estou?»/«Still?»/«Esto?»/«Hello?»/«alô»/«sim», any non-empty transcript, a post-grace word-length burst of speech even before ASR, or speech after a ~350ms grace window lasting at least `GROK_CALLEE_MIN_SPEECH_MS`, default **80ms**). Early `speech_started` from ringback/noise is ignored. Then the greeting is delivered once; `create_response` stays off until that greeting finishes so the model cannot immediately re-introduce itself.
5. The model calls `end_call`. The bridge waits for that turn’s `response.done` plus remaining PCMU playout and `GROK_HANGUP_PLAYOUT_MS` (default 1000ms) so the farewell/summary is not cut mid-sentence, then Telnyx hangup.
6. Optional `RESULT_WEBHOOK` receives the transcript and outcome.

## HTTP API

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health` | none | Liveness + config readiness |
| `POST` | `/api/outbound` | `Bearer API_KEY` | Place an outbound call |
| `GET` | `/api/calls/:id` | `Bearer API_KEY` | Call status + transcript |
| `POST` | `/webhooks/telnyx` | Telnyx Ed25519 (if `TELNYX_PUBLIC_KEY` set) | Call Control events |
| `WS` | `/media-stream?callId=&token=` | stream token | Telnyx ↔ Grok or OpenAI audio bridge |

### `POST /api/outbound`

`language` is optional: `pt-PT` | `en-GB` | `en-US` (default `pt-PT`). Invalid values are rejected. `pt-PT` is European Portuguese only — never Brazilian (`pt-BR`), including vocabulary and greeting patterns («Oi», «Tudo bem?», «bem-vindo ao restaurante»).

`tts_provider` is optional: `grok` | `elevenlabs` | `openai` (default `grok`). The three are **interchangeable on the same API/call**. Same Telnyx dial, same `persona` / `objective` / roles / `pt-PT` fields — only the voice backend changes.

- `tts_provider=grok` → real Grok **ara** PCMU (STT + dialogue + voice).
- `tts_provider=elevenlabs` → real Benedita (`ELEVENLABS_VOICE_ID`, default `NkpT2jezTenCDRKHkWiX`) + `eleven_v3` PCMU. Grok Voice Live still does STT and dialogue. **Never** fall back to ara when `elevenlabs` is requested: if the key is missing, `POST /api/outbound` returns **503 `elevenlabs_not_configured`** and does not dial; if the key is present, Telnyx hears Benedita (or silence on TTS failure), never silent ara. Set `ELEVENLABS_MODEL=eleven_flash_v2_5` for lower TTFB (quality tradeoff); the default stays `eleven_v3` unless that env is set.
- `tts_provider=openai` → OpenAI Realtime speech-to-speech (`OPENAI_REALTIME_MODEL`, default `gpt-realtime-2.1`, voice `coral` or request `openai_voice`). **Never** fall back to Grok: missing `OPENAI_API_KEY` → **503 `openai_not_configured`**; Realtime session not ready → **503 `openai_session_failed`**.

**TRNSF:** send `tts_provider: "openai"` or `"elevenlabs"` on `POST /api/outbound` (snake_case). The JSON field is `tts_provider`; the API echoes `ttsProvider`. Developer sets `OPENAI_API_KEY` / `ELEVENLABS_API_KEY` on Railway (secret, never in git). `GET /health` reports `tts.openai.configured` and `tts.elevenlabs.configured` (boolean, no secrets) plus `audioPathActive`. Anti-invent venue facts apply to all three providers.

## Latency bar (all three providers)

The product bar is the ChatGPT voice app: **no cold start on first speech**, **barge-in cancels playback immediately**, **minimal gap after the callee stops talking**. Pattern: **generate early, speak late** — prepare audio while muted / ringing; on `waitForCallee` unlock only play or stream.

| Provider | Warm-on-dial |
| --- | --- |
| **openai** | Realtime WebSocket pre-connects at `POST /api/outbound` (before Telnyx answer). Greeting PCMU is generated out-of-band while muted and flushed on unlock. Barge-in sends Telnyx `clear` + `response.cancel` + `output_audio_buffer.clear`. Shared `server_vad` silence **130ms**, `interrupt_response` on. |
| **grok** | Grok Voice WebSocket opens at **dial**. `force_message` is queued as soon as the session is ready; ara PCMU is cached. Unlock is playback of that cache (`unlock_to_telnyx_ms` near 0). Barge-in: Telnyx `clear` + `response.cancel`. Same 130ms VAD. |
| **elevenlabs** | ElevenLabs HTTP prefetch at **dial** into a PCMU cache; Grok WS also opens at dial. Unlock is cache playback (no TTS HTTP on the critical path). Stream URL `optimize_streaming_latency` default **3**. Barge-in abort of in-flight TTS + `response.cancel`. Same 130ms VAD (`ELEVENLABS_VAD_SILENCE_MS` optional override). |

`bot_role` (default `caller_booking`) and `callee_role` (default `venue_staff`) are optional labels. The bot **always** placed the call and requests the booking. The callee answered (venue staff / reception). The bot never welcomes as the restaurant and never offers tables as the house.

`persona` is the optional spoken identity (preferred over `greeting` when both are sent). Compose: Olá/Hello + time-of-day + **one short identity clause** + sanitized ask from `objective`. Instruction-stuffed `persona`/`greeting` lines («Fala português…», «Nunca uses brasileiroismos», «Tu LIGAS», ROLEPLAY, IA, Ara, gravada) are stripped and never spoken. `greeting` remains supported as the identity line when `persona` is omitted; a polluted `greeting` is ignored when `persona` + `objective`/`spokenAsk` can compose a clean line. If both identity fields are omitted, the service inserts a caller identity («Ligo da secretária.» / “I'm calling from the secretary.”). Raw `ROLEPLAY` / prompt dumps in `objective` are **never** copied into `force_message`. Optional `spokenAsk` is a clean one-line ask used when `objective` is a script. `waitForCallee` no longer requires `greeting`.

Optional `timezone` is an IANA name (default `Europe/Lisbon`). Invalid values are 400 `invalid_timezone`.

Time-of-day (`pt-PT`): `Bom dia` before 12:00, `Boa tarde` from 12:00 until 20:00, `Boa noite` from 20:00. English: Good morning before 12:00, Good afternoon until 17:00, Good evening after that.

`waitForCallee` is optional (default `false`). When `true`, the bridge does not **speak** on `session.updated`, stream start, or session create. `turn_detection.create_response` is `false` (so the model cannot auto-greet). **Generate early, speak late (every provider):** Grok Voice session is opened at **dial** (during ring) for grok/ElevenLabs; OpenAI Realtime is pre-connected at dial. Greeting PCMU is cached — ElevenLabs HTTP at dial, Grok ara frames from the warmup response, OpenAI out-of-band `response.create` while muted. Telnyx stays mute until media is attached and, with `waitForCallee`, until **real callee speech**. Unlock is playback of that cache (`unlock_to_telnyx_ms` near 0, `turn_latency cache=hit`), not a cold TTS start. Premature auto `response.created` (not the warmup greeting) is cancelled. The greeting is delivered once after a short greeting transcript («estou», «estou?», «Still?», «Esto?», «Hello?», «alô», «sim», «ok», «hello», including garbled «Two»), any other non-empty user transcription, a post-grace word-length burst (`short_answer`, no wait for slow ASR), or `speech_started`+`speech_stopped` after a ~350ms grace window (`GROK_CALLEE_SPEECH_GRACE_MS`) with duration ≥ `GROK_CALLEE_MIN_SPEECH_MS` (default **80ms**), even with empty ASR. A word-length utterance that finishes *during* grace is remembered and unlocks as soon as grace ends (next media frame or VAD event) so «estou» / «estou?» does not wait on ASR. `create_response` stays off until that greeting finishes, and any model turn before the callee speaks again is cancelled so the greeting is not repeated. Ringback/`speech_started` in the grace window does not unlock mute immediately; a word-length utterance that *ends after* grace can unlock. Unlock logs include the reason, ms since stream start, and a transcript snippet. Shared `turn_latency` stages (all providers): `unlock` → `first_telnyx_media_frame`. ElevenLabs also logs `el_latency` HTTP stages (`prefetch_start` / `el_http_start` / `el_first_byte` at dial). Grok logs `turn_latency … stage=prefetch_start source=dial` when the realtime socket opens. Later turns log `speech_stopped` → (EL: `transcript` → `el_http_start` → `el_first_byte`) → `first_telnyx_media_frame`. EL pipelines the next sentence into PCMU while the current sentence plays. Barge-in is immediate: Telnyx `clear` + `response.cancel` + abort in-flight TTS (OpenAI also `output_audio_buffer.clear`). The unlocking user line is recorded before the greeting in the transcript when transcription is what unlocks. Extra `instructions` that ask to wait until the callee speaks also enable this unless `waitForCallee` is explicitly `false`. Prefer `waitForCallee: true` on the request. Prompt text alone is not what keeps the line silent. Session instructions treat the agent as the caller making/confirming a booking: never invent or deny reservation state the interlocutor already stated (e.g. «já estava marcado»); never greet as the restaurant; **never invent venue facts** (opening hours, availability, prices, menus, policies). If reception proposes a time (~18h), accept or negotiate from *their* statement — never invent «o restaurante só abre às 19h».

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
  "tts_provider": "openai",
  "openai_voice": "coral",
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

Telnyx bidirectional PCMU 8 kHz.

- **`tts_provider=grok`:** Telnyx ↔ Grok Voice `audio/pcmu`.
- **`tts_provider=elevenlabs`:** Telnyx inbound PCMU still goes to Grok for STT; outbound Telnyx `media` is ElevenLabs μ-law 8 kHz (`ulaw_8000` cached after the first successful format, with `pcm_8000` / `pcm_16000` resample fallback only until that success). Stream URL includes `optimize_streaming_latency` (default **3**). PCMU frames are sent to Telnyx as soon as the first EL bytes arrive (partial first frame, then 20ms frames). Later turns start TTS on the first complete transcript sentence, not only `transcript.done`.
- **`tts_provider=openai`:** Telnyx ↔ OpenAI Realtime `audio/pcmu` (G.711 μ-law 8 kHz). No resample. Same barge-in: Telnyx `clear` plus OpenAI `response.cancel` + `output_audio_buffer.clear`.

**8 kHz phone caveat:** PSTN PCMU is narrowband. The ChatGPT app uses 24 kHz; on the phone the voice has less “air” and sibilance. OpenAI `audio/pcmu` matches Telnyx so we do not upsample. pt-PT is locked in session instructions (never Brazilian vocabulary). Expect Realtime to sound slightly less rich than the app, with the same turn-taking target (130ms end-of-turn silence, interrupt on callee speech).

Caller barge-in sends Telnyx `clear`, cancels in-flight ElevenLabs playback when that path is selected, **and** `response.cancel` so playback and the in-flight model turn both stop mid-sentence (except while `end_call` hangup is waiting for goodbye playout). Shared `server_vad` end-of-turn silence is **130ms** for every provider (`GROK_VAD_SILENCE_MS`; ElevenLabs calls may still override with `ELEVENLABS_VAD_SILENCE_MS`). Raise `GROK_VAD_SILENCE_MS` if barge-in chopping shows up. `turn_detection.interrupt_response` is enabled. The Telnyx bridge forwards inbound audio immediately (no extra debounce after `speech_stopped`). Optional `GROK_VOICE_SPEED` maps to xAI `audio.output.speed` (0.7–1.5, default **1.05** — leave this as-is; liveliness comes from the prompt, not speed). Voice id stays `ara` unless `GROK_VOICE` is set. OpenAI voice defaults to `coral` (`OPENAI_VOICE` / `openai_voice`); it cannot change after the first audio of the session. xAI Speech-to-Speech prompting forbids stage directions; TTS `[pause]` tags are **not** injected into `force_message` or the realtime stream.
