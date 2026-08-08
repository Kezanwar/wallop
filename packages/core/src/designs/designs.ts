import { and, eq, inArray, lt } from "drizzle-orm";
import { type DbClient, type DbTransaction, schema } from "@wallop/db";
import { DESIGN_STATUS, VISIBILITY, type AspectRatio } from "./constants";

const { designSessions, sessionMessages, designs, designAssets } = schema;

type Db = DbClient | DbTransaction;

export class SessionNotFoundError extends Error {
  constructor(readonly sessionId: string) {
    super(`Design session not found: ${sessionId}`);
    this.name = "SessionNotFoundError";
  }
}

export async function createDesignSession(
  db: Db,
  params: { userId: string; aspectRatio: AspectRatio },
) {
  const [session] = await db
    .insert(designSessions)
    .values({ userId: params.userId, aspectRatio: params.aspectRatio })
    .returning();
  return session!;
}

export async function getDesignSession(
  db: Db,
  sessionId: string,
  userId: string,
) {
  const [session] = await db
    .select()
    .from(designSessions)
    .where(
      and(eq(designSessions.id, sessionId), eq(designSessions.userId, userId)),
    );
  return session ?? null;
}

export async function addSessionMessage(
  db: Db,
  params: {
    sessionId: string;
    role: "user" | "assistant";
    content: string;
    creditsSpent?: number;
  },
) {
  const [message] = await db
    .insert(sessionMessages)
    .values({
      sessionId: params.sessionId,
      role: params.role,
      content: params.content,
      creditsSpent: params.creditsSpent ?? 0,
    })
    .returning();
  return message!;
}

/**
 * Created BEFORE generation starts, at status `pending`, so the UI has
 * something to render a spinner against and the job has a stable id to
 * use as the credit refId.
 */
export async function createPendingDesign(
  db: Db,
  params: {
    sessionId: string;
    messageId?: string;
    parentDesignId?: string;
    ownerId: string;
    prompt: string;
    model: string;
    aspectRatio: AspectRatio;
    params?: Record<string, unknown>;
  },
) {
  const [design] = await db
    .insert(designs)
    .values({
      sessionId: params.sessionId,
      messageId: params.messageId,
      parentDesignId: params.parentDesignId,
      ownerId: params.ownerId,
      prompt: params.prompt,
      model: params.model,
      aspectRatio: params.aspectRatio,
      params: params.params,
      status: DESIGN_STATUS.pending,
    })
    .returning();
  return design!;
}

export async function markDesignGenerating(db: Db, designId: string) {
  await db
    .update(designs)
    .set({ status: DESIGN_STATUS.generating })
    .where(eq(designs.id, designId));
}

export async function markDesignReady(
  db: Db,
  params: { designId: string; seed?: string },
) {
  await db
    .update(designs)
    .set({ status: DESIGN_STATUS.ready, seed: params.seed })
    .where(eq(designs.id, params.designId));
}

export async function markDesignFailed(
  db: Db,
  params: { designId: string; reason: string; moderationRejected?: boolean },
) {
  await db
    .update(designs)
    .set({
      status: params.moderationRejected
        ? DESIGN_STATUS.moderationRejected
        : DESIGN_STATUS.failed,
      failureReason: params.reason,
    })
    .where(eq(designs.id, params.designId));
}

export async function addDesignAsset(
  db: Db,
  params: {
    designId: string;
    kind: "preview" | "print" | "mockup";
    storageKey: string;
    width: number;
    height: number;
  },
) {
  const [asset] = await db.insert(designAssets).values(params).returning();
  return asset!;
}

export async function getDesign(db: Db, designId: string) {
  const [design] = await db
    .select()
    .from(designs)
    .where(eq(designs.id, designId));
  return design ?? null;
}

/** Ownership check belongs here, not in the caller. */
export async function getOwnedDesign(db: Db, designId: string, userId: string) {
  const [design] = await db
    .select()
    .from(designs)
    .where(and(eq(designs.id, designId), eq(designs.ownerId, userId)));
  return design ?? null;
}

export async function listSessionDesigns(db: Db, sessionId: string) {
  return db
    .select()
    .from(designs)
    .where(eq(designs.sessionId, sessionId))
    .orderBy(designs.createdAt);
}

export async function setDesignKept(
  db: Db,
  params: { designId: string; userId: string; isKept: boolean },
) {
  await db
    .update(designs)
    .set({ isKept: params.isKept })
    .where(
      and(eq(designs.id, params.designId), eq(designs.ownerId, params.userId)),
    );
}

/**
 * Backstop for designs stranded at pending/generating — a worker that died
 * after the DLQ handler also exhausted its retries. Returns the rows so the
 * caller can refund each one (refundGeneration is idempotent on refId, so
 * double-refunding is safe).
 */
export async function reapStalledDesigns(
  db: DbClient,
  olderThanMs = 60 * 60 * 1000,
) {
  const cutoff = new Date(Date.now() - olderThanMs);

  return db
    .update(designs)
    .set({
      status: DESIGN_STATUS.failed,
      failureReason: "Timed out — no result recorded",
    })
    .where(
      and(
        inArray(designs.status, [
          DESIGN_STATUS.pending,
          DESIGN_STATUS.generating,
        ]),
        lt(designs.createdAt, cutoff),
      ),
    )
    .returning({ id: designs.id, ownerId: designs.ownerId });
}
