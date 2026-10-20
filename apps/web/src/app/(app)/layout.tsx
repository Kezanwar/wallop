import { requireSession } from "@/lib/auth";
import { getPooledDb } from "@wallop/db";
import { getBalance } from "@wallop/core";
import { Sidebar } from "@/components/sidebar";
import { BalanceStoreProvider } from "@/stores/balance";

export const dynamic = "force-dynamic";

/**
 * Gates every route in the (app) group: requireSession redirects to /login
 * when there's no session, so individual pages don't repeat the check.
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireSession();
  const balance = await getBalance(getPooledDb(), session.userId);

  return (
    // One store instance per render tree, seeded from this request's read —
    // so the first paint is already this user's number and nothing is shared
    // between concurrent requests.
    <BalanceStoreProvider initialBalance={balance}>
      <div className="min-h-screen bg-bg text-text md:flex">
        <Sidebar email={session.email} />
        <main className="flex-1 px-6 py-10 md:px-12 md:py-16">{children}</main>
      </div>
    </BalanceStoreProvider>
  );
}
