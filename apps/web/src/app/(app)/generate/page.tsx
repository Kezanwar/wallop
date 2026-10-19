import { getBalance } from "@wallop/core";
import { getPooledDb } from "@wallop/db";
import { requireSession } from "@/lib/auth";
import { GenerateClient } from "./generate-client";

export const dynamic = "force-dynamic";

export default async function GeneratePage() {
  const user = await requireSession();
  const balance = await getBalance(getPooledDb(), user.userId);

  return (
    <div className="max-w-xl">
      <h1 className="mb-6 text-2xl font-medium tracking-tight">Generate</h1>
      <GenerateClient initialBalance={balance} />
    </div>
  );
}
