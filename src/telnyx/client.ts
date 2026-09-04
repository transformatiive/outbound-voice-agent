export type TelnyxDialRequest = {
  connection_id: string;
  to: string;
  from: string;
  stream_url: string;
  stream_track: "inbound_track" | "outbound_track" | "both_tracks";
  stream_bidirectional_mode: "rtp";
  stream_bidirectional_codec: "PCMU" | "PCMA" | "G722" | "OPUS" | "AMR-WB" | "L16";
  stream_bidirectional_target_legs: "self" | "opposite" | "both";
  webhook_url: string;
  webhook_url_method?: "POST";
  client_state?: string;
  stream_codec?: string;
};

export type TelnyxDialResult = {
  call_control_id: string;
  call_leg_id: string;
  call_session_id: string;
  is_alive: boolean;
  record_type: string;
};

export type TelnyxClient = {
  dial: (body: TelnyxDialRequest) => Promise<TelnyxDialResult>;
  hangup: (callControlId: string) => Promise<void>;
};

type TelnyxHttpOptions = {
  apiKey: string;
  apiBase: string;
  fetchImpl?: typeof fetch;
};

export class TelnyxHttpClient implements TelnyxClient {
  private readonly apiKey: string;
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: TelnyxHttpOptions) {
    this.apiKey = opts.apiKey;
    this.apiBase = opts.apiBase.replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async dial(body: TelnyxDialRequest): Promise<TelnyxDialResult> {
    const res = await this.fetchImpl(`${this.apiBase}/v2/calls`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        ...body,
        webhook_url_method: body.webhook_url_method ?? "POST",
        stream_codec: body.stream_codec ?? body.stream_bidirectional_codec,
      }),
    });
    const json = (await res.json()) as { data?: TelnyxDialResult; errors?: unknown };
    if (!res.ok || !json.data?.call_control_id) {
      throw new Error(`Telnyx dial failed (${res.status}): ${JSON.stringify(json)}`);
    }
    return json.data;
  }

  async hangup(callControlId: string): Promise<void> {
    const res = await this.fetchImpl(
      `${this.apiBase}/v2/calls/${callControlId}/actions/hangup`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({}),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Telnyx hangup failed (${res.status}): ${text}`);
    }
  }
}
