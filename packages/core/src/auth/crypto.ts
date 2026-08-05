import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

/** 32 random bytes, base64url. This is what goes in the cookie. */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** 6-digit code, uniformly distributed (no modulo bias). */
export function generateOtpCode(): string {
  let n: number;
  do {
    n = randomBytes(4).readUInt32BE(0);
  } while (n >= 4294967295 - (4294967295 % 1000000));
  return String(n % 1000000).padStart(6, "0");
}

/** Constant-time compare — never leak timing info about a credential. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}
