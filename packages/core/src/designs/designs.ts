import { and, desc, eq, inArray, lt } from "drizzle-orm";
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

/**
 * A user's sessions, newest first — the studio list. Scoped by userId, so
 * there is no unscoped "all sessions" variant to reach for by mistake.
 * Ordered by id, not createdAt: ids are uuidv7, so they sort by creation
 * time anyway and ties can't scramble (two sessions opened in the same
 * millisecond would otherwise come back in arbitrary order).
 */
export async function listUserSessions(db: Db, userId: string) {
  return db
    .select()
    .from(designSessions)
    .where(eq(designSessions.userId, userId))
    .orderBy(desc(designSessions.id));
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

// Status transitions are guarded: each only moves a design that is still
// in flight. A job retry, a late-finishing expired attempt and the DLQ can
// all touch the same design, and none of them may move it backwards (e.g. a
// delivered `ready` design to `failed`). Each returns whether it applied.
const IN_FLIGHT = [DESIGN_STATUS.pending, DESIGN_STATUS.generating];

/**
 * createPendingDesign, made idempotent on (ownerId, requestId) by the
 * designs_owner_request_idx unique index. Returns null when that key already
 * has a design — the caller must then NOT spend or enqueue.
 *
 * Concurrency comes from Postgres, not from a check-then-insert: if another
 * transaction has inserted the same key but not yet committed, this INSERT
 * waits for it. It commits → we get null (ON CONFLICT DO NOTHING); it rolls
 * back → our insert goes ahead. Either way exactly one design per key.
 */
export async function claimPendingDesign(
  db: Db,
  params: Parameters<typeof createPendingDesign>[1] & { requestId: string },
) {
  const [design] = await db
    .insert(designs)
    .values({
      sessionId: params.sessionId,
      messageId: params.messageId,
      parentDesignId: params.parentDesignId,
      ownerId: params.ownerId,
      requestId: params.requestId,
      prompt: params.prompt,
      model: params.model,
      aspectRatio: params.aspectRatio,
      params: params.params,
      status: DESIGN_STATUS.pending,
    })
    .onConflictDoNothing({ target: [designs.ownerId, designs.requestId] })
    .returning();
  return design ?? null;
}

export async function getDesignByRequestId(
  db: Db,
  ownerId: string,
  requestId: string,
) {
  const [design] = await db
    .select()
    .from(designs)
    .where(and(eq(designs.ownerId, ownerId), eq(designs.requestId, requestId)));
  return design ?? null;
}

export async function markDesignGenerating(db: Db, designId: string) {
  const rows = await db
    .update(designs)
    .set({ status: DESIGN_STATUS.generating })
    .where(and(eq(designs.id, designId), inArray(designs.status, IN_FLIGHT)))
    .returning({ id: designs.id });
  return rows.length > 0;
}

export async function markDesignReady(
  db: Db,
  params: { designId: string; seed?: string; model?: string },
) {
  const rows = await db
    .update(designs)
    .set({
      status: DESIGN_STATUS.ready,
      seed: params.seed,
      // The exact served revision, replacing the alias requested at enqueue.
      ...(params.model ? { model: params.model } : {}),
    })
    .where(
      and(eq(designs.id, params.designId), inArray(designs.status, IN_FLIGHT)),
    )
    .returning({ id: designs.id });
  return rows.length > 0;
}

export async function markDesignFailed(
  db: Db,
  params: { designId: string; reason: string; moderationRejected?: boolean },
) {
  const rows = await db
    .update(designs)
    .set({
      status: params.moderationRejected
        ? DESIGN_STATUS.moderationRejected
        : DESIGN_STATUS.failed,
      failureReason: params.reason,
    })
    .where(
      and(eq(designs.id, params.designId), inArray(designs.status, IN_FLIGHT)),
    )
    .returning({ id: designs.id });
  return rows.length > 0;
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

/**
 * The newest asset of a kind for a design. Ordered because a design can in
 * principle collect more than one (a re-crop, a second print SKU); the job
 * writes previews under a fixed key, so today there is only ever one.
 */
export async function getDesignAsset(
  db: Db,
  designId: string,
  kind: "preview" | "print" | "mockup",
) {
  const [asset] = await db
    .select()
    .from(designAssets)
    .where(
      and(eq(designAssets.designId, designId), eq(designAssets.kind, kind)),
    )
    .orderBy(desc(designAssets.createdAt))
    .limit(1);
  return asset ?? null;
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
