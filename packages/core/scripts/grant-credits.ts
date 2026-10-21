/**
 * DEV ONLY — top up a local account so generation can be tested.
 *
 *   pnpm dev:grant 20                      # DEV_GRANT_EMAIL from .env
 *   pnpm dev:grant 20 other@example.com    # someone else
 *
 * A thin CLI over grantAdminAdjustment: no new ledger logic, same
 * admin-action-keyed path production uses. Each run mints a fresh action id,
 * so running it twice grants twice (deliberate — a top-up is a new intent).
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDirectDb, schema } from "@wallop/db";
import { getBalance, grantAdminAdjustment } from "../src/credits";

if (process.env.NODE_ENV === "production") {
  throw new Error("dev:grant is a local tool and will not run in production");
}

// Amount first so the common case is just `pnpm dev:grant 20` — the email is
// nearly always your own, and lives in DEV_GRANT_EMAIL.
const [rawAmount, emailArg] = process.argv.slice(2);
const email = emailArg || process.env.DEV_GRANT_EMAIL;

const USAGE = "usage: pnpm dev:grant <amount> [email]";

if (!rawAmount) {
  console.error(USAGE);
  process.exit(1);
}

const amount = Number(rawAmount);
if (!Number.isInteger(amount) || amount <= 0) {
  console.error(`amount must be a positive whole number, got "${rawAmount}"`);
  console.error(USAGE);
  process.exit(1);
}

if (!email) {
  console.error(
    "no email given and DEV_GRANT_EMAIL is not set — add it to .env or pass one",
  );
  console.error(USAGE);
  process.exit(1);
}

const db = getDirectDb();

const [user] = await db
  .select({ id: schema.users.id })
  .from(schema.users)
  .where(eq(schema.users.email, email));

if (!user) {
  console.error(`no user with email "${email}"`);
  process.exit(1);
}

await grantAdminAdjustment(db, {
  userId: user.id,
  amount,
  adminActionId: `dev-grant:${randomUUID()}`,
});

console.log(
  `${email}  +${amount}  →  ${await getBalance(db, user.id)} credits`,
);
process.exit(0);
