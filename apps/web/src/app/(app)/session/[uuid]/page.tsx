import { notFound } from "next/navigation";
import { getBalance, getDesignSession } from "@wallop/core";
import { getPooledDb } from "@wallop/db";
import { requireSession } from "@/lib/auth";
import { isUuid } from "@/lib/uuid";
import { Session } from "./session";

export const dynamic = "force-dynamic";

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

  const balance = await getBalance(db, user.userId);

  return (
    <div className="max-w-xl">
      <h1 className="mb-6 text-2xl font-medium tracking-tight">
        {session.title ?? "Untitled piece"}
      </h1>
      <Session sessionId={session.id} initialBalance={balance} />
    </div>
  );
}
