import type { CallRecord } from "./calls/types.js";

export async function notifyResultWebhook(
  url: string | undefined,
  call: CallRecord,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!url) return;
  const body = {
    id: call.id,
    status: call.status,
    to: call.to,
    from: call.from,
    language: call.language,
    greeting: call.greeting,
    objective: call.objective,
    voice: call.voice,
    model: call.model,
    transcript: call.transcript,
    endedReason: call.endedReason,
    createdAt: call.createdAt,
    answeredAt: call.answeredAt,
    endedAt: call.endedAt,
    origem: "outbound-voice-agent",
    metadata: call.metadata,
  };
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(`[result-webhook] ${call.id} HTTP ${res.status}`);
    }
  } catch (err) {
    console.error(`[result-webhook] ${call.id}`, err);
  }
}
