import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import sharp from "sharp";
import type { PgBoss } from "pg-boss";
import { runMigrations, schema } from "@wallop/db";
import { getBalance, grantAdminAdjustment } from "../../src/credits";
import { createDesignSession, getDesign } from "../../src/designs/designs";
import { ASPECT_RATIOS, DESIGN_STATUS } from "../../src/designs/constants";
import {
  enqueueGeneration,
  registerGenerationHandlers,
  type GenerationDeps,
} from "../../src/generation";
import { startWorkerQueue, stopWorkerQueue } from "../../src/jobs/queue";
import {
  getImageProvider,
  ImageProviderError,
  type ImageProvider,
} from "../../src/providers";
import { getStorage, storageKeys } from "../../src/storage";

/**
 * The whole pipeline, live: enqueue (spend + design + job) → real pg-boss
 * worker → real Gemini → crop → real R2 → ready. Then the two failure routes.
 *
 * PAID: one Gemini generation per run. The failure cases are stubbed and
 * cost nothing. Runs against DATABASE_URL_TEST (migrated here), never dev.
 *
 *   pnpm smoke generation          # just this file
 *   SMOKE_PAUSE_SECONDS=120 pnpm smoke generation   # hold before teardown
 */
const required = [
  "GEMINI_API_KEY",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "DATABASE_URL_TEST",
];
const missing = required.filter((name) => !process.env[name]);

const PROMPT =
  "Moody cinematic graphic design edgy poster vibe, deep shadow and near-silhouette, a glowing " +
  "violet-to-magenta-to-orange gradient dusk light, hard-edged geometric shafts " +
  "of pink light, vast negative space, hand-drawn, gouache painting " +
  "deep blacks and rich saturated colour. A lone figure standing at the end of " +
  "a long pier reaching into a calm sea, in full silhouette against the glow.";

// Prompts carrying these markers never reach Gemini — see stubbedProvider.
const FORCE_MODERATION = "[smoke:force-moderation]";
const FORCE_TRANSIENT = "[smoke:force-transient]";

const OUT_DIR = join(import.meta.dirname, "output");

/** The real provider, except for marker prompts, which fail without a paid call. */
function stubbedProvider(real: ImageProvider): ImageProvider {
  return {
    async generate(params) {
      if (params.prompt.includes(FORCE_MODERATION)) {
        throw new ImageProviderError("smoke: forced moderation rejection", {
          kind: "moderation",
        });
      }
      if (params.prompt.includes(FORCE_TRANSIENT)) {
        throw new ImageProviderError("smoke: forced transient failure", {
          kind: "transient",
        });
      }
      return real.generate(params);
    },
  };
}

describe.skipIf(missing.length > 0)("generation pipeline (live)", () => {
  let pool: Pool;
  let db: GenerationDeps["db"];
  let boss: PgBoss;
  let userId: string;
  let sessionId: string;
  const STARTING_CREDITS = 5;

  beforeAll(async () => {
    const url = process.env.DATABASE_URL_TEST!;
    await runMigrations(url);
    pool = new Pool({ connectionString: url });
    db = drizzle(pool, { schema }) as never as GenerationDeps["db"];

    // Same boss config as the real worker (direct connection, LISTEN/NOTIFY).
    boss = await startWorkerQueue(url);
    await registerGenerationHandlers(boss, {
      db,
      provider: stubbedProvider(getImageProvider()),
      storage: getStorage(),
    });

    const res = await pool.query(
      "insert into users (id, email) values (gen_random_uuid(), $1) returning id",
      [`smoke-${Date.now()}@example.com`],
    );
    userId = res.rows[0].id;
    await grantAdminAdjustment(db, {
      userId,
      amount: STARTING_CREDITS,
      adminActionId: `smoke-seed:${userId}`,
    });
    sessionId = (
      await createDesignSession(db, { userId, aspectRatio: "portrait" })
    ).id;
  });

  afterAll(async () => {
    const pause = Number(process.env.SMOKE_PAUSE_SECONDS ?? 0);
    if (pause > 0) {
      console.log(`\nPausing ${pause}s before teardown (SMOKE_PAUSE_SECONDS)…`);
      await new Promise((r) => setTimeout(r, pause * 1000));
    }
    await stopWorkerQueue();
    await pool?.end();
  }, 15 * 60_000);

  test("happy path: enqueue → generate → crop → R2 → ready, 1 credit spent", async () => {
    const before = await getBalance(db, userId);
    const t0 = Date.now();

    const { designId, jobId } = await enqueueGeneration(db, boss, {
      requestId: randomUUID(),
      userId,
      sessionId,
      prompt: PROMPT,
    });
    const tEnqueued = Date.now();
    expect(await getBalance(db, userId)).toBe(before - 1);

    const design = await waitForSettled(db, designId, 240_000);
    const tDone = Date.now();
    expect(design.status, `failureReason: ${design.failureReason}`).toBe(
      DESIGN_STATUS.ready,
    );

    // Asset row.
    const { rows: assetRows } = await pool.query(
      "select kind, storage_key, width, height from design_assets where design_id = $1",
      [designId],
    );
    const key = storageKeys.preview(designId);
    expect(assetRows).toHaveLength(1);
    expect(assetRows[0]).toMatchObject({ kind: "preview", storage_key: key });

    // R2 object: exists, is webp, is 1:1.414, matches the asset row.
    const storage = getStorage();
    expect(await storage.exists(key)).toBe(true);
    const signedUrl = await storage.getSignedUrl(key, 3600);
    const res = await fetch(signedUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    const bytes = Buffer.from(await res.arrayBuffer());
    const meta = await sharp(bytes).metadata();
    expect(meta.format).toBe("webp");
    expect([meta.width, meta.height]).toEqual([
      assetRows[0].width,
      assetRows[0].height,
    ]);
    const ratio = meta.width! / meta.height!;
    expect(Math.abs(ratio - ASPECT_RATIOS.portrait.ratio)).toBeLessThan(0.002);

    // Exactly one credit gone, and it stayed gone.
    expect(await getBalance(db, userId)).toBe(before - 1);

    mkdirSync(OUT_DIR, { recursive: true });
    const localPath = join(OUT_DIR, "pipeline-preview.webp");
    writeFileSync(localPath, bytes);

    expect(jobId).toBeTruthy();
    const timing = await jobTiming(pool, jobId!);
    console.log(
      [
        "",
        "── generation pipeline ──────────────────────────────",
        `design      ${designId}`,
        `model       ${design.model}`,
        `preview     ${meta.width}x${meta.height}  ratio ${ratio.toFixed(4)} (target ${ASPECT_RATIOS.portrait.ratio.toFixed(4)})  ${(bytes.length / 1024).toFixed(0)}KB`,
        `enqueue     ${tEnqueued - t0}ms (transaction: design + spend + job)`,
        `pickup      ${timing.pickupMs ?? "?"}ms (job created → worker started)`,
        `job         ${timing.runMs ?? "?"}ms (worker start → complete)`,
        `end-to-end  ${tDone - t0}ms (enqueue → status ready, as seen by polling)`,
        `R2 key      ${key}`,
        `local copy  ${localPath}`,
        `signed URL (1h):`,
        signedUrl,
        "─────────────────────────────────────────────────────",
        "",
      ].join("\n"),
    );
  });

  test("terminal failure: moderation → moderation_rejected + refunded, no retries", async () => {
    const before = await getBalance(db, userId);
    const t0 = Date.now();
    const { designId } = await enqueueGeneration(db, boss, {
      requestId: randomUUID(),
      userId,
      sessionId,
      prompt: `${FORCE_MODERATION} anything`,
    });
    expect(await getBalance(db, userId)).toBe(before - 1);

    const design = await waitForSettled(db, designId, 30_000);
    expect(design.status).toBe(DESIGN_STATUS.moderationRejected);
    expect(design.failureReason).toMatch(/forced moderation/);
    expect(await getBalance(db, userId)).toBe(before);
    console.log(`terminal failure settled + refunded in ${Date.now() - t0}ms`);
  });

  test("transient failure: retries exhausted → DLQ → failed + refunded", async () => {
    const before = await getBalance(db, userId);
    const t0 = Date.now();
    const { designId } = await enqueueGeneration(db, boss, {
      requestId: randomUUID(),
      userId,
      sessionId,
      prompt: `${FORCE_TRANSIENT} anything`,
    });

    // 3 attempts 5s apart, then the DLQ — ~14s measured with 2s polling.
    const design = await waitForSettled(db, designId, 60_000);
    expect(design.status).toBe(DESIGN_STATUS.failed);
    expect(design.failureReason).toBe("Generation failed after retries");
    expect(await getBalance(db, userId)).toBe(before);
    console.log(`transient failure → DLQ → refunded in ${Date.now() - t0}ms`);
  });

  test("balance ends where it started", async () => {
    // One real generation spent; both failures refunded.
    expect(await getBalance(db, userId)).toBe(STARTING_CREDITS - 1);
  });
});

async function waitForSettled(
  db: GenerationDeps["db"],
  designId: string,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const design = await getDesign(db, designId);
    if (
      design &&
      design.status !== DESIGN_STATUS.pending &&
      design.status !== DESIGN_STATUS.generating
    ) {
      return design;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`design ${designId} did not settle within ${timeoutMs}ms`);
}

async function jobTiming(pool: Pool, jobId: string) {
  const { rows } = await pool.query(
    `select extract(epoch from (started_on - created_on)) * 1000 as pickup,
            extract(epoch from (completed_on - started_on)) * 1000 as run
       from pgboss.job where id = $1`,
    [jobId],
  );
  const row = rows[0];
  return {
    pickupMs: row?.pickup != null ? Math.round(Number(row.pickup)) : null,
    runMs: row?.run != null ? Math.round(Number(row.run)) : null,
  };
}
