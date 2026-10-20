import { requireSession } from "@/lib/auth";
import { Session } from "../session";

export const dynamic = "force-dynamic";

/**
 * A blank piece. No design_sessions row exists yet and none is created until
 * the first generate succeeds, so backing out from here leaves nothing behind
 * and the studio only ever lists real work.
 *
 * A static segment, so it wins over [uuid] — "/session/new" never reaches the
 * uuid route.
 */
export default async function NewSessionPage() {
  await requireSession();

  return (
    <div>
      <h1 className="mb-8 text-2xl font-medium tracking-tight">New piece</h1>
      <Session sessionId={null} initialDesigns={[]} />
    </div>
  );
}
