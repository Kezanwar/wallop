import { NextResponse } from "next/server";
import {
  ASSET_KIND,
  DESIGN_STATUS,
  getBalance,
  getDesignAsset,
  getOwnedDesign,
  getStorage,
} from "@wallop/core";
import { getPooledDb } from "@wallop/db";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Comfortably outlives the poll loop that hands it to an <img>. */
const PREVIEW_URL_TTL_SECONDS = 15 * 60;

export type DesignStatusResponse = {
  status: string;
  /** Signed URL to the preview. Only present once status is `ready`. */
  previewUrl?: string;
  /** Saves the client a round trip after a refund. */
  balance: number;
};

/**
 * Polled by the generate page until the design settles.
 *
 * Deliberately uses getSession, not requireSession: this is fetched as JSON,
 * and requireSession's redirect to /login would hand the poller an HTML page
 * with a 200 on it. An expired session has to read as 401 here.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const db = getPooledDb();

  // Ownership is the whole point of this check: someone else's design id must
  // be indistinguishable from one that doesn't exist.
  const design = await getOwnedDesign(db, id, user.userId);
  if (!design) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const body: DesignStatusResponse = {
    status: design.status,
    balance: await getBalance(db, user.userId),
  };

  if (design.status === DESIGN_STATUS.ready) {
    // The asset row and the flip to `ready` commit in one transaction, so a
    // ready design always has its preview. Guarded anyway — the client shows
    // an error rather than hanging if that ever stops being true.
    const asset = await getDesignAsset(db, id, ASSET_KIND.preview);
    if (asset) {
      body.previewUrl = await getStorage().getSignedUrl(
        asset.storageKey,
        PREVIEW_URL_TTL_SECONDS,
      );
    }
  }

  return NextResponse.json(body, {
    headers: { "Cache-Control": "no-store" },
  });
}
