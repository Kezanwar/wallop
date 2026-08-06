import { and, eq, gt, lt } from "drizzle-orm";
import {
  Google,
  generateState,
  generateCodeVerifier,
  decodeIdToken,
} from "arctic";
import { type DbClient, schema } from "@wallop/db";
import { normaliseEmail } from "./crypto";
import { createSession } from "./sessions";

const { users, oauthAccounts, oauthStates } = schema;

const STATE_TTL_MS = 10 * 60 * 1000;
const PROVIDER = "google";

export class OAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthError";
  }
}

export function createGoogleClient(env: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}) {
  return new Google(env.clientId, env.clientSecret, env.redirectUri);
}

/** Step 1 of the dance: build the URL we redirect the user to. */
export async function beginGoogleLogin(
  db: DbClient,
  google: Google,
): Promise<{ url: URL; state: string }> {
  const state = generateState();
  // PKCE: we keep the verifier, Google only ever sees its hash. Stops an
  // intercepted authorization code being redeemed by anyone but us.
  const codeVerifier = generateCodeVerifier();

  await db.insert(oauthStates).values({
    state,
    codeVerifier,
    expiresAt: new Date(Date.now() + STATE_TTL_MS),
  });

  const url = google.createAuthorizationURL(state, codeVerifier, [
    "openid",
    "email",
    "profile",
  ]);

  return { url, state };
}

type GoogleIdTokenClaims = {
  sub: string;
  aud: string | string[];
  iss: string;
  exp: number;
  email?: string;
  email_verified?: boolean;
  given_name?: string;
  family_name?: string;
  picture?: string;
};

/**
 * Step 2: the callback. Exchanges the authorization CODE for tokens using our
 * client secret, server-side.
 *
 * This is the critical difference from the vulnerable pattern of accepting an
 * access token from the client and calling /userinfo with it. That endpoint
 * accepts ANY valid Google token and won't tell you which OAuth app it was
 * issued to — so an attacker with their own Google app can mint a token for a
 * victim and hand it to you. Doing the code exchange ourselves means the token
 * is guaranteed to be ours, and we verify `aud` on top of that.
 */
export async function completeGoogleLogin(
  db: DbClient,
  google: Google,
  params: {
    code: string;
    state: string;
    expectedClientId: string;
    ip?: string;
    userAgent?: string;
  },
): Promise<{
  token: string;
  expiresAt: Date;
  userId: string;
  isNewUser: boolean;
}> {
  const [stateRow] = await db
    .select()
    .from(oauthStates)
    .where(
      and(
        eq(oauthStates.state, params.state),
        gt(oauthStates.expiresAt, new Date()),
      ),
    );

  if (!stateRow) throw new OAuthError("Invalid or expired state");

  // Single use, whatever happens next.
  await db.delete(oauthStates).where(eq(oauthStates.id, stateRow.id));

  const tokens = await google.validateAuthorizationCode(
    params.code,
    stateRow.codeVerifier,
  );

  const claims = decodeIdToken(tokens.idToken()) as GoogleIdTokenClaims;

  // Was this token minted for OUR client? Without this check, a token issued
  // to any other Google app would be accepted.
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(params.expectedClientId)) {
    throw new OAuthError("Token audience mismatch");
  }

  if (
    claims.iss !== "https://accounts.google.com" &&
    claims.iss !== "accounts.google.com"
  ) {
    throw new OAuthError("Unexpected issuer");
  }

  if (!claims.email) throw new OAuthError("No email on Google account");

  // Google returns unverified emails for some Workspace configurations.
  // Linking on an unverified email would let an attacker register a Google
  // account with a victim's address and take over their Wallop account.
  if (!claims.email_verified) throw new OAuthError("Google email not verified");

  const email = normaliseEmail(claims.email);
  const name =
    [claims.given_name, claims.family_name].filter(Boolean).join(" ") || null;

  console.log(name);

  return db.transaction(async (tx) => {
    // Look up by `sub` first — the stable identifier.
    const [existingLink] = await tx
      .select()
      .from(oauthAccounts)
      .where(
        and(
          eq(oauthAccounts.provider, PROVIDER),
          eq(oauthAccounts.providerUserId, claims.sub),
        ),
      );

    let userId: string;
    let isNewUser = false;

    if (existingLink) {
      userId = existingLink.userId;
    } else {
      // No link yet. Match on email — safe because we've confirmed
      // email_verified on Google's side, and our own users are only ever
      // created with a verified email (OTP redemption or this flow).
      const [existingUser] = await tx
        .select()
        .from(users)
        .where(eq(users.email, email));

      if (existingUser) {
        console.log("isExisting", existingUser);
        userId = existingUser.id;
        const updates: { emailVerified?: boolean; name?: string } = {};
        if (!existingUser.emailVerified) updates.emailVerified = true;
        if (!existingUser.name && name) updates.name = name;
        if (Object.keys(updates).length > 0) {
          await tx.update(users).set(updates).where(eq(users.id, userId));
        }
      } else {
        const [created] = await tx
          .insert(users)
          .values({ email, emailVerified: true, name })
          .returning();
        userId = created!.id;
        isNewUser = true;
      }

      await tx.insert(oauthAccounts).values({
        provider: PROVIDER,
        providerUserId: claims.sub,
        userId,
      });
    }

    const { token, expiresAt } = await createSession(
      tx as unknown as DbClient,
      {
        userId,
        ip: params.ip,
        userAgent: params.userAgent,
      },
    );

    return { token, expiresAt, userId, isNewUser };
  });
}

export async function deleteExpiredOAuthStates(db: DbClient): Promise<void> {
  await db.delete(oauthStates).where(lt(oauthStates.expiresAt, new Date()));
}
