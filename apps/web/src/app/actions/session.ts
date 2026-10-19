"use server";
import { createDesignSession, AVAILABLE_ASPECT_RATIOS } from "@wallop/core";
import type { AspectRatio } from "@wallop/core";
import { getPooledDb } from "@wallop/db";
import { requireSession } from "@/lib/auth";

/**
 * Open a real design session row for the signed-in user. The row is the
 * thread a session's designs hang off — the designs grid will list by
 * sessionId, so this is never a throwaway client-side id.
 *
 * Portrait is the B1 default; the orientation picker is a later ticket.
 */
export async function startSessionAction(input?: {
  aspectRatio?: AspectRatio;
}): Promise<{ sessionId: string }> {
  const user = await requireSession();

  // Server Actions accept arbitrary client input, whatever the TS type says.
  const requested = input?.aspectRatio;
  const aspectRatio: AspectRatio =
    requested && AVAILABLE_ASPECT_RATIOS.includes(requested)
      ? requested
      : "portrait";

  const session = await createDesignSession(getPooledDb(), {
    userId: user.userId,
    aspectRatio,
  });
  return { sessionId: session.id };
}
