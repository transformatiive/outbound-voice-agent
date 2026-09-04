import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyTelnyxSignature } from "../src/telnyx/signature.js";

function ed25519KeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  const rawPublic = Buffer.from(spki.subarray(spki.length - 32));
  return { publicKeyB64: rawPublic.toString("base64"), privateKey };
}

describe("Telnyx webhook signature", () => {
  it("accepts a valid Ed25519 signature over timestamp|body", () => {
    const { publicKeyB64, privateKey } = ed25519KeyPair();
    const body = Buffer.from(JSON.stringify({ data: { event_type: "call.answered" } }));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signed = Buffer.concat([Buffer.from(timestamp), Buffer.from("|"), body]);
    const signature = sign(null, signed, privateKey).toString("base64");
    expect(verifyTelnyxSignature(body, timestamp, signature, publicKeyB64)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const { publicKeyB64, privateKey } = ed25519KeyPair();
    const body = Buffer.from('{"ok":true}');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signed = Buffer.concat([Buffer.from(timestamp), Buffer.from("|"), body]);
    const signature = sign(null, signed, privateKey).toString("base64");
    expect(verifyTelnyxSignature(Buffer.from('{"ok":false}'), timestamp, signature, publicKeyB64)).toBe(
      false,
    );
  });
});
