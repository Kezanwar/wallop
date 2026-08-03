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
  it("starts at zero", async () => {
    expect(await getBalance(db, userId)).toBe(0);
  });

  it("grants and spends", async () => {
    await grantCredits(db, { userId, amount: 10, reason: "signup_grant" });
    expect(await getBalance(db, userId)).toBe(10);

    await spendCredits(db, { userId, amount: 3, reason: "generation_spend" });
    expect(await getBalance(db, userId)).toBe(7);
  });

  it("refuses to overspend", async () => {
    await grantCredits(db, { userId, amount: 2, reason: "signup_grant" });
    await expect(
      spendCredits(db, { userId, amount: 3, reason: "generation_spend" }),
    ).rejects.toThrow(InsufficientCreditsError);
    expect(await getBalance(db, userId)).toBe(2);
  });

  it("never goes negative", async () => {
    await expect(
      spendCredits(db, { userId, amount: 1, reason: "generation_spend" }),
    ).rejects.toThrow(InsufficientCreditsError);
    expect(await getBalance(db, userId)).toBe(0);
  });

  // THE important one. This is what a counter column gets wrong.
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
