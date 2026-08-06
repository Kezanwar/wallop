import Link from "next/link";
import { getSession } from "@/lib/auth";
import { getPooledDb } from "@wallop/db";
import { getBalance } from "@wallop/core";
import { logoutAction } from "@/app/actions/auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await getSession();
  const balance = session
    ? await getBalance(getPooledDb(), session.userId)
    : null;

  return (
    <main className="mx-auto max-w-2xl px-6 py-24">
      <h1 className="mb-2 text-4xl font-medium tracking-tight">
        wallop.studio
      </h1>

      {session ? (
        <>
          <p className="mb-1 text-neutral-600">
            Signed in as <strong>{session.email}</strong>
          </p>
          <p className="mb-8 text-neutral-600">
            Credit balance: <strong>{balance}</strong>
          </p>
          <form action={logoutAction}>
            <button className="text-sm text-neutral-500 underline">
              Sign out
            </button>
          </form>
        </>
      ) : (
        <>
          <p className="mb-8 text-neutral-600">AI art for your walls.</p>
          <Link
            href="/login"
            className="inline-block rounded bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white"
          >
            Sign in
          </Link>
        </>
      )}
    </main>
  );
}
