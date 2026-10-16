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

/**
 * REQUIRED on every spend and grant. It must identify the INTENT — the one
 * thing the user/system meant to do once — so that every retry of that
 * intent (double-click, network retry, job retry, webhook redelivery)
 * carries the same key and the ledger applies it exactly once.
 *
 * Good: `generation_spend:<userId>:<requestId>` (requestId minted ONCE by the
 * client per intended generation), `signup:<userId>`, a Stripe event id.
 *
 * NEVER random at the call site. `randomUUID()` compiles and protects
 * nothing: each retry gets a fresh key and is charged/granted again. Making
 * the key required forces the decision; it can't make the decision correct —
 * that's on review. (A random id minted once where the intent originates and
 * reused on every retry, like requestId, is fine: it IS the intent's id.)
 *
 * Keys share one global namespace (a unique column), so prefix them by kind.
 */
export type IdempotencyKey = string;

/** What a key commits to. A replay must match all of it, or it throws. */
type LedgerTerms = {
  userId: string;
  /** Signed: grants positive, spends negative. */
  amount: number;
  reason: string;
  refId: string | null;
};

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

/**
 * An idempotency key was reused for a DIFFERENT entry (other user, amount,
 * reason or refId). Never a silent no-op: the caller would believe it had
 * charged/granted something it hadn't. Same idea as Stripe rejecting an
 * idempotency key reused with different parameters.
 */
export class IdempotencyKeyConflictError extends Error {
  constructor(
    readonly idempotencyKey: string,
    readonly existing: LedgerTerms,
    readonly attempted: LedgerTerms,
  ) {
    super(
      `Idempotency key "${idempotencyKey}" was already used for different terms: ` +
        `existing ${JSON.stringify(existing)}, attempted ${JSON.stringify(attempted)}`,
    );
    this.name = "IdempotencyKeyConflictError";
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

function assertKey(key: string, fn: string): void {
  if (typeof key !== "string" || key.trim() === "") {
    throw new Error(`${fn}: idempotencyKey is required and must be non-empty`);
  }
}

async function lockUser(tx: DbTransaction, userId: string): Promise<void> {
  // FOR UPDATE locks the user row, serialising all credit mutations for
  // this user. Without it, two concurrent spends both read the same
  // balance, both pass the check, and the balance goes negative.
  const [user] = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .for("update");
  if (!user) throw new UserNotFoundError(userId);
}

/**
 * If `key` was already used: return the original transaction id when the
 * terms match (an idempotent replay), THROW when they don't. Null when the
 * key is unused.
 */
async function findReplay(
  tx: DbTransaction,
  key: string,
  attempted: LedgerTerms,
): Promise<string | null> {
  const [existing] = await tx
    .select({
      id: creditTransactions.id,
      userId: creditTransactions.userId,
      amount: creditTransactions.amount,
      reason: creditTransactions.reason,
      refId: creditTransactions.refId,
    })
    .from(creditTransactions)
    .where(eq(creditTransactions.idempotencyKey, key));
  if (!existing) return null;

  const existingTerms: LedgerTerms = {
    userId: existing.userId,
    amount: existing.amount,
    reason: existing.reason,
    refId: existing.refId ?? null,
  };
  if (
    existingTerms.userId !== attempted.userId ||
    existingTerms.amount !== attempted.amount ||
    existingTerms.reason !== attempted.reason ||
    existingTerms.refId !== attempted.refId
  ) {
    throw new IdempotencyKeyConflictError(key, existingTerms, attempted);
  }
  return existing.id;
}

/**
 * Insert the entry, with ON CONFLICT DO NOTHING on the key as the backstop.
 * The caller has already checked findReplay under the user lock, so a
 * conflict here can only come from ANOTHER user's concurrent transaction
 * using the same key (this user's are serialised by the lock): resolve it
 * through findReplay, which throws on the mismatched terms.
 */
async function insertOnce(
  tx: DbTransaction,
  key: string,
  terms: LedgerTerms,
): Promise<{ applied: boolean; transactionId: string }> {
  const [row] = await tx
    .insert(creditTransactions)
    .values({ ...terms, refId: terms.refId ?? undefined, idempotencyKey: key })
    .onConflictDoNothing({ target: creditTransactions.idempotencyKey })
    .returning({ id: creditTransactions.id });
  if (row) return { applied: true, transactionId: row.id };

  const original = await findReplay(tx, key, terms);
  if (!original) {
    throw new Error(`Idempotency key "${key}" conflicted but no row was found`);
  }
  return { applied: false, transactionId: original };
}

/**
 * Add credits. Idempotent on `idempotencyKey` (required — see IdempotencyKey):
 * a replay with the same terms is a no-op returning the original transaction
 * (`applied: false`); a replay with different terms throws
 * IdempotencyKeyConflictError.
 *
 * Prefer the per-reason wrappers below — they build the key so callers can't
 * get it wrong.
 */
export async function grantCredits(
  db: Db,
  params: {
    userId: string;
    amount: number;
    reason: GrantReason;
    refId?: string;
    /** Must identify the intent — never random at the call site. See IdempotencyKey. */
    idempotencyKey: IdempotencyKey;
  },
): Promise<{ applied: boolean; transactionId: string; balanceAfter: number }> {
  const { userId, amount, reason, refId, idempotencyKey } = params;
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error("grantCredits: amount must be a positive integer");
  }
  assertKey(idempotencyKey, "grantCredits");
  const terms: LedgerTerms = { userId, amount, reason, refId: refId ?? null };

  return db.transaction(async (tx) => {
    await lockUser(tx, userId);

    const replay = await findReplay(tx, idempotencyKey, terms);
    if (replay) {
      return {
        applied: false,
        transactionId: replay,
        balanceAfter: await balanceIn(tx, userId),
      };
    }

    const result = await insertOnce(tx, idempotencyKey, terms);
    return { ...result, balanceAfter: await balanceIn(tx, userId) };
  });
}

/**
 * Take credits. Idempotent on `idempotencyKey` (required — see IdempotencyKey):
 * a replay with the same terms is a no-op returning the original transaction
 * (`applied: false`) — never a second charge, and never an
 * InsufficientCreditsError just because the original used the last credit.
 * A replay with different terms throws IdempotencyKeyConflictError.
 */
export async function spendCredits(
  db: Db,
  params: {
    userId: string;
    amount: number;
    reason: SpendReason;
    refId?: string;
    /** Must identify the intent — never random at the call site. See IdempotencyKey. */
    idempotencyKey: IdempotencyKey;
  },
): Promise<{ applied: boolean; transactionId: string; balanceAfter: number }> {
  const { userId, amount, reason, refId, idempotencyKey } = params;
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error("spendCredits: amount must be a positive integer");
  }
  assertKey(idempotencyKey, "spendCredits");
  const terms: LedgerTerms = { userId, amount: -amount, reason, refId: refId ?? null };

  return db.transaction(async (tx) => {
    await lockUser(tx, userId);

    // A replay is answered BEFORE the balance check: if the original spend
    // took the last credit, the replay would otherwise wrongly fail with
    // InsufficientCreditsError. Race-free: every mutation for this user holds
    // the lock above, and insertOnce's ON CONFLICT is the backstop.
    const replay = await findReplay(tx, idempotencyKey, terms);
    if (replay) {
      return {
        applied: false,
        transactionId: replay,
        balanceAfter: await balanceIn(tx, userId),
      };
    }

    const balance = await balanceIn(tx, userId);
    if (balance < amount) {
      throw new InsufficientCreditsError(userId, amount, balance);
    }

    const result = await insertOnce(tx, idempotencyKey, terms);
    return {
      ...result,
      balanceAfter: result.applied ? balance - amount : balance,
    };
  });
}

// --- Per-reason grants -------------------------------------------------------
// Fixed-scheme reasons build their key here, so no caller can get it wrong.
// Event-driven reasons take the event's id from the caller and namespace it.

/** Credits every new account starts with. */
export const SIGNUP_GRANT_CREDITS = 10;

/** Once per user, ever. Key: `signup:<userId>`. */
export async function grantSignupCredits(db: Db, params: { userId: string }) {
  return grantCredits(db, {
    userId: params.userId,
    amount: SIGNUP_GRANT_CREDITS,
    reason: "signup_grant",
    idempotencyKey: `signup:${params.userId}`,
  });
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Once per user per month. Key: `monthly:<userId>:<yyyy-mm>`.
 *
 * `month` is REQUIRED, with no "now" default: the caller (the monthly job)
 * must say which period it is granting FOR. Deriving it from the clock would
 * let a run at 23:59:59 on the 31st and its retry at 00:00:01 land in
 * different months — two keys, a double grant.
 */
export async function grantMonthlyCredits(
  db: Db,
  params: { userId: string; amount: number; month: string },
) {
  if (!MONTH_RE.test(params.month)) {
    throw new Error(`grantMonthlyCredits: month must be "yyyy-mm", got "${params.month}"`);
  }
  return grantCredits(db, {
    userId: params.userId,
    amount: params.amount,
    reason: "monthly_grant",
    idempotencyKey: `monthly:${params.userId}:${params.month}`,
  });
}

/**
 * A credit-pack purchase. Keyed on the Stripe event id, so a webhook
 * redelivery of the same event grants once. Key: `purchase:<stripeEventId>`.
 */
export async function grantPurchaseCredits(
  db: Db,
  params: { userId: string; amount: number; stripeEventId: string },
) {
  assertKey(params.stripeEventId, "grantPurchaseCredits (stripeEventId)");
  return grantCredits(db, {
    userId: params.userId,
    amount: params.amount,
    reason: "purchase_grant",
    idempotencyKey: `purchase:${params.stripeEventId}`,
  });
}

/**
 * A manual adjustment. `adminActionId` identifies the admin's action (e.g. a
 * support ticket or an audit-log row) — minted once when the action is
 * created, reused if it's resubmitted. Key: `admin:<adminActionId>`.
 */
export async function grantAdminAdjustment(
  db: Db,
  params: { userId: string; amount: number; adminActionId: string },
) {
  assertKey(params.adminActionId, "grantAdminAdjustment (adminActionId)");
  return grantCredits(db, {
    userId: params.userId,
    amount: params.amount,
    reason: "admin_adjustment",
    idempotencyKey: `admin:${params.adminActionId}`,
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
