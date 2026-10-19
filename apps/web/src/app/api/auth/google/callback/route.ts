import { NextResponse, type NextRequest } from "next/server";
import { getPooledDb } from "@wallop/db";
import { completeGoogleLogin, grantSignupCredits } from "@wallop/core";
import { googleClient } from "@/lib/google";
import { setSessionCookie, getRequestMeta } from "@/lib/auth";

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
      // Keyed signup:<userId> inside core — a retried callback can't double-grant.
      await grantSignupCredits(db, { userId: result.userId });
    }

    await setSessionCookie(result.token, result.expiresAt);
    return NextResponse.redirect(new URL("/generate", req.url));
  } catch (err) {
    console.error("Google OAuth failed:", err);
    return NextResponse.redirect(new URL("/login?error=oauth", req.url));
  }
}
