import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function bearerMatches(header: string | undefined, expected: string): boolean {
  if (!expected) return false;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  return timingSafeEqual(digest(token), digest(expected));
}

export function requireApiKey(apiKey: string): RequestHandler {
  return (req, res, next) => {
    if (!bearerMatches(req.get("authorization"), apiKey)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}
