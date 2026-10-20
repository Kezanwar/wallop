"use server";
import {
  enqueueGeneration,
  isValidRequestId,
  InsufficientCreditsError,
  InvalidGenerationRequestError,
  SessionNotFoundError,
} from "@wallop/core";
import { getPooledDb } from "@wallop/db";
import { requireSession } from "@/lib/auth";
import { queue } from "@/lib/queue";

export type GenerateDesignResult =
  | {
      ok: true;
      designId: string;
      balance: number;
      /** This requestId was already handled — same design, no new charge. */
      duplicate: boolean;
    }
  | {
      ok: false;
      error: "insufficient_credits" | "invalid_request" | "session_not_found";
      message: string;
    };

/**
 * Charge one credit and queue a generation. Returns as soon as the job is
 * queued — the design starts `pending`; how the client learns it's ready is
 * a later ticket.
 *
 * `requestId` is REQUIRED: a UUID the browser mints ONCE per intended
 * generation (crypto.randomUUID() when the user commits to "generate", kept
 * until that generation is acknowledged) and re-sends on any double-click or
 * retry. Re-sending it returns the same design without charging again.
 * There is deliberately no server-side fallback — inventing a key here would
 * give every resubmit a new one and reopen the double charge.
 */
export async function generateDesignAction(input: {
  sessionId: string;
  /**
   * Iterate on this design — its preview becomes the reference image. Core
   * verifies it belongs to this user AND this session, and refuses an
   * unusable one the same way it refuses a nonexistent one, so a probe
   * learns nothing either way.
   */
  parentDesignId?: string;
  prompt: string;
  requestId: string;
}): Promise<GenerateDesignResult> {
  const session = await requireSession();

  // Server Actions accept arbitrary client input, whatever the TS type says.
  if (!isValidRequestId(input?.requestId)) {
    return {
      ok: false,
      error: "invalid_request",
      message: "requestId is required and must be a UUID",
    };
  }

  try {
    const { designId, balanceAfter, duplicate } = await enqueueGeneration(
      getPooledDb(),
      await queue(),
      {
        userId: session.userId,
        sessionId: input.sessionId,
        parentDesignId: input.parentDesignId,
        prompt: input.prompt,
        requestId: input.requestId,
      },
    );
    return { ok: true, designId, balance: balanceAfter, duplicate };
  } catch (err) {
    if (err instanceof InsufficientCreditsError) {
      return { ok: false, error: "insufficient_credits", message: err.message };
    }
    if (err instanceof InvalidGenerationRequestError) {
      return { ok: false, error: "invalid_request", message: err.message };
    }
    if (err instanceof SessionNotFoundError) {
      return { ok: false, error: "session_not_found", message: err.message };
    }
    throw err;
  }
}
