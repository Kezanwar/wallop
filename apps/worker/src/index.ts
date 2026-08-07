import { getDirectDb } from "@wallop/db";
import {
  startWorkerQueue,
  registerHandlers,
  stopWorkerQueue,
} from "@wallop/core";

async function main() {
  const connectionString = process.env.DATABASE_URL_DIRECT;
  if (!connectionString) throw new Error("Missing DATABASE_URL_DIRECT");

  console.log("[worker] starting…");

  const db = getDirectDb();
  const boss = await startWorkerQueue(connectionString);
  await registerHandlers(boss, db);

  console.log("[worker] ready, listening for jobs");

  const shutdown = async (signal: string) => {
    console.log(`[worker] ${signal} — finishing in-flight jobs…`);
    await stopWorkerQueue();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
