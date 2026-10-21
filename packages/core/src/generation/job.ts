import type { PgBoss } from "pg-boss";
import { eq } from "drizzle-orm";
import { type DbClient, schema } from "@wallop/db";
import { refundGeneration } from "../credits";
import {
  addDesignAsset,
  getDesign,
  getDesignAsset,
  markDesignFailed,
  markDesignGenerating,
  markDesignReady,
} from "../designs/designs";
import {
  ASPECT_RATIOS,
  ASSET_KIND,
  DESIGN_STATUS,
  type AspectRatio,
} from "../designs/constants";
import { cropToAspect } from "../images/crop";
import { ensureQueue } from "../jobs/queue";
import { JOBS, type PayloadOf } from "../jobs/registry";
import {
  ImageProviderError,
  type ImageProvider,
  type ImageResolution,
} from "../providers/types";
import { storageKeys } from "../storage/keys";
import type { Storage } from "../storage/types";
import {
  DEFAULT_GENERATION_RESOLUTION,
  GENERATION_CREDIT_COST,
  PROVIDER_ASPECT_RATIO,
  type GenerationParams,
} from "./constants";
import { buildGenerationPrompt } from "./prompt";

const { designs } = schema;

/** Injected so tests and the smoke can stub the provider or storage. */
export type GenerationDeps = {
  db: DbClient;
  provider: ImageProvider;
  storage: Storage;
};

export type GenerateOutcome =
  | { status: "ready"; designId: string; storageKey: string; width: number; height: number }
  | { status: "failed"; designId: string; reason: string; refunded: boolean }
  /** Already settled (redelivery, or a late attempt that lost a race). */
  | { status: "skipped"; designId: string; reason: string };

/**
 * Queue config. A user is watching a spinner, so: few retries, short fixed
 * delay, instant pickup.
 *
 * expireInSeconds is the per-attempt deadline. When it passes, pg-boss aborts
 * job.signal (which cancels the Gemini request client-side) and schedules
 * the retry. It must comfortably exceed a normal 1K call (~12-23s) or healthy
 * jobs get killed. Raise it per-job when 2K/4K lands.
 *
 * Worst case before the DLQ refunds: 3 attempts x 90s + 2 x 5s ≈ 4m40s.
 */
const GENERATE_QUEUE = {
  policy: "exclusive", // one queued-or-active job per singletonKey (designId)
  retryLimit: 2,
  retryDelay: 5,
  retryBackoff: false,
  expireInSeconds: 90,
  deadLetter: JOBS.generateImageFailed,
  notify: true,
} as const;

/**
 * More patient than the main queue: failing to refund is worse than failing
 * to generate. If even this exhausts, the design is still in flight and the
 * nightly reapStalledDesigns sweep refunds it.
 */
const GENERATE_DLQ = {
  retryLimit: 10,
  retryDelay: 5,
  retryBackoff: true,
  retryDelayMax: 300,
  notify: true,
} as const;

/** Generations are I/O-bound (waiting on the provider), so run several at once. */
const GENERATE_CONCURRENCY = 4;

/**
 * Long enough for the provider to pull the reference image down, with room
 * for a retry; short because it's a private-ish read URL handed to a third
 * party.
 */
const PARENT_URL_TTL_SECONDS = 10 * 60;

/**
 * NOTIFY only fires when a job is INSERTED. A retry (deferred by retryDelay)
 * and a dead-letter copy are not inserts by `send`, so they're only picked up
 * by polling — and with notify on, pg-boss's poll fallback defaults to 30s.
 * Measured: 3 attempts + DLQ took ~90s at the default vs ~15s at 2s. Each
 * poll is one cheap indexed query per worker.
 */
const GENERATE_POLL_SECONDS = 2;

/** Split out so tests can create the queues without starting workers. */
export async function ensureGenerationQueues(boss: PgBoss) {
  // DLQ first: the main queue's deadLetter is a foreign key to it.
  await ensureQueue(boss, JOBS.generateImageFailed, GENERATE_DLQ);
  await ensureQueue(boss, JOBS.generateImage, GENERATE_QUEUE);
}

export async function registerGenerationHandlers(
  boss: PgBoss,
  deps: GenerationDeps,
) {
  await ensureGenerationQueues(boss);

  await boss.work<PayloadOf<typeof JOBS.generateImage>>(
    JOBS.generateImage,
    {
      batchSize: 1,
      localConcurrency: GENERATE_CONCURRENCY,
      notifyPollingIntervalSeconds: GENERATE_POLL_SECONDS,
      pollingIntervalSeconds: GENERATE_POLL_SECONDS,
    },
    async ([job]) => {
      if (!job) return;
      const outcome = await runGenerateImage(deps, job.data.designId, {
        signal: job.signal,
      });
      return outcome;
    },
  );

  await boss.work<PayloadOf<typeof JOBS.generateImageFailed>>(
    JOBS.generateImageFailed,
    {
      batchSize: 1,
      notifyPollingIntervalSeconds: GENERATE_POLL_SECONDS,
      pollingIntervalSeconds: GENERATE_POLL_SECONDS,
    },
    async ([job]) => {
      if (!job) return;
      const { designId } = job.data;
      const result = await failGeneration(deps.db, {
        designId,
        reason: "Generation failed after retries",
      });
      console.error(
        `[generate] ${designId} exhausted retries → failed, refunded=${result.refunded}`,
      );
      return result;
    },
  );
}

/**
 * The generate-image job body. Safe to run more than once for the same
 * design (retries, expiry overlap): every write is either idempotent or
 * guarded by the design's status under a row lock.
 *
 * Error contract:
 * - Terminal provider errors (moderation, invalid) → fail + refund here and
 *   RETURN, so the user gets an answer now instead of after the retries.
 * - Everything else THROWS → pg-boss retries → the DLQ fails + refunds.
 */
export async function runGenerateImage(
  deps: GenerationDeps,
  designId: string,
  options: { signal?: AbortSignal } = {},
): Promise<GenerateOutcome> {
  const { db, provider, storage } = deps;
  const { signal } = options;
  const started = Date.now();
  const log = (msg: string) =>
    console.log(`[generate] ${designId} +${Date.now() - started}ms ${msg}`);

  const design = await getDesign(db, designId);
  if (!design) {
    // Nothing to refund against — and no row means no spend committed either
    // (they share a transaction). Don't throw: retrying can't create it.
    log("design not found — skipping");
    return { status: "skipped", designId, reason: "design not found" };
  }
  if (!(await markDesignGenerating(db, designId))) {
    log(`already ${design.status} — skipping`);
    return { status: "skipped", designId, reason: `already ${design.status}` };
  }

  const aspectRatio = design.aspectRatio as AspectRatio;
  const target = ASPECT_RATIOS[aspectRatio];
  if (!target) {
    return terminal(`Unsupported aspect ratio "${design.aspectRatio}"`, false);
  }
  const params = (design.params ?? {}) as Partial<GenerationParams>;
  const resolution: ImageResolution =
    params.resolution ?? DEFAULT_GENERATION_RESOLUTION;
  const providerAspectRatio =
    params.providerAspectRatio ?? PROVIDER_ASPECT_RATIO[aspectRatio];

  // The reference image for an iteration. Signed HERE rather than at enqueue
  // time on purpose: a signed URL is short-lived, and this job can run minutes
  // later after retries or a queue backlog.
  let parentImageUrl: string | undefined;
  if (design.parentDesignId) {
    const parentAsset = await getDesignAsset(
      db,
      design.parentDesignId,
      ASSET_KIND.preview,
    );
    if (!parentAsset) {
      // enqueueGeneration refuses a parent without a preview, so this means
      // the asset vanished between enqueue and now. Failing is honest: the
      // user asked for an edit of a specific image and paid for one.
      return terminal(
        `Parent design ${design.parentDesignId} has no preview to iterate on`,
        false,
      );
    }
    parentImageUrl = await storage.getSignedUrl(
      parentAsset.storageKey,
      PARENT_URL_TTL_SECONDS,
    );
    log(`iterating on ${design.parentDesignId}`);
  }

  let result;
  try {
    result = await provider.generate({
      // Wrapped here, at send time. design.prompt stays the user's words.
      prompt: buildGenerationPrompt(design.prompt, {
        isEdit: Boolean(design.parentDesignId),
      }),
      aspectRatio: providerAspectRatio,
      resolution,
      parentImageUrl,
      signal,
    });
  } catch (err) {
    if (err instanceof ImageProviderError && !err.retryable) {
      log(`terminal provider error (${err.kind}): ${err.message}`);
      return terminal(err.message, err.kind === "moderation");
    }
    log(`transient error, will retry: ${errText(err)}`);
    throw err;
  }
  log(`generated ${result.mimeType} via ${result.model}`);

  const cropped = await cropToAspect(result.imageData, target.ratio, "webp");
  const storageKey = storageKeys.preview(designId);
  // Fixed key, so a retry overwrites rather than orphaning a second object.
  await storage.put({
    key: storageKey,
    body: cropped.data,
    contentType: cropped.mimeType,
  });
  log(`stored ${storageKey} (${cropped.width}x${cropped.height})`);

  // The job expired mid-flight: pg-boss has already failed this attempt and
  // a retry (or the DLQ) owns the design now. Don't race it.
  if (signal?.aborted) {
    throw new Error("Job expired before completion — not marking ready");
  }

  // Asset row + ready in one transaction under a row lock, so a retry that
  // overlaps can't insert a second preview row, and a design the DLQ has
  // already failed + refunded can't flip to ready.
  const completed = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ status: designs.status })
      .from(designs)
      .where(eq(designs.id, designId))
      .for("update");
    if (row?.status !== DESIGN_STATUS.generating) return row?.status ?? "missing";

    await addDesignAsset(tx, {
      designId,
      kind: ASSET_KIND.preview,
      storageKey,
      width: cropped.width,
      height: cropped.height,
    });
    await markDesignReady(tx, { designId, seed: result.seed, model: result.model });
    return null;
  });

  if (completed !== null) {
    log(`settled elsewhere as ${completed} — not marking ready`);
    return { status: "skipped", designId, reason: `already ${completed}` };
  }
  log("ready");
  return {
    status: "ready",
    designId,
    storageKey,
    width: cropped.width,
    height: cropped.height,
  };

  async function terminal(
    reason: string,
    moderationRejected: boolean,
  ): Promise<GenerateOutcome> {
    const { refunded } = await failGeneration(db, {
      designId,
      reason,
      moderationRejected,
    });
    return { status: "failed", designId, reason, refunded };
  }
}

/**
 * Mark a design failed and refund its credit — atomically, under a lock on
 * the design row. Called from the terminal path and from the DLQ, possibly
 * both for one design: safe, because
 *
 * - a design that reached `ready` is never failed or refunded (the user got
 *   their image), and
 * - refundGeneration is idempotent on refId, so a second refund is a no-op.
 *
 * Refund and status flip commit together: there's no window where the design
 * reads failed but the credit hasn't come back (the stalled-design reaper
 * only looks at in-flight designs, so it would never catch that case).
 */
export async function failGeneration(
  db: DbClient,
  params: { designId: string; reason: string; moderationRejected?: boolean },
): Promise<{ refunded: boolean }> {
  return db.transaction(async (tx) => {
    const [design] = await tx
      .select({ status: designs.status, ownerId: designs.ownerId })
      .from(designs)
      .where(eq(designs.id, params.designId))
      .for("update");

    if (!design || design.status === DESIGN_STATUS.ready) {
      return { refunded: false };
    }

    await markDesignFailed(tx, params);
    const { applied } = await refundGeneration(tx, {
      userId: design.ownerId,
      amount: GENERATION_CREDIT_COST,
      refId: params.designId,
    });
    return { refunded: applied };
  });
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
