import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { setNameAction } from "@/app/actions/auth";

export const dynamic = "force-dynamic";

export default async function WelcomePage() {
  await requireSession();

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <h1 className="mb-2 text-2xl font-medium tracking-tight">
        Welcome to Wallop
      </h1>
      <p className="mb-8 text-sm text-neutral-500">
        You&apos;ve got 10 free credits to start making art. What should we call
        you?
      </p>

      <form action={setNameAction} className="flex flex-col gap-3">
        <input
          className="w-full rounded border border-neutral-300 px-3 py-2.5 text-sm outline-none focus:border-neutral-900"
          name="name"
          placeholder="Your name"
          autoComplete="name"
          autoFocus
          required
        />
        <button className="w-full rounded bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white">
          Continue
        </button>
      </form>
      <Link
        href="/"
        className="mt-4 text-center text-sm text-neutral-500 underline"
      >
        Skip for now
      </Link>
    </main>
  );
}
