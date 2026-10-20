"use client";

import { createContext, useContext, useState } from "react";

/**
 * The credit balance is shown in two places at once — the sidebar and the
 * composer — and changes on every generation. Holding it in one piece of
 * client state is what keeps them in step: before this, the composer
 * decremented instantly from the action's return value while the sidebar
 * waited on router.refresh(), so the two disagreed for the ~10s a generation
 * takes.
 *
 * Deliberately a context and not a store: it's one number. The DB remains the
 * source of truth — this is seeded from a server read and corrected by every
 * action and poll response, which also means a refresh resyncs it for free.
 */
const BalanceContext = createContext<{
  balance: number;
  setBalance: (next: number) => void;
} | null>(null);

export function BalanceProvider({
  initialBalance,
  children,
}: {
  initialBalance: number;
  children: React.ReactNode;
}) {
  const [balance, setBalance] = useState(initialBalance);
  return (
    <BalanceContext.Provider value={{ balance, setBalance }}>
      {children}
    </BalanceContext.Provider>
  );
}

export function useBalance() {
  const ctx = useContext(BalanceContext);
  if (!ctx) throw new Error("useBalance must be used inside a BalanceProvider");
  return ctx;
}
