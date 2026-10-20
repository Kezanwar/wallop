"use client";

import { useEffect } from "react";
import { create } from "zustand";

/**
 * The credit balance: shown in the sidebar and the composer at once, and
 * changed by every generation. One store keeps the two in step — before this
 * the composer decremented instantly from an action's return value while the
 * sidebar waited on router.refresh(), so they disagreed for the ~10s a
 * generation takes.
 *
 * Hot ephemeral client state, which is the only thing stores are for here.
 * See ./README.md before adding another.
 */
type BalanceStore = {
  balance: number;
  /** Authoritative value from an action or poll response. */
  setBalance: (next: number) => void;
  /** Relative nudge, for when only the delta is known. */
  adjust: (delta: number) => void;
};

export const useBalanceStore = create<BalanceStore>((set) => ({
  balance: 0,
  setBalance: (balance) => set({ balance }),
  adjust: (delta) => set((state) => ({ balance: state.balance + delta })),
}));

/**
 * Seeds the store from the (app) shell's server-side read — the client never
 * queries the DB itself.
 *
 * Re-seeding whenever the prop changes is deliberate: a router.refresh()
 * re-runs the shell, so the server's committed balance resyncs the store for
 * free and any optimistic value that drifted is corrected.
 */
export function BalanceHydrator({ balance }: { balance: number }) {
  const setBalance = useBalanceStore((s) => s.setBalance);
  useEffect(() => {
    setBalance(balance);
  }, [balance, setBalance]);
  return null;
}
