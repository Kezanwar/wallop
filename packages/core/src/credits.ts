import { eq, sql } from "drizzle-orm";
import { type DbClient, type DbTransaction, schema } from "@wallop/db";

const { users, creditTransactions } = schema;

export type GrantReason =
  | "signup_grant"
  | "monthly_grant"
  | "purchase_grant"
  | "generation_refund"
  | "order_refund"
  | "admin_adjustment";

export type SpendReason = "generation_spend";

/**
 * Mutations accept a transaction as well as the pool, so a credit change can
 * commit atomically with other writes (e.g. spend + design + job enqueue).
 * Inside a transaction, db.transaction() opens a SAVEPOINT — the FOR UPDATE
 * lock is still held until the OUTER transaction ends.
 */
type Db = DbClient | DbTransaction;

export class InsufficientCreditsError extends Error {
  constructor(
    readonly userId: string,
    readonly needed: number,
    readonly available: number,
  ) {
    super(`Insufficient credits: needed ${needed}, have ${available}`);
    this.name = "InsufficientCreditsError";
  }
}

export class UserNotFoundError extends Error {
  constructor(readonly userId: string) {
    super(`User not found: ${userId}`);
    this.name = "UserNotFoundError";
  }
}

async function balanceIn(
  tx: DbTransaction | DbClient,
  userId: string,
): Promise<number> {
  const [row] = await tx
    .select({
      balance: sql<number>`coalesce(sum(${creditTransactions.amount}), 0)::int`,
    })
    .from(creditTransactions)
    .where(eq(creditTransactions.userId, userId));
  return row?.balance ?? 0;
}

export async function getBalance(
  db: Db,
  userId: string,
): Promise<number> {
  return balanceIn(db, userId);
}

export async function grantCredits(
  db: Db,
  params: {
    userId: string;
    amount: number;
    reason: GrantReason;
    refId?: string;
    idempotencyKey?: string;
  },
): Promise<{ applied: boolean; balanceAfter: number }> {
  const { userId, amount, reason, refId, idempotencyKey } = params;
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error("grantCredits: amount must be a positive integer");
  }

  return db.transaction(async (tx) => {
    const [user] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .for("update");
    if (!user) throw new UserNotFoundError(userId);

    const inserted = await tx
      .insert(creditTransactions)
      .values({ userId, amount, reason, refId, idempotencyKey })
      .onConflictDoNothing({ target: creditTransactions.idempotencyKey })
      .returning({ id: creditTransactions.id });

    // Empty means the idempotency key already existed — a safe no-op.
    return {
      applied: inserted.length > 0,
      balanceAfter: await balanceIn(tx, userId),
    };
  });
}

export async function spendCredits(
  db: Db,
  params: {
    userId: string;
    amount: number;
    reason: SpendReason;
    refId?: string;
    /**
     * Makes the spend safe to submit twice: a repeat with the same key is a
     * no-op (`applied: false`), never a second charge — and never an
     * InsufficientCreditsError just because the first one used the last credit.
     */
    idempotencyKey?: string;
  },
): Promise<{
  applied: boolean;
  /** Null when the key had already been spent (applied: false). */
  transactionId: string | null;
  balanceAfter: number;
}> {
  const { userId, amount, reason, refId, idempotencyKey } = params;
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error("spendCredits: amount must be a positive integer");
  }

  return db.transaction(async (tx) => {
    // FOR UPDATE locks the user row, serialising all credit mutations for
    // this user. Without it, two concurrent spends both read the same
    // balance, both pass the check, and the balance goes negative.
    const [user] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .for("update");
    if (!user) throw new UserNotFoundError(userId);

    // A replay must be answered BEFORE the balance check: if the original
    // spend took the last credit, the replay would otherwise wrongly fail
    // with InsufficientCreditsError. Reading here is race-free because every
    // spend for this user holds the row lock above; the unique constraint
    // and onConflictDoNothing below are the backstop regardless.
    if (idempotencyKey) {
      const [existing] = await tx
        .select({ id: creditTransactions.id })
        .from(creditTransactions)
        .where(eq(creditTransactions.idempotencyKey, idempotencyKey));
      if (existing) {
        return {
          applied: false,
          transactionId: null,
          balanceAfter: await balanceIn(tx, userId),
        };
      }
    }

    const balance = await balanceIn(tx, userId);
    if (balance < amount) {
      throw new InsufficientCreditsError(userId, amount, balance);
    }

    const inserted = await tx
      .insert(creditTransactions)
      .values({ userId, amount: -amount, reason, refId, idempotencyKey })
      .onConflictDoNothing({ target: creditTransactions.idempotencyKey })
      .returning({ id: creditTransactions.id });

    const row = inserted[0];
    if (!row) {
      // Key taken between the check and the insert — only possible for a
      // key another user's transaction wrote, since this user's are locked.
      return { applied: false, transactionId: null, balanceAfter: balance };
    }
    return { applied: true, transactionId: row.id, balanceAfter: balance - amount };
  });
}

/** Refund a failed generation. Idempotent on refId so job retries are safe. */
export async function refundGeneration(
  db: Db,
  params: { userId: string; amount: number; refId: string },
) {
  return grantCredits(db, {
    ...params,
    reason: "generation_refund",
    idempotencyKey: `generation_refund:${params.refId}`,
  });
}
