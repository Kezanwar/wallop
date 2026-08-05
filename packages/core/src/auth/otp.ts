import { and, count, desc, eq, gt, isNull } from "drizzle-orm";
import { type DbClient, schema } from "@wallop/db";
import {
  generateOtpCode,
  generateToken,
  hashToken,
  safeEqual,
  normaliseEmail,
} from "./crypto";
import { createSession } from "./sessions";

const { otpCodes, users } = schema;

export const OTP_TTL_MS = 10 * 60 * 1000;
export const MAX_ATTEMPTS = 5;
const MAX_CODES_PER_HOUR = 5;

export class RateLimitedError extends Error {
  constructor() {
    super("Too many codes requested. Try again later.");
    this.name = "RateLimitedError";
  }
}

export type RedeemResult =
  | {
      ok: true;
      token: string;
      expiresAt: Date;
      userId: string;
      isNewUser: boolean;
    }
  | { ok: false; reason: "invalid" | "expired" | "too_many_attempts" };

/**
 * Always behaves identically whether or not the account exists — revealing
 * that would be a user-enumeration oracle. Caller shows the same message
 * regardless: "If an account exists, we've sent a code."
 */
export async function requestOtp(
  db: DbClient,
  params: { email: string },
): Promise<{ code: string; nonce: string; identifier: string }> {
  const identifier = normaliseEmail(params.email);
  const since = new Date(Date.now() - 60 * 60 * 1000);

  const [countRow] = await db
    .select({ recent: count() })
    .from(otpCodes)
    .where(
      and(eq(otpCodes.identifier, identifier), gt(otpCodes.createdAt, since)),
    );

  if ((countRow?.recent ?? 0) >= MAX_CODES_PER_HOUR)
    throw new RateLimitedError();

  // Invalidate any outstanding codes — only the newest should ever work.
  await db
    .update(otpCodes)
    .set({ consumedAt: new Date() })
    .where(
      and(eq(otpCodes.identifier, identifier), isNull(otpCodes.consumedAt)),
    );

  const code = generateOtpCode();
  const nonce = generateToken();

  await db.insert(otpCodes).values({
    identifier,
    identifierType: "email",
    codeHash: hashToken(code),
    nonce,
    expiresAt: new Date(Date.now() + OTP_TTL_MS),
  });

  // Returned to the caller, which emails the code and cookies the nonce.
  return { code, nonce, identifier };
}

export async function redeemOtp(
  db: DbClient,
  params: {
    email: string;
    code: string;
    nonce: string;
    ip?: string;
    userAgent?: string;
  },
): Promise<RedeemResult> {
  const identifier = normaliseEmail(params.email);

  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(otpCodes)
      .where(
        and(eq(otpCodes.identifier, identifier), isNull(otpCodes.consumedAt)),
      )
      .orderBy(desc(otpCodes.createdAt))
      .limit(1)
      .for("update");

    if (!row) return { ok: false, reason: "invalid" } as const;
    if (row.expiresAt < new Date())
      return { ok: false, reason: "expired" } as const;
    if (row.attempts >= MAX_ATTEMPTS) {
      return { ok: false, reason: "too_many_attempts" } as const;
    }

    const codeOk = safeEqual(row.codeHash, hashToken(params.code));
    const nonceOk = safeEqual(row.nonce, params.nonce);

    if (!codeOk || !nonceOk) {
      const attempts = row.attempts + 1;
      await tx
        .update(otpCodes)
        .set({
          attempts,
          // Burn the code once the attempt budget is spent. Without this,
          // 6 digits is a million guesses — trivially brute-forced.
          consumedAt: attempts >= MAX_ATTEMPTS ? new Date() : null,
        })
        .where(eq(otpCodes.id, row.id));

      return {
        ok: false,
        reason: attempts >= MAX_ATTEMPTS ? "too_many_attempts" : "invalid",
      } as const;
    }

    await tx
      .update(otpCodes)
      .set({ consumedAt: new Date() })
      .where(eq(otpCodes.id, row.id));

    // Only now do we touch the user record.
    let [user] = await tx
      .select()
      .from(users)
      .where(eq(users.email, identifier));
    let isNewUser = false;

    if (!user) {
      [user] = await tx
        .insert(users)
        .values({ email: identifier, emailVerified: true })
        .returning();
      isNewUser = true;
    } else if (!user.emailVerified) {
      await tx
        .update(users)
        .set({ emailVerified: true })
        .where(eq(users.id, user.id));
    }

    const { token, expiresAt } = await createSession(
      tx as unknown as DbClient,
      {
        userId: user!.id,
        ip: params.ip,
        userAgent: params.userAgent,
      },
    );

    return { ok: true, token, expiresAt, userId: user!.id, isNewUser } as const;
  });
}
