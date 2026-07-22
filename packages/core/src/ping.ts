import { type DbClient, schema } from "@studia-nova/db";

// Trivial domain function proving the core -> db boundary works.
// Real domain logic (credits, orders) will follow this same shape:
// a function that takes a db client and does something meaningful.
export async function writePing(db: DbClient, message: string) {
  const [row] = await db
    .insert(schema.pingTable)
    .values({ message })
    .returning();
  return row;
}

export async function readPings(db: DbClient) {
  return db.select().from(schema.pingTable);
}
