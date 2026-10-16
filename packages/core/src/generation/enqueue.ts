import type { PgBoss } from "pg-boss";
import { eq } from "drizzle-orm";
import { type DbClient, schema } from "@wallop/db";
import { getBalance, spendCredits, UserNotFoundError } from "../credits";
import {
  claimPendingDesign,
  getDesignByRequestId,
  getDesignSession,
  SessionNotFoundError,
} from "../designs/designs";
import { AVAILABLE_ASPECT_RATIOS, type AspectRatio } from "../designs/constants";
import { enqueueInTransaction } from "../jobs/queue";
import { JOBS } from "../jobs/registry";
import { resolveImageModel } from "../providers";
import {
  DEFAULT_GENERATION_RESOLUTION,
  GENERATION_CREDIT_COST,
  MAX_PROMPT_LENGTH,
  PROVIDER_ASPECT_RATIO,
  type GenerationParams,
} from "./constants";

export class InvalidGenerationRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidGenerationRequestError";
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidRequestId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** The ledger key for a generation spend. Namespaced by user, like the index. */
export function generationSpendKey(userId: string, requestId: string) {
  return `generation_spend:${userId}:${requestId}`;
}

/**
 * Start a generation: create the pending design, charge for it, and enqueue
 * the job — in ONE transaction. All three commit or none do:
 *
 * - Crash after the spend but before the enqueue → nothing committed, so the
 *   user is never charged for a job that will never run.
 * - Insufficient credits → spendCredits throws InsufficientCreditsError, the
 *   transaction rolls back, and the design row never exists.
 * - pg-boss declines the insert (returns null) → we throw, same rollback.
 *
 * The job runs only after commit (pg-boss can't see the row before then), so
 * the worker never races ahead of the design or the spend.
 *
 * IDEMPOTENT on `requestId` — a UUID the CLIENT mints once per intended
 * generation. A double-click sends the same requestId twice; the second call
 * creates nothing, spends nothing, and returns the first call's design with
 * `duplicate: true`. It is required and never generated here: a server-side
 * fallback would give every retry a fresh key and reopen the double charge.
 *
 * Ordering is what makes this race-free:
 *   0. Lock the user row FOR UPDATE — first, before anything else. The
 *      design INSERT takes a FOR KEY SHARE lock on the user row (its FK) and
 *      the spend then wants FOR UPDATE on it; two concurrent enqueues each
 *      holding KEY SHARE while waiting for UPDATE is a deadlock (measured:
 *      Postgres aborting one victim per second under 20-way load). Taking
 *      the strongest lock up front gives every enqueue for a user the same
 *      lock order. This is ordering, not the double-click guard — that's 1+2.
 *   1. INSERT the design ON CONFLICT (owner_id, request_id) DO NOTHING.
 *      A concurrent request with the same key blocks on the unique index
 *      until the first transaction ends; only one can ever win the insert.
 *   2. Only the winner spends — and the spend carries an idempotency key
 *      derived from requestId, so the ledger's own unique constraint is a
 *      second, independent guard against a double charge.
 *   3. Only the winner enqueues.
 * Losers (step 1 returned nothing) read back the winner's committed design.
 *
 * Throws: SessionNotFoundError (not this user's session),
 * InvalidGenerationRequestError, InsufficientCreditsError.
 */
export async function enqueueGeneration(
  db: DbClient,
  boss: PgBoss,
  params: {
    userId: string;
    sessionId: string;
    prompt: string;
    /** Client-generated UUID, one per intended generation. Required. */
    requestId: string;
    /** Defaults to the configured provider model. */
    model?: string;
  },
): Promise<{
  designId: string;
  /** Null on a duplicate — the original request's job is already queued. */
  jobId: string | null;
  balanceAfter: number;
  /** True when this requestId had already been handled; nothing was charged. */
  duplicate: boolean;
}> {
  if (!isValidRequestId(params.requestId)) {
    throw new InvalidGenerationRequestError("requestId must be a UUID");
  }
  const { requestId } = params;
  const prompt = params.prompt.trim();
  if (!prompt) throw new InvalidGenerationRequestError("Prompt is empty");
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new InvalidGenerationRequestError(
      `Prompt is longer than ${MAX_PROMPT_LENGTH} characters`,
    );
  }

  return db.transaction(async (tx) => {
    // Step 0: see the ordering note above.
    const [user] = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.id, params.userId))
      .for("update");
    if (!user) throw new UserNotFoundError(params.userId);

    // Ownership check inside the transaction — getDesignSession filters by
    // userId, so another user's session id reads as not found.
    const session = await getDesignSession(tx, params.sessionId, params.userId);
    if (!session) throw new SessionNotFoundError(params.sessionId);

    const aspectRatio = session.aspectRatio as AspectRatio;
    if (!AVAILABLE_ASPECT_RATIOS.includes(aspectRatio)) {
      throw new InvalidGenerationRequestError(
        `Aspect ratio "${session.aspectRatio}" is not available`,
      );
    }

    const generationParams: GenerationParams = {
      resolution: DEFAULT_GENERATION_RESOLUTION,
      providerAspectRatio: PROVIDER_ASPECT_RATIO[aspectRatio],
    };

    // Step 1: claim the requestId. See the ordering note above.
    const design = await claimPendingDesign(tx, {
      sessionId: session.id,
      ownerId: params.userId,
      requestId,
      prompt,
      model: params.model ?? resolveImageModel(),
      aspectRatio,
      params: generationParams,
    });

    if (!design) {
      // Duplicate. The winner has committed (we waited for it — on the user
      // lock, or on the unique index if that lock were ever removed), so its
      // design is visible to this new statement.
      const existing = await getDesignByRequestId(tx, params.userId, requestId);
      if (!existing) {
        throw new Error(`requestId ${requestId} conflicted but no design found`);
      }
      // Same key, different request = a client bug. Refuse rather than hand
      // back a design for a prompt the user didn't just submit.
      if (existing.sessionId !== session.id || existing.prompt !== prompt) {
        throw new InvalidGenerationRequestError(
          "requestId was already used for a different generation request",
        );
      }
      return {
        designId: existing.id,
        jobId: null,
        balanceAfter: await getBalance(tx, params.userId),
        duplicate: true,
      };
    }

    // Step 2: only the winner spends (its FOR UPDATE re-takes the lock this
    // transaction already holds).
    const spend = await spendCredits(tx, {
      userId: params.userId,
      amount: GENERATION_CREDIT_COST,
      reason: "generation_spend",
      refId: design.id,
      idempotencyKey: generationSpendKey(params.userId, requestId),
    });
    if (!spend.applied) {
      // We just created this design, so its spend can't exist yet. If the
      // ledger says otherwise, something is badly wrong — roll it all back
      // rather than deliver a design with no charge attached.
      throw new Error(
        `Spend for requestId ${requestId} already exists but its design did not — rolling back`,
      );
    }

    // Step 3. singletonKey + the queue's `exclusive` policy: at most one
    // queued or active job per design (the double-click guard is requestId,
    // above — this one catches re-enqueues of the same design).
    const jobId = await enqueueInTransaction(
      boss,
      tx,
      JOBS.generateImage,
      { designId: design.id },
      { singletonKey: design.id },
    );
    if (!jobId) {
      throw new Error(
        `generate-image job was not created for design ${design.id} — rolling back the spend`,
      );
    }

    return {
      designId: design.id,
      jobId,
      balanceAfter: spend.balanceAfter,
      duplicate: false,
    };
  });
}
