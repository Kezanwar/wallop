import { NextResponse, type NextRequest } from "next/server";
import { getPooledDb } from "@wallop/db";
import { completeGoogleLogin, grantCredits } from "@wallop/core";
import { googleClient } from "@/lib/google";
import { setSessionCookie, getRequestMeta } from "@/lib/auth";

const SIGNUP_CREDITS = 10;

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");

  if (!code || !state) {
    return NextResponse.redirect(new URL("/login?error=oauth", req.url));
  }

  try {
    const db = getPooledDb();
    const meta = await getRequestMeta();

    const result = await completeGoogleLogin(db, googleClient(), {
      code,
      state,
      expectedClientId: process.env.GOOGLE_CLIENT_ID!,
      ...meta,
    });

    if (result.isNewUser) {
      await grantCredits(db, {
        userId: result.userId,
        amount: SIGNUP_CREDITS,
        reason: "signup_grant",
        idempotencyKey: `signup:${result.userId}`,
      });
    }

    await setSessionCookie(result.token, result.expiresAt);
    return NextResponse.redirect(new URL("/", req.url));
  } catch (err) {
    console.error("Google OAuth failed:", err);
    return NextResponse.redirect(new URL("/login?error=oauth", req.url));
  }
}
