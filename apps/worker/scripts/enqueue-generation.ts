/**
 * Two-process check: enqueue a generation the way the WEB app does, from a
 * separate process, and watch the separately running worker consume it.
 *
 *   terminal 1:  pnpm worker:dev
 *   terminal 2:  pnpm --filter @wallop/worker enqueue-generation ["prompt"]
 *
 * This process never registers a handler — it uses getWebQueue() (enqueue-
 * only, our pooled Drizzle connection, no workers), exactly like
 * generateDesignAction. If the design settles, the worker process did it.
 *
 * Dev only: seeds a throwaway user with 1 credit per run. Refuses to run with
 * NODE_ENV=production.
 */
import { randomUUID } from "node:crypto";
import { getPooledDb, schema } from "@wallop/db";
import {
  createDesignSession,
  enqueueGeneration,
  getBalance,
  getDesign,
  getWebQueue,
  grantAdminAdjustment,
} from "@wallop/core";

const EMAIL = "two-process-check@wallop.local";
const PROMPT =
  process.argv[2] ??
  "Moody cinematic photograph, a lone figure at the end of a long pier in " +
    "full silhouette against a violet-to-magenta-to-orange dusk glow, shot on film.";
const TIMEOUT_MS = 5 * 60_000;

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("enqueue-generation is a dev check — refusing to run in production");
  }
  const db = getPooledDb();

  let user = await db.query.users.findFirst({
    columns: { id: true },
    where: (u, { eq }) => eq(u.email, EMAIL),
  });
  if (!user) {
    [user] = await db
      .insert(schema.users)
      .values({ email: EMAIL })
      .returning({ id: schema.users.id });
  }
  const userId = user!.id;
  // One id per run, minted once here: it identifies this check's intent, so
  // it keys both the credit grant and the generation request.
  const runId = randomUUID();
  await grantAdminAdjustment(db, {
    userId,
    amount: 1,
    adminActionId: `two-process-check:${runId}`,
  });
  const session = await createDesignSession(db, { userId, aspectRatio: "portrait" });

  const before = await getBalance(db, userId);
  const t0 = Date.now();
  const boss = await getWebQueue();
  const { designId, jobId } = await enqueueGeneration(db, boss, {
    userId,
    sessionId: session.id,
    prompt: PROMPT,
    requestId: runId,
  });
  console.log(`[enqueue] pid=${process.pid} design=${designId} job=${jobId} balance ${before} → ${before - 1}`);
  console.log("[enqueue] waiting for the worker process…");

  let status = "pending";
  while (Date.now() - t0 < TIMEOUT_MS) {
    const design = await getDesign(db, designId);
    if (design && design.status !== status) {
      status = design.status;
      console.log(`[enqueue] +${Date.now() - t0}ms status=${status}${design.failureReason ? ` (${design.failureReason})` : ""}`);
    }
    if (status !== "pending" && status !== "generating") break;
    await new Promise((r) => setTimeout(r, 250));
  }

  const after = await getBalance(db, userId);
  console.log(`[enqueue] settled as "${status}" in ${Date.now() - t0}ms, balance now ${after}`);
  if (status === "pending" || status === "generating") {
    console.error("[enqueue] TIMED OUT — is the worker running? (pnpm worker:dev)");
    process.exitCode = 1;
  }

  // No process.exit(): when stdout is a pipe, Node writes to it
  // asynchronously and exit() can drop unflushed output. Close what keeps
  // the event loop alive and let the process end naturally.
  await boss.stop({ graceful: false });
  await db.$client.end();
}

main().catch((err) => {
  console.error("[enqueue] fatal:", err);
  process.exitCode = 1;
  // Don't hang on open handles after a crash; exit once stderr has drained.
  process.stderr.write("", () => process.exit());
});
