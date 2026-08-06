import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { LoginForm } from "./form";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await getSession()) redirect("/");
  const { error } = await searchParams;

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <h1 className="mb-1 text-2xl font-medium tracking-tight">
        wallop.studio
      </h1>
      <p className="mb-8 text-sm text-neutral-500">
        Sign in to start making art.
      </p>

      {error === "oauth" && (
        <p className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          Google sign-in failed. Please try again.
        </p>
      )}

      <a
        href="/api/auth/google"
        className="mb-6 flex items-center justify-center rounded border border-neutral-300 px-4 py-2.5 text-sm font-medium hover:bg-neutral-50"
      >
        Continue with Google
      </a>

      <div className="mb-6 flex items-center gap-3 text-xs text-neutral-400">
        <span className="h-px flex-1 bg-neutral-200" />
        or
        <span className="h-px flex-1 bg-neutral-200" />
      </div>

      <LoginForm />
    </main>
  );
}
