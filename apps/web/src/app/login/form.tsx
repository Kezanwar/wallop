"use client";

import { useActionState } from "react";
import {
  requestCodeAction,
  verifyCodeAction,
  type AuthState,
} from "@/app/actions/auth";

const input =
  "w-full rounded border border-neutral-300 px-3 py-2.5 text-sm outline-none focus:border-neutral-900";
const button =
  "w-full rounded bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50";

export function LoginForm() {
  const [requestState, requestAction, requesting] = useActionState<
    AuthState | null,
    FormData
  >(requestCodeAction, null);
  const [verifyState, verifyAction, verifying] = useActionState<
    AuthState | null,
    FormData
  >(verifyCodeAction, null);

  // Once a code has been sent we switch to the code-entry step. verifyState
  // also carries `sent`, so a failed attempt keeps us here rather than
  // bouncing back to the email step.
  const email = verifyState?.email ?? requestState?.email;
  const codeSent = Boolean(requestState?.sent || verifyState?.sent);

  if (!codeSent) {
    return (
      <form action={requestAction} className="flex flex-col gap-3">
        <input
          className={input}
          type="email"
          name="email"
          placeholder="you@example.com"
          autoComplete="email"
          required
        />
        <button className={button} disabled={requesting}>
          {requesting ? "Sending…" : "Email me a code"}
        </button>
        {requestState?.error && (
          <p className="text-sm text-red-600">{requestState.error}</p>
        )}
      </form>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <form action={verifyAction} className="flex flex-col gap-3">
        <input type="hidden" name="email" value={email ?? ""} />
        <p className="text-sm text-neutral-500">
          If an account exists for{" "}
          <strong className="text-neutral-900">{email}</strong>, we&apos;ve sent
          a 6-digit code.
        </p>
        <input
          className={`${input} text-center text-lg tracking-[0.4em]`}
          name="code"
          inputMode="numeric"
          pattern="\d{6}"
          maxLength={6}
          placeholder="000000"
          autoComplete="one-time-code"
          autoFocus
          required
        />
        <button className={button} disabled={verifying}>
          {verifying ? "Verifying…" : "Sign in"}
        </button>
        {verifyState?.error && (
          <p className="text-sm text-red-600">{verifyState.error}</p>
        )}
      </form>

      {/* Escape hatch: after 5 wrong attempts the code is burnt and no
          amount of retyping will work. */}
      <form action={requestAction}>
        <input type="hidden" name="email" value={email ?? ""} />
        <button
          className="text-sm text-neutral-500 underline"
          disabled={requesting}
        >
          Send a new code
        </button>
      </form>
    </div>
  );
}
