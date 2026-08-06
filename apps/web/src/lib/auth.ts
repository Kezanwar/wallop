import { cookies, headers } from "next/headers";
import { cache } from "react";
import { getPooledDb } from "@wallop/db";
import { validateSession, type SessionUser } from "@wallop/core";

export const SESSION_COOKIE = "wallop_session";
export const OTP_NONCE_COOKIE = "wallop_otp_nonce";

const secure = process.env.NODE_ENV === "production";

/**
 * Wrapped in React's cache() so multiple Server Components on one page
 * share a single lookup rather than each hitting the database.
 */
export const getSession = cache(async (): Promise<SessionUser | null> => {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return validateSession(getPooledDb(), token);
});

export async function requireSession(): Promise<SessionUser> {
  const session = await getSession();
  if (!session) throw new Error("Unauthorized");
  return session;
}

export async function setSessionCookie(token: string, expiresAt: Date) {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true, // JS can't read it — XSS can't steal it
    secure, // HTTPS only in production
    sameSite: "lax", // withheld on cross-site POSTs — CSRF defence
    path: "/",
    expires: expiresAt,
  });
}

export async function clearSessionCookie() {
  (await cookies()).delete(SESSION_COOKIE);
}

export async function setOtpNonceCookie(nonce: string) {
  const store = await cookies();
  store.set(OTP_NONCE_COOKIE, nonce, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: 600, // matches the OTP TTL
  });
}

export async function getOtpNonce(): Promise<string | null> {
  return (await cookies()).get(OTP_NONCE_COOKIE)?.value ?? null;
}

export async function clearOtpNonce() {
  (await cookies()).delete(OTP_NONCE_COOKIE);
}

export async function getRequestMeta() {
  const h = await headers();
  return {
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim(),
    userAgent: h.get("user-agent") ?? undefined,
  };
}
