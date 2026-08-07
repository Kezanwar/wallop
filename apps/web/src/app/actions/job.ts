"use server";
import { JOBS, enqueueInTransaction } from "@wallop/core";
import { getPooledDb } from "@wallop/db";
import { requireSession } from "@/lib/auth";
import { queue } from "@/lib/queue";

export async function pingJobAction() {
  const session = await requireSession();
  const boss = await queue();
  const db = getPooledDb();

  await db.transaction(async (tx) => {
    await enqueueInTransaction(boss, tx, JOBS.ping, {
      message: `hello from ${session.email}`,
      userId: session.userId,
    });
  });
}
