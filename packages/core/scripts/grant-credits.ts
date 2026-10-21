/**
 * DEV ONLY — top up a local account so generation can be tested.
 *
 *   pnpm --filter @wallop/core dev:grant you@example.com 20
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

const [email, rawAmount] = process.argv.slice(2);

if (!email || !rawAmount) {
  console.error("usage: pnpm --filter @wallop/core dev:grant <email> <amount>");
  process.exit(1);
}

const amount = Number(rawAmount);
if (!Number.isInteger(amount) || amount <= 0) {
  console.error(`amount must be a positive whole number, got "${rawAmount}"`);
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
