import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";

export const users = pgTable("users", {
  id: uuid("id")
    .primaryKey()
    .$defaultFn(() => uuidv7()),
  name: text("name"),
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
 * no audit trail when a customer disputes a` charge.
 */
export const creditTransactions = pgTable(
  "credit_transactions",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
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

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // SHA-256 of the token. The raw token only ever lives in the user's cookie.
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const otpCodes = pgTable(
  "otp_codes",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    // Email now; identifierType leaves the door open for SMS later.
    identifier: text("identifier").notNull(),
    identifierType: text("identifier_type").notNull().default("email"),
    codeHash: text("code_hash").notNull(),
    // Bound to the requesting browser — stops a phished code being
    // redeemed in the attacker's session.
    nonce: text("nonce").notNull(),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("otp_identifier_idx").on(t.identifier, t.createdAt)],
);

export const oauthAccounts = pgTable(
  "oauth_accounts",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    provider: text("provider").notNull(), // "google"
    // Google's `sub` — stable and immutable. Emails change; this doesn't.
    providerUserId: text("provider_user_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("oauth_provider_user_idx").on(t.provider, t.providerUserId),
    index("oauth_user_idx").on(t.userId),
  ],
);

export const oauthStates = pgTable("oauth_states", {
  id: uuid("id")
    .primaryKey()
    .$defaultFn(() => uuidv7()),
  state: text("state").notNull().unique(),
  codeVerifier: text("code_verifier").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
