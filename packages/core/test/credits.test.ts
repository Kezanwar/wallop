import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import { schema } from "@wallop/db";
import {
  getBalance,
  grantCredits,
  spendCredits,
  refundGeneration,
  grantSignupCredits,
  grantMonthlyCredits,
  grantPurchaseCredits,
  grantAdminAdjustment,
  InsufficientCreditsError,
  IdempotencyKeyConflictError,
  SIGNUP_GRANT_CREDITS,
} from "../src/credits";

const pool = new Pool({ connectionString: process.env.DATABASE_URL_TEST });
const db = drizzle(pool, { schema }) as never as Parameters<
  typeof getBalance
>[0];

let userId: string;

beforeEach(async () => {
  await pool.query("truncate table credit_transactions, users cascade");
  const res = await pool.query(
    "insert into users (id, email) values (gen_random_uuid(), $1) returning id",
    [`test-${Date.now()}-${Math.random()}@example.com`],
  );
  userId = res.rows[0].id;
});

afterAll(() => pool.end());

describe("credit ledger", () => {
  /**
   * SUM() over zero rows returns NULL in SQL, not 0. Without the coalesce in
   * balanceIn(), a brand-new user's balance would be null — and `null < 1`
   * evaluates to null, not true, so the overspend guard would silently pass.
   *
   * IRL: someone signs up, hits generate, and the balance check does nothing.
   */
  it("starts at zero", async () => {
    expect(await getBalance(db, userId)).toBe(0);
  });

  /**
   * The basic loop: a grant lands as a positive row, a spend as a negative one,
   * and the balance is their sum.
   *
   * IRL: every single generation a user makes.
   */
  it("grants and spends", async () => {
    await grantCredits(db, {
      userId,
      amount: 10,
      reason: "signup_grant",
      idempotencyKey: "test:grant",
    });
    expect(await getBalance(db, userId)).toBe(10);

    await spendCredits(db, {
      userId,
      amount: 3,
      reason: "generation_spend",
      idempotencyKey: "test:spend",
    });
    expect(await getBalance(db, userId)).toBe(7);
  });

  /**
   * Balance of 2, tries to spend 3, rejected — and crucially the balance is
   * unchanged afterwards, i.e. the transaction rolled back cleanly.
   *
   * IRL: a user out of credits hits generate. We must refuse BEFORE calling
   * fal, because that call costs us real money.
   */
  it("refuses to overspend", async () => {
    await grantCredits(db, {
      userId,
      amount: 2,
      reason: "signup_grant",
      idempotencyKey: "test:grant",
    });
    await expect(
      spendCredits(db, {
        userId,
        amount: 3,
        reason: "generation_spend",
        idempotencyKey: "test:spend",
      }),
    ).rejects.toThrow(InsufficientCreditsError);
    expect(await getBalance(db, userId)).toBe(2);
  });

  /**
   * Separate from "refuses to overspend" because the boundary at exactly zero
   * is where off-by-one errors live (>= vs >).
   *
   * IRL: free signup credits exhausted; the next generate must be refused.
   */
  it("never goes negative", async () => {
    await expect(
      spendCredits(db, {
        userId,
        amount: 1,
        reason: "generation_spend",
        idempotencyKey: "test:spend",
      }),
    ).rejects.toThrow(InsufficientCreditsError);
    expect(await getBalance(db, userId)).toBe(0);
  });

  /**
   * THE important one. This is what a `credits INT` counter column gets wrong.
   * Balance of 1, two simultaneous spends, exactly one must win.
   *
   * IRL: user double-clicks generate, or has two tabs open.
   *
   * NOTE: this test can pass even WITHOUT the FOR UPDATE lock — the race window
   * is sub-millisecond and Node's event loop often serialises the two calls by
   * luck. That's precisely why the next test exists.
   *
   * DISTINCT keys on purpose: two different intents racing for one credit is
   * what exercises the lock. A shared key would turn this into an
   * idempotency test (one spend, by key) — a different property.
   */
  it("does not double-spend under concurrency", async () => {
    await grantCredits(db, {
      userId,
      amount: 1,
      reason: "signup_grant",
      idempotencyKey: "test:grant",
    });

    const results = await Promise.allSettled([
      spendCredits(db, {
        userId,
        amount: 1,
        reason: "generation_spend",
        idempotencyKey: "test:spend:a",
      }),
      spendCredits(db, {
        userId,
        amount: 1,
        reason: "generation_spend",
        idempotencyKey: "test:spend:b",
      }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await getBalance(db, userId)).toBe(0);
  });

  /**
   * Volume forces the race to actually occur. 20 parallel attempts against a
   * balance of 5 — exactly 5 succeed, and the balance lands on 0, never below.
   *
   * IRL: this is the test that catches a missing FOR UPDATE. Comment out
   * `.for("update")` in spendCredits and watch this one go red while the
   * two-way test above stays green. A race condition that passes your test is
   * still a bug — volume and repetition are what expose it.
   *
   * 20 DISTINCT keys: 20 different intents racing on one balance — that's
   * what the lock serialises. A shared key would collapse them to ONE spend
   * via idempotency, so "exactly 5 succeed" would fail; do NOT "fix" that by
   * weakening the assertions — it would stop testing the lock.
   */
  it("handles many concurrent spends correctly", async () => {
    await grantCredits(db, {
      userId,
      amount: 5,
      reason: "signup_grant",
      idempotencyKey: "test:grant",
    });

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        spendCredits(db, {
          userId,
          amount: 1,
          reason: "generation_spend",
          idempotencyKey: `test:spend:${i}`,
        }),
      ),
    );

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    expect(await getBalance(db, userId)).toBe(0);
  });

  /**
   * Spends take the same idempotency key mechanism as grants. A replay is a
   * no-op — one ledger row, one charge.
   *
   * IRL: the generate button double-submitted with the same requestId.
   */
  it("is idempotent on spends with a key", async () => {
    await grantCredits(db, {
      userId,
      amount: 5,
      reason: "signup_grant",
      idempotencyKey: "test:grant",
    });
    const key = "generation_spend:test:1";

    const first = await spendCredits(db, {
      userId,
      amount: 1,
      reason: "generation_spend",
      idempotencyKey: key,
    });
    const second = await spendCredits(db, {
      userId,
      amount: 1,
      reason: "generation_spend",
      idempotencyKey: key,
    });

    expect(first).toMatchObject({ applied: true, balanceAfter: 4 });
    expect(first.transactionId).toBeTruthy();
    // A replay returns the ORIGINAL transaction, so the caller can still link to it.
    expect(second).toEqual({
      applied: false,
      transactionId: first.transactionId,
      balanceAfter: 4,
    });
    expect(await getBalance(db, userId)).toBe(4);
  });

  /**
   * The replay is answered BEFORE the balance check. If the original spend
   * took the last credit, the replay must be a no-op — not an
   * InsufficientCreditsError that the caller would surface as "out of credits"
   * for something they already paid for.
   */
  it("a spend replay succeeds as a no-op even at zero balance", async () => {
    await grantCredits(db, {
      userId,
      amount: 1,
      reason: "signup_grant",
      idempotencyKey: "test:grant",
    });
    const key = "generation_spend:test:last";
    await spendCredits(db, { userId, amount: 1, reason: "generation_spend", idempotencyKey: key });

    const replay = await spendCredits(db, {
      userId,
      amount: 1,
      reason: "generation_spend",
      idempotencyKey: key,
    });
    expect(replay.applied).toBe(false);
    expect(await getBalance(db, userId)).toBe(0);
  });

  /** 20 concurrent spends with one key, balance 5: exactly one charge, nobody errors. */
  it("applies a keyed spend exactly once under concurrency", async () => {
    await grantCredits(db, {
      userId,
      amount: 5,
      reason: "signup_grant",
      idempotencyKey: "test:grant",
    });

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        spendCredits(db, {
          userId,
          amount: 1,
          reason: "generation_spend",
          idempotencyKey: "generation_spend:test:race",
        }),
      ),
    );

    expect(results.filter((r) => r.applied)).toHaveLength(1);
    expect(await getBalance(db, userId)).toBe(4);
  });

  /**
   * The same idempotency key applied twice grants credits exactly once. The
   * second call is a no-op (applied: false) returning the ORIGINAL
   * transaction, not an error.
   *
   * IRL: Stripe retries webhooks on any non-200 response. Without this, one
   * slow response means someone gets 100 credits for a 50-credit purchase.
   */
  it("is idempotent on grants with a key", async () => {
    const key = "stripe:evt_123";
    const first = await grantCredits(db, {
      userId,
      amount: 50,
      reason: "purchase_grant",
      idempotencyKey: key,
    });
    const second = await grantCredits(db, {
      userId,
      amount: 50,
      reason: "purchase_grant",
      idempotencyKey: key,
    });

    expect(first.applied).toBe(true);
    expect(second).toMatchObject({ applied: false, transactionId: first.transactionId });
    expect(await getBalance(db, userId)).toBe(50);
  });

  /**
   * Spend, then refund twice with the same refId. The balance returns to where
   * it started — not above it. refundGeneration derives its idempotency key
   * from the refId, so retries are inherently safe.
   *
   * IRL: fal times out mid-generation and our job retries the refund. Users
   * must not be charged for failures — and must not profit from them either.
   */
  it("refunds a failed generation exactly once", async () => {
    await grantCredits(db, {
      userId,
      amount: 5,
      reason: "signup_grant",
      idempotencyKey: "test:grant",
    });
    await spendCredits(db, {
      userId,
      amount: 1,
      reason: "generation_spend",
      refId: "gen_1",
      idempotencyKey: "generation_spend:gen_1",
    });
    expect(await getBalance(db, userId)).toBe(4);

    await refundGeneration(db, { userId, amount: 1, refId: "gen_1" });
    await refundGeneration(db, { userId, amount: 1, refId: "gen_1" }); // retry
    expect(await getBalance(db, userId)).toBe(5);
  });

  /**
   * Two operations produce two rows, with the right amounts and reasons, in
   * order. This is the property a counter column can never give you.
   *
   * IRL: "I was charged for generations I never received." You need to be able
   * to show exactly what happened and when.
   */
  it("leaves a full audit trail", async () => {
    await grantCredits(db, {
      userId,
      amount: 10,
      reason: "signup_grant",
      idempotencyKey: "test:grant",
    });
    await spendCredits(db, {
      userId,
      amount: 1,
      reason: "generation_spend",
      idempotencyKey: "test:spend",
    });

    const { rows } = await pool.query(
      "select amount, reason from credit_transactions where user_id = $1 order by created_at",
      [userId],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].amount).toBe(10);
    expect(rows[1].amount).toBe(-1);
  });
});

describe("idempotency is required and binding", () => {
  async function rows() {
    const { rows } = await pool.query(
      "select amount, reason, idempotency_key from credit_transactions where user_id = $1 order by created_at",
      [userId],
    );
    return rows as { amount: number; reason: string; idempotency_key: string }[];
  }
  async function newUser() {
    const res = await pool.query(
      "insert into users (id, email) values (gen_random_uuid(), $1) returning id",
      [`other-${Date.now()}-${Math.random()}@example.com`],
    );
    return res.rows[0].id as string;
  }

  /**
   * The point of the ticket: forgetting the key is a COMPILE error now, not a
   * silent double charge under load. (`pnpm typecheck` covers test/ — if the
   * key ever became optional again, these @ts-expect-error lines would fail
   * the build.) The runtime guard catches JS callers and `as any` too.
   */
  it("refuses a missing key at compile time and at runtime", async () => {
    await expect(
      // @ts-expect-error idempotencyKey is required
      grantCredits(db, { userId, amount: 5, reason: "signup_grant" }),
    ).rejects.toThrow(/idempotencyKey is required/);
    await expect(
      // @ts-expect-error idempotencyKey is required
      spendCredits(db, { userId, amount: 1, reason: "generation_spend" }),
    ).rejects.toThrow(/idempotencyKey is required/);
    expect(await rows()).toHaveLength(0);
  });

  /** "" and "   " satisfy the type but identify nothing. */
  it("refuses an empty or blank key", async () => {
    for (const idempotencyKey of ["", "   "]) {
      await expect(
        grantCredits(db, { userId, amount: 5, reason: "signup_grant", idempotencyKey }),
      ).rejects.toThrow(/idempotencyKey is required/);
      await expect(
        spendCredits(db, { userId, amount: 1, reason: "generation_spend", idempotencyKey }),
      ).rejects.toThrow(/idempotencyKey is required/);
    }
    expect(await rows()).toHaveLength(0);
  });

  /**
   * Reused key, DIFFERENT terms = a caller bug. Silently returning
   * applied:false would let it believe it charged 5 when the original charged
   * 1. Throw — and leave the ledger exactly as it was.
   */
  it("throws on a grant replay with a different amount, reason, refId or user", async () => {
    const key = "purchase:evt_terms";
    await grantCredits(db, { userId, amount: 50, reason: "purchase_grant", idempotencyKey: key });
    const other = await newUser();

    const variants = [
      { userId, amount: 100, reason: "purchase_grant" as const }, // amount
      { userId, amount: 50, reason: "admin_adjustment" as const }, // reason
      { userId, amount: 50, reason: "purchase_grant" as const, refId: "order_9" }, // refId
      { userId: other, amount: 50, reason: "purchase_grant" as const }, // user
    ];
    for (const v of variants) {
      await expect(grantCredits(db, { ...v, idempotencyKey: key })).rejects.toBeInstanceOf(
        IdempotencyKeyConflictError,
      );
    }

    expect(await getBalance(db, userId)).toBe(50);
    expect(await getBalance(db, other)).toBe(0);
    expect(await rows()).toHaveLength(1);
  });

  it("throws on a spend replay with a different amount", async () => {
    await grantCredits(db, { userId, amount: 10, reason: "signup_grant", idempotencyKey: "test:grant" });
    const key = "generation_spend:terms";
    await spendCredits(db, { userId, amount: 1, reason: "generation_spend", idempotencyKey: key });

    await expect(
      spendCredits(db, { userId, amount: 5, reason: "generation_spend", idempotencyKey: key }),
    ).rejects.toBeInstanceOf(IdempotencyKeyConflictError);
    expect(await getBalance(db, userId)).toBe(9);
  });

  /** A grant's key reused for a spend: sign and reason both differ. */
  it("throws when a grant's key is reused for a spend", async () => {
    await grantCredits(db, { userId, amount: 10, reason: "signup_grant", idempotencyKey: "shared" });
    await expect(
      spendCredits(db, { userId, amount: 10, reason: "generation_spend", idempotencyKey: "shared" }),
    ).rejects.toBeInstanceOf(IdempotencyKeyConflictError);
    expect(await getBalance(db, userId)).toBe(10);
  });

  /**
   * The terms check runs BEFORE the balance check, same as the replay check:
   * at zero balance a mismatched replay must report the real problem (key
   * conflict), not a misleading InsufficientCreditsError.
   */
  it("reports a key conflict, not insufficient credits, at zero balance", async () => {
    await grantCredits(db, { userId, amount: 1, reason: "signup_grant", idempotencyKey: "test:grant" });
    await spendCredits(db, { userId, amount: 1, reason: "generation_spend", idempotencyKey: "k" });

    await expect(
      spendCredits(db, { userId, amount: 2, reason: "generation_spend", idempotencyKey: "k" }),
    ).rejects.toBeInstanceOf(IdempotencyKeyConflictError);
  });

  /**
   * Same key, two DIFFERENT users, at the same instant. The user lock doesn't
   * serialise them (different rows), so this exercises the ON CONFLICT
   * backstop: exactly one applies, the other throws — never two grants.
   * 10 rounds so the interleaving actually varies.
   */
  it("same key from two users concurrently: one applies, the other throws", async () => {
    for (let round = 0; round < 10; round++) {
      const a = await newUser();
      const b = await newUser();
      const key = `purchase:evt_race_${round}`;

      const results = await Promise.allSettled([
        grantCredits(db, { userId: a, amount: 7, reason: "purchase_grant", idempotencyKey: key }),
        grantCredits(db, { userId: b, amount: 7, reason: "purchase_grant", idempotencyKey: key }),
      ]);

      const applied = results.filter((r) => r.status === "fulfilled" && r.value.applied);
      const conflicts = results.filter(
        (r) => r.status === "rejected" && r.reason instanceof IdempotencyKeyConflictError,
      );
      expect(applied, `round ${round}`).toHaveLength(1);
      expect(conflicts, `round ${round}`).toHaveLength(1);
      expect((await getBalance(db, a)) + (await getBalance(db, b))).toBe(7);
    }
  });

  /** 20 concurrent identical grants (same key, same terms): one row, nobody errors. */
  it("applies a keyed grant exactly once under concurrency", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        grantCredits(db, { userId, amount: 3, reason: "purchase_grant", idempotencyKey: "purchase:evt_20" }),
      ),
    );
    expect(results.filter((r) => r.applied)).toHaveLength(1);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(await getBalance(db, userId)).toBe(3);
  });
});

describe("per-reason grant wrappers", () => {
  async function keys() {
    const { rows } = await pool.query(
      "select idempotency_key from credit_transactions where user_id = $1",
      [userId],
    );
    return rows.map((r) => r.idempotency_key as string);
  }

  /**
   * IRL: the OTP redemption or the Google callback is retried (refresh,
   * double-submit, a redirect replayed). The user gets their signup credits
   * once — sequentially and under a 20-way race.
   */
  it("a double signup grant grants exactly once", async () => {
    const first = await grantSignupCredits(db, { userId });
    const again = await grantSignupCredits(db, { userId });
    expect(first.applied).toBe(true);
    expect(again).toMatchObject({ applied: false, transactionId: first.transactionId });

    const raced = await Promise.all(
      Array.from({ length: 20 }, () => grantSignupCredits(db, { userId })),
    );
    expect(raced.filter((r) => r.applied)).toHaveLength(0);

    expect(await getBalance(db, userId)).toBe(SIGNUP_GRANT_CREDITS);
    expect(await keys()).toEqual([`signup:${userId}`]);
  });

  it("a fresh signup raced 20 ways still grants exactly once", async () => {
    const raced = await Promise.all(
      Array.from({ length: 20 }, () => grantSignupCredits(db, { userId })),
    );
    expect(raced.filter((r) => r.applied)).toHaveLength(1);
    expect(await getBalance(db, userId)).toBe(SIGNUP_GRANT_CREDITS);
  });

  /**
   * IRL: the monthly-grant job hiccups and retries. Without the key, every
   * retry is another month's credits, free. Once per user per month — and
   * the next month still applies.
   */
  it("a double monthly grant grants exactly once per month", async () => {
    const raced = await Promise.all(
      Array.from({ length: 20 }, () =>
        grantMonthlyCredits(db, { userId, amount: 25, month: "2026-10" }),
      ),
    );
    expect(raced.filter((r) => r.applied)).toHaveLength(1);
    expect((await grantMonthlyCredits(db, { userId, amount: 25, month: "2026-10" })).applied).toBe(false);
    expect(await getBalance(db, userId)).toBe(25);

    // Next month is a different intent.
    expect((await grantMonthlyCredits(db, { userId, amount: 25, month: "2026-11" })).applied).toBe(true);
    expect(await getBalance(db, userId)).toBe(50);
    expect((await keys()).sort()).toEqual([
      `monthly:${userId}:2026-10`,
      `monthly:${userId}:2026-11`,
    ]);
  });

  it("monthly keys are per user: one user's grant doesn't block another's", async () => {
    const res = await pool.query(
      "insert into users (id, email) values (gen_random_uuid(), 'm2@example.com') returning id",
    );
    const other: string = res.rows[0].id;
    await grantMonthlyCredits(db, { userId, amount: 25, month: "2026-10" });
    expect((await grantMonthlyCredits(db, { userId: other, amount: 25, month: "2026-10" })).applied).toBe(true);
  });

  /** A wrong period string would silently create a new key — refuse it. */
  it("rejects a malformed month", async () => {
    for (const month of ["2026-1", "2026-13", "26-10", "2026/10", "", "2026-10-01"]) {
      await expect(grantMonthlyCredits(db, { userId, amount: 25, month })).rejects.toThrow(
        /yyyy-mm/,
      );
    }
    expect(await getBalance(db, userId)).toBe(0);
  });

  /** A changed monthly amount for an already-granted month is a conflict, not a top-up. */
  it("a monthly re-grant with a different amount throws", async () => {
    await grantMonthlyCredits(db, { userId, amount: 25, month: "2026-10" });
    await expect(
      grantMonthlyCredits(db, { userId, amount: 30, month: "2026-10" }),
    ).rejects.toBeInstanceOf(IdempotencyKeyConflictError);
  });

  /** IRL: Stripe redelivers a webhook. Same event id → one grant. */
  it("a redelivered purchase event grants once", async () => {
    const params = { userId, amount: 100, stripeEventId: "evt_1Abc" };
    expect((await grantPurchaseCredits(db, params)).applied).toBe(true);
    expect((await grantPurchaseCredits(db, params)).applied).toBe(false);
    expect(await getBalance(db, userId)).toBe(100);
    expect(await keys()).toEqual(["purchase:evt_1Abc"]);
  });

  it("a resubmitted admin adjustment applies once", async () => {
    const params = { userId, amount: 5, adminActionId: "ticket-42" };
    expect((await grantAdminAdjustment(db, params)).applied).toBe(true);
    expect((await grantAdminAdjustment(db, params)).applied).toBe(false);
    expect(await getBalance(db, userId)).toBe(5);
    expect(await keys()).toEqual(["admin:ticket-42"]);
  });

  it("event-driven wrappers refuse a blank event/action id", async () => {
    await expect(
      grantPurchaseCredits(db, { userId, amount: 1, stripeEventId: " " }),
    ).rejects.toThrow(/required/);
    await expect(
      grantAdminAdjustment(db, { userId, amount: 1, adminActionId: "" }),
    ).rejects.toThrow(/required/);
    expect(await getBalance(db, userId)).toBe(0);
  });
});
