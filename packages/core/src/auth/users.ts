import { eq } from "drizzle-orm";
import { type DbClient, schema } from "@wallop/db";

const { users } = schema;

export async function setUserName(
  db: DbClient,
  params: { userId: string; name: string },
): Promise<void> {
  const name = params.name.trim().slice(0, 100);
  if (!name) return;
  await db.update(users).set({ name }).where(eq(users.id, params.userId));
}

export async function getUser(db: DbClient, userId: string) {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  return user ?? null;
}
