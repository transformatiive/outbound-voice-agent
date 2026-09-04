import { createPublicKey, verify } from "node:crypto";

const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const MAX_AGE_SECONDS = 300;

export function verifyTelnyxSignature(
  rawBody: Buffer,
  timestamp: string,
  signatureB64: string,
  publicKeyB64: string,
): boolean {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const age = Math.abs(Date.now() / 1000 - ts);
  if (age > MAX_AGE_SECONDS) return false;

  let rawPublic: Buffer;
  try {
    rawPublic = Buffer.from(publicKeyB64, "base64");
  } catch {
    return false;
  }
  if (rawPublic.length !== 32) return false;

  let signature: Buffer;
  try {
    signature = Buffer.from(signatureB64, "base64");
  } catch {
    return false;
  }

  try {
    const key = createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, rawPublic]),
      format: "der",
      type: "spki",
    });
    const signed = Buffer.concat([Buffer.from(timestamp), Buffer.from("|"), rawBody]);
    return verify(null, signed, key, signature);
  } catch {
    return false;
  }
}
