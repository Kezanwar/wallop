import { notFound } from "next/navigation";
import {
  getDesignSession,
  getStorage,
  listSessionDesignsWithPreview,
} from "@wallop/core";
import { getPooledDb } from "@wallop/db";
import { requireSession } from "@/lib/auth";
import { isUuid } from "@/lib/uuid";
import { Session, type DesignItem } from "../session";

export const dynamic = "force-dynamic";

/** Comfortably outlives a sitting at the page; matches the status route. */
const PREVIEW_URL_TTL_SECONDS = 15 * 60;

export default async function SessionPage({
  params,
}: {
  params: Promise<{ uuid: string }>;
}) {
  const user = await requireSession();
  const { uuid } = await params;
  if (!isUuid(uuid)) notFound();
  const db = getPooledDb();

  // getDesignSession is scoped by userId, so a stranger's session reads as
  // not found. Same posture as the status route: someone else's id must be
  // indistinguishable from one that never existed.
  const session = await getDesignSession(db, uuid, user.userId);
  if (!session) notFound();

  // The balance comes from the (app) layout's BalanceProvider, so this page
  // doesn't read it — one source, no two-number mismatch.
  const rows = await listSessionDesignsWithPreview(db, session.id);

  // Loading the thread from the DB is the point of this page: designs used to
  // live only in client state, so a refresh or a return visit lost them.
  const storage = getStorage();
  const designs: DesignItem[] = await Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      prompt: row.prompt,
      status: row.status,
      previewUrl: row.previewKey
        ? await storage.getSignedUrl(row.previewKey, PREVIEW_URL_TTL_SECONDS)
        : null,
    })),
  );

  return (
    <div>
      <h1 className="mb-8 text-2xl font-medium tracking-tight">
        {session.title ?? "Untitled piece"}
      </h1>
      <Session sessionId={session.id} initialDesigns={designs} />
    </div>
  );
}
