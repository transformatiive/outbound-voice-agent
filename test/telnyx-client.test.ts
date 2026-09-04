import { describe, expect, it, vi } from "vitest";
import { TelnyxHttpClient } from "../src/telnyx/client.js";

describe("Telnyx HTTP client", () => {
  it("POSTs /v2/calls with Call Control connection and streaming fields", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: {
            call_control_id: "v2:abc",
            call_leg_id: "leg",
            call_session_id: "sess",
            is_alive: false,
            record_type: "call",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new TelnyxHttpClient({
      apiKey: "KEY",
      apiBase: "https://api.telnyx.com",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const result = await client.dial({
      connection_id: "3041732714274227469",
      to: "+351912345678",
      from: "+351210210260",
      stream_url: "wss://example/media-stream?callId=1&token=t",
      stream_track: "inbound_track",
      stream_bidirectional_mode: "rtp",
      stream_bidirectional_codec: "PCMU",
      stream_bidirectional_target_legs: "self",
      webhook_url: "https://example/webhooks/telnyx",
      client_state: "Y2FsbC0x",
    });

    expect(result.call_control_id).toBe("v2:abc");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telnyx.com/v2/calls",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer KEY",
          "Content-Type": "application/json",
        }),
      }),
    );
  });

  it("hangs up via Call Control actions/hangup", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ data: { result: "ok" } }), { status: 200 }),
    );
    const client = new TelnyxHttpClient({
      apiKey: "KEY",
      apiBase: "https://api.telnyx.com",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await client.hangup("v2:abc");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telnyx.com/v2/calls/v2:abc/actions/hangup",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
