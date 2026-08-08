import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  timestamp,
  index,
  uniqueIndex,
  jsonb,
} from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";

export const users = pgTable("users", {
  id: uuid("id")
    .primaryKey()
    .$defaultFn(() => uuidv7()),
  name: text("name"),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
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

/**
 * A generation conversation. Aspect ratio is fixed for the session — with
 * A-series every size shares 1:1.414, so one generation serves A3/A2/A1
 * and the user picks size afterwards. Square is a later addition, hence
 * a text field rather than a portrait/landscape boolean.
 */
export const designSessions = pgTable(
  "design_sessions",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    aspectRatio: text("aspect_ratio").notNull(), // portrait | landscape | square
    title: text("title"), // model-generated summary
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("design_sessions_user_idx").on(t.userId, t.createdAt)],
);

/** One turn in the conversation. */
export const sessionMessages = pgTable(
  "session_messages",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => designSessions.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // user | assistant
    content: text("content").notNull(),
    creditsSpent: integer("credits_spent").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("session_messages_session_idx").on(t.sessionId, t.createdAt)],
);

/**
 * A generated image. parentDesignId makes this a tree — an edit branches
 * from a specific prior image, and users will want to go back to an
 * earlier version they preferred.
 *
 * prompt/seed/model/params are stored deliberately: they're the
 * regeneration path, the moderation appeal trail, and the future
 * creator-variants feature, all from one column group.
 *
 */
export const designs = pgTable(
  "designs",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => designSessions.id, { onDelete: "cascade" }),
    messageId: uuid("message_id").references(() => sessionMessages.id, {
      onDelete: "set null",
    }),
    parentDesignId: uuid("parent_design_id"),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    prompt: text("prompt").notNull(),
    seed: text("seed"),
    model: text("model").notNull(),
    params: jsonb("params").$type<Record<string, unknown>>(),
    aspectRatio: text("aspect_ratio").notNull(),
    // Visibility/lifecycle for a design:
    //   dismissedAt null + isKept false → normal, swept after 30 days
    //   dismissedAt set                 → hidden from the grid, swept sooner
    //   isKept true                     → pinned, never swept
    // The sweeper additionally refuses to delete anything with children or
    // a purchase, so lineage and orders can't be broken.

    // pending | generating | ready | failed | moderation_rejected
    status: text("status").notNull().default("pending"),
    failureReason: text("failure_reason"),

    // private | unlisted | public. Public is admin-only in v1 — the
    // gallery is curated. Present from day one so the v2 creator tier
    // is a flag, not a migration.
    visibility: text("visibility").notNull().default("private"),
    moderationStatus: text("moderation_status").notNull().default("pending"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    description: text("description"),
    // User consent: may others use this as a visual reference for their own
    // generations? Publishing to the gallery and licensing derivation are
    // separate decisions.
    allowAsReference: boolean("allow_as_reference").notNull().default(false),
    // User has pinned this — exempt from the 30-day sweep. Not a "favourite";
    // it's an explicit "don't delete this".
    isKept: boolean("is_kept").notNull().default(false),
    slug: text("slug").unique(),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("designs_session_idx").on(t.sessionId, t.createdAt),
    index("designs_owner_idx").on(t.ownerId, t.createdAt),
    index("designs_parent_idx").on(t.parentDesignId),
    index("designs_public_idx").on(t.visibility, t.createdAt),
  ],
);

/**
 * Rendered variants of a design. The print asset is paywalled regardless
 * of who generated it.
 */
export const designAssets = pgTable(
  "design_assets",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    designId: uuid("design_id")
      .notNull()
      .references(() => designs.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // preview | print | mockup
    storageKey: text("storage_key").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("design_assets_design_idx").on(t.designId, t.kind)],
);
