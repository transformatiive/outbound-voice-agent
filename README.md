# outbound-voice-agent

Outbound-only **Grok Voice Live 2** agent over **Telnyx Call Control** (Alfaseguros).

This service places PSTN calls from caller ID **+351210210260**, bridges bidirectional audio to xAI Grok Voice (`ara`), speaks a greeting, pursues an objective, then hangs up. It is **not** Alice (no inbound SIP, no Alfaseguros inbound receptionist prompt).

Tests never place real phone calls. Do not dial live numbers from CI or local test runs.

## Call flow

1. `POST /api/outbound` → Telnyx `POST /v2/calls` with bidirectional media streaming.
2. Telnyx connects to `wss://…/media-stream`.
3. This app opens `wss://api.x.ai/v1/realtime` (Grok Voice Live 2).
4. Greeting is spoken verbatim (`force_message`), then the model works the objective.
5. The model calls `end_call` → Telnyx hangup.
6. Optional `RESULT_WEBHOOK` receives the transcript and outcome.

Languages: `pt-PT` | `en-GB` | `en-US`.

## HTTP API

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health` | none | Liveness + config readiness |
| `POST` | `/api/outbound` | `Bearer API_KEY` | Place an outbound call |
| `GET` | `/api/calls/:id` | `Bearer API_KEY` | Call status + transcript |
| `POST` | `/webhooks/telnyx` | Telnyx Ed25519 (if `TELNYX_PUBLIC_KEY` set) | Call Control events |
| `WS` | `/media-stream?callId=&token=` | stream token | Telnyx ↔ Grok audio bridge |

### `POST /api/outbound`

```json
{
  "to": "+351912345678",
  "language": "pt-PT",
  "greeting": "Olá, fala a Ara da Alfaseguros. Esta chamada é gravada.",
  "objective": "Confirmar a marcação de quinta-feira às 16h.",
  "instructions": "optional extra prompt rules",
  "metadata": { "ticketId": "abc" },
  "maxDurationSeconds": 300
}
```

`201` response:

```json
{
  "id": "uuid",
  "status": "dialing",
  "to": "+351912345678",
  "from": "+351210210260",
  "language": "pt-PT",
  "voice": "ara",
  "model": "grok-voice-think-fast-2.0",
  "createdAt": "…"
}
```

## Telnyx

Outbound uses Call Control `POST https://api.telnyx.com/v2/calls` with:

- `connection_id` from `TELNYX_CONNECTION_ID` (ops: `3041732714274227469`)
- `from` = `FROM_NUMBER` (default `+351210210260`)
- `stream_url` pointing at this service’s media WebSocket
- `stream_bidirectional_mode=rtp`
- `stream_bidirectional_codec=PCMU` (passthrough to Grok `audio/pcmu`, 8 kHz)
- `stream_bidirectional_target_legs=self` (required for API-originated outbound legs)
- `webhook_url` = `{PUBLIC_BASE_URL}/webhooks/telnyx`

In Mission Control, point the Call Control Application webhook at `https://<this-host>/webhooks/telnyx` as a fallback.

## Environment

See [`.env.example`](.env.example). Required to actually dial:

`TELNYX_API_KEY`, `TELNYX_CONNECTION_ID`, `FROM_NUMBER`, `XAI_API_KEY`, `API_KEY`, `PUBLIC_BASE_URL`.

Optional: `GROK_VOICE` (default `ara`), `GROK_MODEL` (default `grok-voice-think-fast-2.0`), `RESULT_WEBHOOK`, `TELNYX_PUBLIC_KEY`.

## Run locally

```bash
npm ci
cp .env.example .env   # fill keys; tests do not need a live Telnyx dial
npm test
npm run typecheck
npm run dev            # http://localhost:3000/health
```

## Railway

`railway.json` health-checks `GET /health`. Nixpacks uses `npm run build` then `npm start`. Set the env vars on the service; `PORT` is injected.

```bash
railway variables set PUBLIC_BASE_URL=https://<your-service>.up.railway.app
railway variables set FROM_NUMBER=+351210210260
railway variables set GROK_VOICE=ara
# TELNYX_CONNECTION_ID=3041732714274227469  (ops)
```

In-memory call state is per replica. Run a single instance.

## Audio

Telnyx bidirectional PCMU 8 kHz ↔ Grok Voice `audio/pcmu`. No resampler. Caller barge-in sends Telnyx `clear`.
