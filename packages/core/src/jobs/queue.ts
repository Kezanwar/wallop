import { PgBoss, SendOptions } from "pg-boss";
import { JobName, PayloadOf } from "./registry";
import { sql } from "drizzle-orm";
import { fromDrizzle } from "pg-boss";
import { getPooledDb, type DbTransaction } from "@wallop/db";

const g = globalThis as unknown as {
  __workerBoss?: PgBoss;
  __webBoss?: PgBoss;
};

/**
 * Worker-side: full runtime. start() spins up maintenance workers, the
 * internal send-it queue processor, polling loops and the scheduler.
 *
 * MUST use the DIRECT connection — long-lived, and transaction-mode
 * pooling would reassign connections underneath it.
 */
export async function startWorkerQueue(
  connectionString: string,
): Promise<PgBoss> {
  if (g.__workerBoss) return g.__workerBoss;

  const boss = new PgBoss({
    connectionString,
    schema: "pgboss",
    useListenNotify: true,
  });
  boss.on("error", (err) => console.error("[queue] error:", err));

  await boss.start();
  g.__workerBoss = boss;
  return boss;
}

export async function stopWorkerQueue(): Promise<void> {
  if (g.__workerBoss) {
    await g.__workerBoss.stop();
    g.__workerBoss = undefined;
  }
}

/**
 * Web-side: enqueue only. Uses OUR Drizzle pool via the db adapter rather
 * than letting pg-boss open its own — one pool in web instead of two, and
 * no idle background connection to time out when traffic is quiet.
 *
 * start() is still required (pg-boss asserts the connection is open before
 * any SQL), but with supervise/schedule/migrate off it does nothing except
 * establish state — no workers, no cron, no maintenance.
 */
export async function getWebQueue(): Promise<PgBoss> {
  if (g.__webBoss) return g.__webBoss;

  const boss = new PgBoss({
    schema: "pgboss",
    supervise: false,
    schedule: false,
    migrate: false,
    db: fromDrizzle(getPooledDb(), sql),
  });
  boss.on("error", (err) => console.error("[queue] error:", err));

  await boss.start();
  g.__webBoss = boss;
  return boss;
}

export async function enqueue<T extends JobName>(
  boss: PgBoss,
  name: T,
  payload: PayloadOf<T>,
  options?: SendOptions,
): Promise<string | null> {
  return boss.send(name, payload, options ?? {});
}

type QueueConfig = Parameters<PgBoss["createQueue"]>[1];

/**
 * createQueue is a no-op if the queue already exists, so config changes
 * silently never apply. Pairing it with updateQueue means the queue's
 * settings always match what's in code — same guarantee migrations give
 * us for tables.
 */
export async function ensureQueue(
  boss: PgBoss,
  name: string,
  config?: QueueConfig,
) {
  await boss.createQueue(name, config);
  if (config) await boss.updateQueue(name, config);
}

/**
 * Enqueue inside an existing transaction, so the job insert commits with
 * whatever else the transaction is doing. For generation this matters:
 * the credit spend and the job must both land or neither does.
 *
 * The per-call `db` overrides the instance-level one set in getWebQueue,
 * pointing pg-boss at this specific transaction rather than the pool.
 */
export async function enqueueInTransaction<T extends JobName>(
  boss: PgBoss,
  tx: DbTransaction,
  name: T,
  payload: PayloadOf<T>,
  options?: SendOptions,
): Promise<string | null> {
  return boss.send(name, payload, {
    ...options,
    db: fromDrizzle(tx, sql),
  });
}
