"use server";
import {
  createSessionAndEnqueueGeneration,
  isValidRequestId,
  InsufficientCreditsError,
  InvalidGenerationRequestError,
} from "@wallop/core";
import { getPooledDb } from "@wallop/db";
import { requireSession } from "@/lib/auth";
import { queue } from "@/lib/queue";

export type StartPieceResult =
  | {
      ok: true;
      sessionId: string;
      designId: string;
      balance: number;
      duplicate: boolean;
    }
  | {
      ok: false;
      error: "insufficient_credits" | "invalid_request";
      message: string;
    };

/**
 * The first generation of a new piece. Creating the session and generating
 * into it is one atomic step, so backing out of /session/new without
 * generating — or being refused for want of credits — leaves no empty
 * session in the studio.
 *
 * requestId is the client's, exactly as in generateDesignAction: minted once
 * per intended generation, with no server-side fallback. A double-clicked
 * first generate returns the same session and design rather than opening two.
 *
 * Portrait is the default; the orientation picker is a later ticket.
 */
export async function startPieceAction(input: {
  prompt: string;
  requestId: string;
}): Promise<StartPieceResult> {
  const user = await requireSession();

  // Server Actions accept arbitrary client input, whatever the TS type says.
  if (!isValidRequestId(input?.requestId)) {
    return {
      ok: false,
      error: "invalid_request",
      message: "requestId is required and must be a UUID",
    };
  }

  try {
    const { sessionId, designId, balanceAfter, duplicate } =
      await createSessionAndEnqueueGeneration(getPooledDb(), await queue(), {
        userId: user.userId,
        aspectRatio: "portrait",
        prompt: input.prompt,
        requestId: input.requestId,
      });
    return { ok: true, sessionId, designId, balance: balanceAfter, duplicate };
  } catch (err) {
    if (err instanceof InsufficientCreditsError) {
      return { ok: false, error: "insufficient_credits", message: err.message };
    }
    if (err instanceof InvalidGenerationRequestError) {
      return { ok: false, error: "invalid_request", message: err.message };
    }
    throw err;
  }
}
