import type { PgBoss } from "pg-boss";
import type { DbClient } from "@wallop/db";
import { spendCredits } from "../credits";
import {
  createPendingDesign,
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
    /** Defaults to the configured provider model. */
    model?: string;
  },
): Promise<{ designId: string; jobId: string; balanceAfter: number }> {
  const prompt = params.prompt.trim();
  if (!prompt) throw new InvalidGenerationRequestError("Prompt is empty");
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new InvalidGenerationRequestError(
      `Prompt is longer than ${MAX_PROMPT_LENGTH} characters`,
    );
  }

  return db.transaction(async (tx) => {
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

    const design = await createPendingDesign(tx, {
      sessionId: session.id,
      ownerId: params.userId,
      prompt,
      model: params.model ?? resolveImageModel(),
      aspectRatio,
      params: generationParams,
    });

    // Locks the user row FOR UPDATE until this transaction ends, so
    // concurrent generations by the same user serialise on the balance.
    const { balanceAfter } = await spendCredits(tx, {
      userId: params.userId,
      amount: GENERATION_CREDIT_COST,
      reason: "generation_spend",
      refId: design.id,
    });

    // singletonKey + the queue's `exclusive` policy: at most one queued or
    // active job per design. Note this dedupes re-enqueues of the SAME design
    // — a double-click creates two designs, each with its own key.
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

    return { designId: design.id, jobId, balanceAfter };
  });
}
