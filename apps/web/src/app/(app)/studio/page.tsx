import Link from "next/link";
import { listUserSessions } from "@wallop/core";
import { getPooledDb } from "@wallop/db";
import { requireSession } from "@/lib/auth";
import { newPieceAction } from "@/app/actions/session";

export const dynamic = "force-dynamic";

const dateFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

export default async function StudioPage() {
  const user = await requireSession();
  const sessions = await listUserSessions(getPooledDb(), user.userId);

  return (
    <div className="max-w-xl">
      <div className="mb-8 flex items-center justify-between gap-4">
        <h1 className="text-2xl font-medium tracking-tight">Studio</h1>
        <form action={newPieceAction}>
          <button className="rounded bg-white px-4 py-2 text-sm font-medium text-black">
            New piece
          </button>
        </form>
      </div>

      {sessions.length === 0 ? (
        <p className="text-sm text-muted">No pieces yet — start one.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {sessions.map((session) => (
            <li key={session.id}>
              <Link
                href={`/session/${session.id}`}
                className="block rounded border border-border px-4 py-3 hover:bg-white/5"
              >
                <span className="text-sm">
                  {session.title ?? "Untitled piece"}
                </span>
                <span className="block text-xs text-muted">
                  {dateFormat.format(session.createdAt)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
