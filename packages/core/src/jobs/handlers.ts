import type { PgBoss } from "pg-boss";
import { type DbClient } from "@wallop/db";
import { JOBS, type PayloadOf } from "./registry";
import { deleteExpiredSessions } from "../auth/sessions";
import { deleteExpiredOAuthStates } from "../auth/google";
import { deleteExpiredOtpCodes } from "../auth/otp";
import { ensureQueue } from "./queue";
import { reapStalledDesigns } from "../designs/designs";
import { refundGeneration } from "../credits";

const JOB_RETRY = {
  retryLimit: 3,
  retryDelay: 30,
  retryBackoff: true,
} as const;

const FAIL_RETRY = {
  retryLimit: 5,
  retryDelay: 10,
  retryBackoff: true,
} as const;

export async function registerHandlers(boss: PgBoss, db: DbClient) {
  // Ping
  await ensureQueue(boss, JOBS.pingFailed, { ...FAIL_RETRY, notify: true });
  await ensureQueue(boss, JOBS.ping, {
    ...JOB_RETRY,
    deadLetter: JOBS.pingFailed,
    notify: true,
  });

  await boss.work<PayloadOf<typeof JOBS.ping>>(
    JOBS.ping,
    { batchSize: 1 },
    async (jobs) => {
      for (const job of jobs) {
        console.log(`[worker] ping: "${job.data.message}"`);
      }
    },
  );
  await boss.work<PayloadOf<typeof JOBS.pingFailed>>(
    JOBS.pingFailed,
    { batchSize: 1 },
    async (jobs) => {
      for (const job of jobs) {
        console.error("[worker] job failed permanently:", job.data);
        // Later: alert, or write to an admin review table.
      }
    },
  );

  // Cleanup
  await ensureQueue(boss, JOBS.cleanupExpired, { ...JOB_RETRY, notify: true });

  await boss.work<PayloadOf<typeof JOBS.cleanupExpired>>(
    JOBS.cleanupExpired,
    { batchSize: 1 },
    async () => {
      await deleteExpiredSessions(db);
      await deleteExpiredOAuthStates(db);
      await deleteExpiredOtpCodes(db);
      const stalled = await reapStalledDesigns(db);
      for (const design of stalled) {
        await refundGeneration(db, {
          userId: design.ownerId,
          amount: 1,
          refId: design.id,
        });
      }
      if (stalled.length > 0) {
        console.log(`[worker] reaped ${stalled.length} stalled design(s)`);
      }
      console.log("[worker] swept expired sessions, oauth states, otp codes");
    },
  );

  // Nightly at 3am. pg-boss dedupes by name, so this is safe to call on
  // every boot — it won't stack up duplicate schedules.
  await boss.schedule(JOBS.cleanupExpired, "0 3 * * *", {});
}
