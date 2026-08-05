import { and, eq, gt, lt } from "drizzle-orm";
import { type DbClient, schema } from "@wallop/db";
import { generateToken, hashToken } from "./crypto";

const { sessions, users } = schema;

export const SESSION_DURATION_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

export type SessionUser = { userId: string; email: string; sessionId: string };

export async function createSession(
  db: DbClient,
  params: { userId: string; ip?: string; userAgent?: string },
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

  await db.insert(sessions).values({
    userId: params.userId,
    tokenHash: hashToken(token),
    expiresAt,
    ip: params.ip,
    userAgent: params.userAgent,
  });

  // Returned once, never stored raw. Caller puts it in an httpOnly cookie.
  return { token, expiresAt };
}

/**
 * Validate a session token. Slides the expiry when past the halfway point,
 * so active users are never logged out but abandoned sessions still die.
 */
export async function validateSession(
  db: DbClient,
  token: string,
): Promise<SessionUser | null> {
  const [row] = await db
    .select({
      sessionId: sessions.id,
      userId: users.id,
      email: users.email,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(
      and(
        eq(sessions.tokenHash, hashToken(token)),
        gt(sessions.expiresAt, new Date()),
      ),
    );

  if (!row) return null;

  const halfway = new Date(Date.now() + SESSION_DURATION_MS / 2);
  if (row.expiresAt < halfway) {
    await db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() + SESSION_DURATION_MS) })
      .where(eq(sessions.id, row.sessionId));
  }

  return { userId: row.userId, email: row.email, sessionId: row.sessionId };
}

export async function revokeSession(
  db: DbClient,
  token: string,
): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}

/** "Log out everywhere" — also what you call after a suspected compromise. */
export async function revokeAllSessions(
  db: DbClient,
  userId: string,
): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

export async function deleteExpiredSessions(db: DbClient): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
}
