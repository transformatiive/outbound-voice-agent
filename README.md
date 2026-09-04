# outbound-voice-agent

Outbound-only **Grok Voice Live 2** agent over **Telnyx Call Control** (Alfaseguros).

Places PSTN calls from **+351210210260**, bridges bidirectional audio to xAI Grok Voice (`ara`), speaks a greeting, pursues an objective, hangs up. Languages: **`pt-PT` | `en-GB` | `en-US`** (default `pt-PT`). Not Alice.

Set `waitForCallee: true` on `POST /api/outbound` to stay silent until the callee speaks (e.g. «Estou»), then deliver the greeting, then pursue the objective. Default remains immediate greeting.

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
4. Greeting is spoken verbatim (`force_message`), then the model works the objective in the requested language (`pt-PT`, `en-GB`, or `en-US`). With `waitForCallee: true`, the greeting waits until the callee speaks first.
5. The model calls `end_call` → Telnyx hangup.
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

`language` is optional: `pt-PT` | `en-GB` | `en-US` (default `pt-PT`). Invalid values are rejected. `greeting` is optional; if omitted, a language-specific default is spoken.

`waitForCallee` is optional (default `false`). When `true`, the agent does not speak on `session.updated`; it waits for first callee speech (`input_audio_buffer.speech_started` or a non-empty user transcription), then speaks the greeting once. Extra `instructions` that ask to wait until the callee speaks also enable this unless `waitForCallee` is explicitly `false`. Prefer `waitForCallee: true` on the request.

- `pt-PT` — European Portuguese (never Brazilian). Default greeting: `Olá, fala a Ara. Esta chamada é gravada.`
- `en-GB` — natural British English. Default greeting: `Hello, this is Ara. This call is being recorded.`
- `en-US` — natural American English. Default greeting: `Hi, this is Ara. This call is being recorded.`

```json
{
  "to": "+351912345678",
  "language": "pt-PT",
  "greeting": "Olá, fala a Ara da Alfaseguros. Esta chamada é gravada.",
  "objective": "Confirmar a marcação de quinta-feira às 16h.",
  "instructions": "optional extra prompt rules",
  "waitForCallee": true,
  "metadata": { "ticketId": "abc" },
  "maxDurationSeconds": 300
}
```

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

Telnyx bidirectional PCMU 8 kHz ↔ Grok Voice `audio/pcmu`. Caller barge-in sends Telnyx `clear`.
