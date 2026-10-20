"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { generateDesignAction } from "@/app/actions/generate";
import { startPieceAction } from "@/app/actions/session";

const POLL_MS = 1500;
/** Generation is ~10s; this is the "something is wrong" ceiling, not a target. */
const POLL_TIMEOUT_MS = 90_000;

/** Synthetic, client-only: the DB never holds this. */
const TIMED_OUT = "timed_out";

export type DesignItem = {
  id: string;
  prompt: string;
  status: string;
  previewUrl?: string | null;
};

type StatusResponse = {
  status: string;
  previewUrl?: string;
  balance: number;
};

const IN_FLIGHT = ["pending", "generating"];

function statusNote(item: DesignItem): string | null {
  if (IN_FLIGHT.includes(item.status)) return "generating…";
  if (item.status === "failed" || item.status === "moderation_rejected") {
    return "Generation failed — your credit was refunded.";
  }
  if (item.status === TIMED_OUT) {
    return "Still not done after 90s. It may yet finish — reload to check.";
  }
  if (item.status === "ready" && !item.previewUrl) {
    return "Generated, but the preview is missing.";
  }
  return null;
}

export function Session({
  sessionId,
  initialBalance,
  initialDesigns,
}: {
  /** Null on /session/new — the session row doesn't exist until first generate. */
  sessionId: string | null;
  initialBalance: number;
  initialDesigns: DesignItem[];
}) {
  const router = useRouter();

  const [sid, setSid] = useState(sessionId);
  const [items, setItems] = useState<DesignItem[]>(initialDesigns);
  const [prompt, setPrompt] = useState("");
  const [balance, setBalance] = useState(initialBalance);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);

  /**
   * One requestId per intended generation. Minted on submit and held until
   * that generation is accepted, so clicking Generate again after a network
   * error re-sends the SAME key and the server returns the original design
   * instead of charging twice. Cleared once accepted, on a typed error, and
   * whenever the prompt changes — a different prompt is a different
   * generation. Never defaulted server-side.
   */
  const requestIdRef = useRef<string | null>(null);

  /**
   * Synchronous double-submit guard. `submitting` disables the button, but
   * React state lands after the event, so two clicks in the same tick would
   * both get through. The server's requestId guard is the real defence; this
   * stops the pointless second round trip.
   */
  const inFlightRef = useRef(false);

  const mountedRef = useRef(true);
  /** Design ids with a poll loop already running, so none is polled twice. */
  const pollingRef = useRef<Set<string>>(new Set());
  const nodeRefs = useRef(new Map<string, HTMLDivElement>());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const patch = useCallback((id: string, next: Partial<DesignItem>) => {
    setItems((prev) =>
      prev.map((it) => (it.id === id ? { ...it, ...next } : it)),
    );
  }, []);

  const pollDesign = useCallback(
    async (designId: string) => {
      if (pollingRef.current.has(designId)) return;
      pollingRef.current.add(designId);
      const deadline = Date.now() + POLL_TIMEOUT_MS;

      try {
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, POLL_MS));
          if (!mountedRef.current) return;

          let body: StatusResponse;
          try {
            const res = await fetch(`/api/designs/${designId}/status`, {
              cache: "no-store",
            });
            if (!res.ok) throw new Error(String(res.status));
            body = await res.json();
          } catch {
            continue; // a blip shouldn't kill the loop; the deadline bounds it
          }
          if (!mountedRef.current) return;

          setBalance(body.balance);
          patch(designId, {
            status: body.status,
            previewUrl: body.previewUrl ?? null,
          });

          if (!IN_FLIGHT.includes(body.status)) {
            router.refresh(); // keep the sidebar balance honest
            return;
          }
        }

        // Timed out. Deliberately NOT claiming a refund: the job may well
        // still be running, and the credit only comes back when it fails.
        if (mountedRef.current) patch(designId, { status: TIMED_OUT });
      } finally {
        pollingRef.current.delete(designId);
      }
    },
    [patch, router],
  );

  // Anything still in flight when the page loaded — a generation that was
  // running when the user navigated away, or refreshed — picks its poll back
  // up. This is what makes a reload mid-generation recover rather than hang.
  useEffect(() => {
    for (const item of initialDesigns) {
      if (IN_FLIGHT.includes(item.status)) void pollDesign(item.id);
    }
  }, [initialDesigns, pollDesign]);

  function appendItem(item: DesignItem) {
    setItems((prev) =>
      prev.some((i) => i.id === item.id) ? prev : [...prev, item],
    );
  }

  function failed(error: string, fallback: string) {
    requestIdRef.current = null;
    if (error === "insufficient_credits") setMessage("You're out of credits.");
    else if (error === "session_not_found") {
      setMessage("Your design session expired. Reload the page.");
    } else setMessage(fallback);
  }

  async function onGenerate() {
    if (inFlightRef.current) return;
    const text = prompt.trim();
    if (!text) {
      setMessage("Type a prompt first.");
      return;
    }

    inFlightRef.current = true;
    setSubmitting(true);
    setMessage(null);

    // Minted here, once, and reused if this same generation is retried.
    requestIdRef.current ??= crypto.randomUUID();

    try {
      if (sid === null) {
        const result = await startPieceAction({
          prompt: text,
          requestId: requestIdRef.current,
        });
        if (!result.ok) return failed(result.error, result.message);

        setSid(result.sessionId);
        setBalance(result.balance);
        // Swap the URL in place rather than navigating: a real route change
        // would unmount this component and drop the generation that is
        // already in flight, which is the blank-flash we're avoiding. A hard
        // reload from here lands on the real session and loads it from the DB.
        window.history.replaceState(null, "", `/session/${result.sessionId}`);
        appendItem({ id: result.designId, prompt: text, status: "pending" });
        setPrompt("");
        requestIdRef.current = null;
        void pollDesign(result.designId);
        return;
      }

      const result = await generateDesignAction({
        sessionId: sid,
        prompt: text,
        requestId: requestIdRef.current,
      });
      if (!result.ok) return failed(result.error, result.message);

      setBalance(result.balance);
      appendItem({ id: result.designId, prompt: text, status: "pending" });
      setPrompt("");
      requestIdRef.current = null;
      void pollDesign(result.designId);
    } catch {
      // requestId is kept, so clicking Generate again resumes this same
      // generation rather than paying for a second one.
      setMessage("Couldn't reach the server. Try again.");
    } finally {
      inFlightRef.current = false;
      setSubmitting(false);
    }
  }

  function focusDesign(id: string) {
    setFocusedId(id);
    nodeRefs.current.get(id)?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  }

  const gallery = items.filter((i) => i.previewUrl);

  return (
    <div className="flex gap-8">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-col gap-8">
          {items.length === 0 && (
            <p className="text-sm text-muted">
              Describe the piece you want. It takes about ten seconds.
            </p>
          )}

          {items.map((item) => {
            const note = statusNote(item);
            return (
              <div
                key={item.id}
                ref={(node) => {
                  if (node) nodeRefs.current.set(item.id, node);
                  else nodeRefs.current.delete(item.id);
                }}
                className={`flex flex-col gap-3 rounded p-2 ${
                  focusedId === item.id ? "ring-1 ring-white/40" : ""
                }`}
              >
                <p className="text-sm text-muted">{item.prompt}</p>
                {item.previewUrl ? (
                  // Plain <img>: the src is a short-lived signed R2 URL, which
                  // would need the bucket host in next.config remotePatterns
                  // to pass through next/image.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={item.previewUrl}
                    alt={item.prompt}
                    className="max-w-sm rounded border border-border"
                  />
                ) : (
                  <p
                    className={`text-sm ${
                      IN_FLIGHT.includes(item.status)
                        ? "text-muted"
                        : "text-red-400"
                    }`}
                  >
                    {note}
                  </p>
                )}
              </div>
            );
          })}
        </div>

        <div className="sticky bottom-0 mt-8 bg-bg pt-4 pb-6">
          <textarea
            className="w-full rounded border border-border bg-transparent p-3 text-sm outline-none placeholder:text-muted focus:border-white"
            rows={3}
            value={prompt}
            placeholder="Describe the piece…"
            onChange={(e) => {
              setPrompt(e.target.value);
              // A different prompt is a different generation, so it must not
              // reuse the previous key (the server would reject the mismatch).
              requestIdRef.current = null;
            }}
          />
          <div className="mt-3 flex items-center gap-4">
            <button
              onClick={onGenerate}
              disabled={submitting}
              className="rounded bg-white px-4 py-2 text-sm font-medium text-black disabled:opacity-50"
            >
              {submitting ? "sending…" : "Generate"}
            </button>
            <span className="text-xs text-muted">
              {balance} {balance === 1 ? "credit" : "credits"}
            </span>
            {message && <span className="text-xs text-red-400">{message}</span>}
          </div>
        </div>
      </div>

      {gallery.length > 0 && (
        <aside className="hidden w-48 shrink-0 lg:block">
          <div className="sticky top-16">
            <p className="mb-2 text-xs text-muted">Gallery</p>
            <div className="grid grid-cols-2 gap-2">
              {gallery.map((item) => (
                <button
                  key={item.id}
                  onClick={() => focusDesign(item.id)}
                  className={`overflow-hidden rounded border ${
                    focusedId === item.id ? "border-white" : "border-border"
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={item.previewUrl!}
                    alt={item.prompt}
                    className="block w-full"
                  />
                </button>
              ))}
            </div>
          </div>
        </aside>
      )}
    </div>
  );
}
