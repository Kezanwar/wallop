"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { startSessionAction } from "@/app/actions/session";
import { generateDesignAction } from "@/app/actions/generate";

const POLL_MS = 1500;
/** Generation is ~10s; this is the "something is wrong" ceiling, not a target. */
const POLL_TIMEOUT_MS = 90_000;

type StatusResponse = {
  status: string;
  previewUrl?: string;
  balance: number;
};

type Phase = "starting" | "idle" | "working" | "ready" | "error";

export function GenerateClient({ initialBalance }: { initialBalance: number }) {
  const router = useRouter();

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [balance, setBalance] = useState(initialBalance);
  const [phase, setPhase] = useState<Phase>("starting");
  const [message, setMessage] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  /**
   * One requestId per intended generation. Minted on submit and held until
   * that generation settles, so clicking Generate again after a network error
   * re-sends the SAME key and the server returns the original design instead
   * of charging twice. Cleared on a terminal state and whenever the prompt
   * changes — a different prompt is a different generation.
   */
  const requestIdRef = useRef<string | null>(null);

  /**
   * Synchronous double-submit guard. `phase` disables the button, but React
   * state lands after the event, so two clicks in the same tick would both
   * get through. The server's requestId guard is the real defence; this
   * stops the pointless second round trip.
   */
  const inFlightRef = useRef(false);

  /** Bumped on unmount and on each new generation so stale polls stand down. */
  const pollRunRef = useRef(0);

  // StrictMode double-invokes effects in dev; without the guard that would
  // open two design sessions per page load. Refs survive its simulated
  // remount, which is what makes the guard work.
  const sessionStartedRef = useRef(false);

  useEffect(() => {
    if (sessionStartedRef.current) return;
    sessionStartedRef.current = true;

    // No cancel-on-cleanup flag here, deliberately. Paired with the ref guard
    // it deadlocks: StrictMode's cleanup would cancel the first call, and the
    // second invocation returns early at the guard, so nothing ever resolves
    // and the form stays disabled at `starting` forever. A late setState
    // after a real unmount is a harmless no-op.
    startSessionAction({ aspectRatio: "portrait" })
      .then(({ sessionId }) => {
        setSessionId(sessionId);
        setPhase((p) => (p === "starting" ? "idle" : p));
      })
      .catch(() => {
        setPhase((p) => (p === "starting" ? "error" : p));
        setMessage("Couldn't start a session. Reload the page.");
      });
  }, []);

  useEffect(() => {
    return () => {
      pollRunRef.current += 1; // stop any in-flight poll loop on unmount
    };
  }, []);

  const poll = useCallback(
    async (designId: string, run: number) => {
      const deadline = Date.now() + POLL_TIMEOUT_MS;

      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        if (pollRunRef.current !== run) return; // superseded or unmounted

        let body: StatusResponse;
        try {
          const res = await fetch(`/api/designs/${designId}/status`, {
            cache: "no-store",
          });
          if (!res.ok) {
            // 401 means the session went away mid-generation.
            throw new Error(String(res.status));
          }
          body = await res.json();
        } catch {
          continue; // a blip shouldn't kill the loop; the deadline bounds it
        }
        if (pollRunRef.current !== run) return;

        setBalance(body.balance);

        if (body.status === "ready") {
          inFlightRef.current = false;
          requestIdRef.current = null;
          if (body.previewUrl) {
            setPreviewUrl(body.previewUrl);
            setPhase("ready");
          } else {
            setPhase("error");
            setMessage("Generated, but the preview is missing.");
          }
          router.refresh(); // keep the sidebar balance honest
          return;
        }

        if (body.status === "failed" || body.status === "moderation_rejected") {
          inFlightRef.current = false;
          requestIdRef.current = null;
          setPhase("error");
          setMessage("Generation failed — your credit was refunded.");
          router.refresh();
          return;
        }
      }

      // Timed out. Deliberately NOT claiming a refund: the job may well still
      // be running, and the credit only comes back when it actually fails.
      inFlightRef.current = false;
      setPhase("error");
      setMessage(
        "Still not done after 90s. It may yet finish — reload to check.",
      );
    },
    [router],
  );

  async function onGenerate() {
    if (inFlightRef.current) return;
    if (!sessionId) return;
    if (!prompt.trim()) {
      setMessage("Type a prompt first.");
      return;
    }

    inFlightRef.current = true;
    const run = ++pollRunRef.current;
    setPhase("working");
    setMessage(null);
    setPreviewUrl(null);

    // Minted here, once, and reused if this same generation is retried.
    requestIdRef.current ??= crypto.randomUUID();

    let result;
    try {
      result = await generateDesignAction({
        sessionId,
        prompt: prompt.trim(),
        requestId: requestIdRef.current,
      });
    } catch {
      inFlightRef.current = false;
      setPhase("error");
      // requestId is kept, so clicking Generate again resumes this same
      // generation rather than paying for a second one.
      setMessage("Couldn't reach the server. Try again.");
      return;
    }

    if (!result.ok) {
      inFlightRef.current = false;
      requestIdRef.current = null;
      setPhase("error");
      if (result.error === "insufficient_credits") {
        setMessage("You're out of credits.");
      } else if (result.error === "session_not_found") {
        setMessage("Your design session expired. Reload the page.");
      } else {
        setMessage(result.message);
      }
      return;
    }

    setBalance(result.balance);
    void poll(result.designId, run);
  }

  const busy = phase === "working";

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        {balance} {balance === 1 ? "credit" : "credits"}
      </p>

      <textarea
        className="w-full rounded border border-border bg-transparent p-3 text-sm outline-none placeholder:text-muted focus:border-white"
        rows={4}
        value={prompt}
        placeholder="Describe the piece…"
        disabled={phase === "starting"}
        onChange={(e) => {
          setPrompt(e.target.value);
          // A different prompt is a different generation, so it must not
          // reuse the previous key (the server would reject the mismatch).
          requestIdRef.current = null;
        }}
      />

      <div>
        <button
          onClick={onGenerate}
          disabled={busy || phase === "starting" || !sessionId}
          className="rounded bg-white px-4 py-2 text-sm font-medium text-black disabled:opacity-50"
        >
          {busy ? "generating…" : "Generate"}
        </button>
      </div>

      {message && <p className="text-sm text-red-400">{message}</p>}

      {busy && <p className="text-sm text-muted">generating…</p>}

      {previewUrl && (
        // Plain <img>: the src is a short-lived signed R2 URL, which would
        // need the bucket host in next.config remotePatterns to pass through
        // next/image. Not worth it for this slice.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={previewUrl}
          alt={prompt || "Generated design"}
          className="max-w-sm rounded border border-border"
        />
      )}
    </div>
  );
}
