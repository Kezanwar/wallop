"use server";

import { redirect } from "next/navigation";
import { getPooledDb } from "@wallop/db";
import {
  requestOtp,
  redeemOtp,
  revokeSession,
  grantCredits,
  RateLimitedError,
  setUserName,
} from "@wallop/core";
import {
  SESSION_COOKIE,
  setSessionCookie,
  clearSessionCookie,
  setOtpNonceCookie,
  getOtpNonce,
  clearOtpNonce,
  getRequestMeta,
  requireSession,
} from "@/lib/auth";
import { cookies } from "next/headers";

const SIGNUP_CREDITS = 10;

export type AuthState = { error?: string; sent?: boolean; email?: string };

export async function requestCodeAction(
  _prev: AuthState | null,
  formData: FormData,
): Promise<AuthState> {
  const email = String(formData.get("email") ?? "");
  if (!email.includes("@")) return { error: "Enter a valid email address" };

  try {
    const { code, nonce } = await requestOtp(getPooledDb(), { email });
    await setOtpNonceCookie(nonce);

    // TODO: send via Resend. Logged to console for local dev.
    console.log(`\n  OTP for ${email}: ${code}\n`);
  } catch (err) {
    if (err instanceof RateLimitedError) {
      return { error: "Too many codes requested. Try again later." };
    }
    throw err;
  }

  // Deliberately identical whether or not the account exists.
  return { sent: true, email };
}

export async function verifyCodeAction(
  _prev: AuthState | null,
  formData: FormData,
): Promise<AuthState> {
  const email = String(formData.get("email") ?? "");
  const code = String(formData.get("code") ?? "");

  const nonce = await getOtpNonce();
  if (!nonce)
    return { error: "Your code has expired. Request a new one.", email };

  const db = getPooledDb();
  const meta = await getRequestMeta();
  const result = await redeemOtp(db, { email, code, nonce, ...meta });

  if (!result.ok) {
    const message =
      result.reason === "expired"
        ? "That code has expired."
        : "That code isn't right.";
    return { error: message, sent: true, email };
  }

  if (result.isNewUser) {
    await grantCredits(db, {
      userId: result.userId,
      amount: SIGNUP_CREDITS,
      reason: "signup_grant",
      idempotencyKey: `signup:${result.userId}`,
    });
  }

  await setSessionCookie(result.token, result.expiresAt);
  await clearOtpNonce();
  redirect(result.isNewUser ? "/welcome" : "/");
}

export async function logoutAction() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token) await revokeSession(getPooledDb(), token);
  await clearSessionCookie();
  redirect("/");
}

export async function setNameAction(formData: FormData) {
  const session = await requireSession();
  const name = String(formData.get("name") ?? "");
  if (name.trim()) {
    await setUserName(getPooledDb(), { userId: session.userId, name });
  }
  redirect("/");
}
