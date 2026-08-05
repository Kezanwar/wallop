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
  InsufficientCreditsError,
} from "../src/credits";

const pool = new Pool({ connectionString: process.env.DATABASE_URL_TEST });
const db = drizzle(pool, { schema }) as never as Parameters<
  typeof getBalance
>[0];

let userId: string;

beforeEach(async () => {
  await pool.query("truncate table credit_transactions, users cascade");
  const res = await pool.query(
    "insert into users (email) values ($1) returning id",
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
    await grantCredits(db, { userId, amount: 10, reason: "signup_grant" });
    expect(await getBalance(db, userId)).toBe(10);

    await spendCredits(db, { userId, amount: 3, reason: "generation_spend" });
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
    await grantCredits(db, { userId, amount: 2, reason: "signup_grant" });
    await expect(
      spendCredits(db, { userId, amount: 3, reason: "generation_spend" }),
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
      spendCredits(db, { userId, amount: 1, reason: "generation_spend" }),
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
   */
  it("does not double-spend under concurrency", async () => {
    await grantCredits(db, { userId, amount: 1, reason: "signup_grant" });

    const results = await Promise.allSettled([
      spendCredits(db, { userId, amount: 1, reason: "generation_spend" }),
      spendCredits(db, { userId, amount: 1, reason: "generation_spend" }),
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
   */
  it("handles many concurrent spends correctly", async () => {
    await grantCredits(db, { userId, amount: 5, reason: "signup_grant" });

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        spendCredits(db, { userId, amount: 1, reason: "generation_spend" }),
      ),
    );

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    expect(await getBalance(db, userId)).toBe(0);
  });

  /**
   * The same idempotency key applied twice grants credits exactly once. The
   * second call is a silent no-op (applied: false), not an error.
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
    expect(second.applied).toBe(false);
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
    await grantCredits(db, { userId, amount: 5, reason: "signup_grant" });
    await spendCredits(db, {
      userId,
      amount: 1,
      reason: "generation_spend",
      refId: "gen_1",
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
    await grantCredits(db, { userId, amount: 10, reason: "signup_grant" });
    await spendCredits(db, { userId, amount: 1, reason: "generation_spend" });

    const { rows } = await pool.query(
      "select amount, reason from credit_transactions where user_id = $1 order by created_at",
      [userId],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].amount).toBe(10);
    expect(rows[1].amount).toBe(-1);
  });
});
