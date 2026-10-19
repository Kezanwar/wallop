import Link from "next/link";
import { getSession } from "@/lib/auth";
import { pingJobAction } from "@/app/actions/job";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await getSession();

  return (
    <main className="mx-auto max-w-2xl px-6 py-24">
      <h1 className="mb-2 text-4xl font-medium tracking-tight">
        wallop.studio
      </h1>
      <p className="mb-8 text-neutral-600">AI art for your walls.</p>

      <Link
        href={session ? "/generate" : "/login"}
        className="inline-block rounded bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white"
      >
        {session ? "Open Wallop" : "Sign in"}
      </Link>

      {session && (
        // Dev affordance for poking the queue; not part of the product surface.
        <form action={pingJobAction} className="mt-8">
          <button className="text-sm text-neutral-500 underline">
            Enqueue a ping job
          </button>
        </form>
      )}
    </main>
  );
}
