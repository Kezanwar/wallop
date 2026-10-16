"use server";
import {
  enqueueGeneration,
  InsufficientCreditsError,
  InvalidGenerationRequestError,
  SessionNotFoundError,
} from "@wallop/core";
import { getPooledDb } from "@wallop/db";
import { requireSession } from "@/lib/auth";
import { queue } from "@/lib/queue";

export type GenerateDesignResult =
  | { ok: true; designId: string; balance: number }
  | {
      ok: false;
      error: "insufficient_credits" | "invalid_request" | "session_not_found";
      message: string;
    };

/**
 * Charge one credit and queue a generation. Returns as soon as the job is
 * queued — the design starts `pending`; how the client learns it's ready is
 * a later ticket.
 */
export async function generateDesignAction(input: {
  sessionId: string;
  prompt: string;
}): Promise<GenerateDesignResult> {
  const session = await requireSession();

  try {
    const { designId, balanceAfter } = await enqueueGeneration(
      getPooledDb(),
      await queue(),
      {
        userId: session.userId,
        sessionId: input.sessionId,
        prompt: input.prompt,
      },
    );
    return { ok: true, designId, balance: balanceAfter };
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
