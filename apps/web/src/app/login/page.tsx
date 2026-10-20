import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { LoginForm } from "./form";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await getSession()) redirect("/studio");
  const { error } = await searchParams;

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <h1 className="mb-1 text-4xl font-medium tracking-tight">
        wallop.studio
      </h1>
      <p className="mb-8 text-sm text-muted">Sign in to start making art.</p>

      {error === "oauth" && (
        <p className="mb-4 rounded border border-red-900 bg-red-950 p-3 text-sm text-red-300">
          Google sign-in failed. Please try again.
        </p>
      )}

      <a
        href="/api/auth/google"
        className="mb-6 flex items-center justify-center rounded border border-border px-4 py-2.5 text-sm font-medium hover:bg-white/5"
      >
        Continue with Google
      </a>

      <div className="mb-6 flex items-center gap-3 text-xs text-muted">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>

      <LoginForm />
    </main>
  );
}
