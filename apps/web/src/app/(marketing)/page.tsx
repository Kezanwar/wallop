import Link from "next/link";
import { getSession } from "@/lib/auth";

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
        href={session ? "/studio" : "/login"}
        className="inline-block rounded bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white"
      >
        {session ? "Open Wallop" : "Sign in"}
      </Link>
    </main>
  );
}
