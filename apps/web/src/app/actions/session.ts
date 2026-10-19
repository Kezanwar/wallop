"use server";
import { redirect } from "next/navigation";
import { createDesignSession } from "@wallop/core";
import { getPooledDb } from "@wallop/db";
import { requireSession } from "@/lib/auth";

/**
 * Open a new piece and go straight into it. The session is a real
 * design_sessions row — the designs generated inside it hang off its id,
 * which is what makes the studio list and the per-session view possible.
 *
 * Portrait is the default; the orientation picker is a later ticket.
 */
export async function newPieceAction() {
  const user = await requireSession();
  const session = await createDesignSession(getPooledDb(), {
    userId: user.userId,
    aspectRatio: "portrait",
  });
  redirect(`/session/${session.id}`);
}
