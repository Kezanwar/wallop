import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  isGuest: boolean("is_guest").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

/**
 * APPEND-ONLY ledger. Never UPDATE or DELETE a row here.
 * Balance is always SUM(amount) — there is no cached balance column,
 * deliberately: a counter double-spends under concurrency and leaves
 * no audit trail when a customer disputes a charge.
 */
export const creditTransactions = pgTable(
  "credit_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Positive = grant, negative = spend.
    amount: integer("amount").notNull(),
    reason: text("reason").notNull(),
    // What this relates to: a generation id, order id, stripe payment id.
    refId: text("ref_id"),
    // Set for grants that must never double-apply (webhooks, retried jobs).
    idempotencyKey: text("idempotency_key").unique(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("credit_tx_user_idx").on(t.userId)],
);
