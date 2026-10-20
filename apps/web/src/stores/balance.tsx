"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

/**
 * The credit balance: shown in the sidebar and the composer at once, and
 * changed by every generation. One store keeps the two in step — otherwise
 * the composer decrements instantly from an action's return value while the
 * sidebar waits on router.refresh(), and they disagree for the ~10s a
 * generation takes.
 *
 * Built to the house store shape — factory, provider, selector hook. See
 * ./README.md before adding another.
 */
export type BalanceStore = {
  balance: number;
  /** Authoritative value from an action or poll response. */
  setBalance: (next: number) => void;
  /** Relative nudge, for when only the delta is known. */
  adjust: (delta: number) => void;
};

export type BalanceStoreApi = ReturnType<typeof createBalanceStore>;

export function createBalanceStore(initialBalance: number) {
  return createStore<BalanceStore>()((set) => ({
    balance: initialBalance,
    setBalance: (balance) => set({ balance }),
    adjust: (delta) => set((state) => ({ balance: state.balance + delta })),
  }));
}

const BalanceStoreContext = createContext<BalanceStoreApi | null>(null);

/**
 * Creates the store INSIDE the React tree, which is the whole point: one
 * instance per render tree means one per request on the server and one per
 * tab on the client. A module-level store would be a process singleton and
 * could serve one user's balance into another's server-rendered HTML.
 *
 * Seeded from the (app) shell's server read, so the first paint is already
 * this user's real number and the client never queries the DB itself.
 */
export function BalanceStoreProvider({
  initialBalance,
  children,
}: {
  initialBalance: number;
  children: React.ReactNode;
}) {
  // Lazy initialiser, so the store is built once per component instance.
  // (useRef would do the same, but reading ref.current during render is
  // exactly what the react-hooks/refs rule forbids.)
  const [store] = useState(() => createBalanceStore(initialBalance));

  // The store survives re-renders, so a router.refresh() won't rebuild it —
  // this is what lets the server's committed balance back in. Safe because
  // the DB is never behind the client: every value we set optimistically
  // came from an already-committed transaction.
  useEffect(() => {
    store.getState().setBalance(initialBalance);
  }, [store, initialBalance]);

  return (
    <BalanceStoreContext.Provider value={store}>
      {children}
    </BalanceStoreContext.Provider>
  );
}

/** Always called with a selector, so a consumer re-renders only for what it reads. */
export function useBalanceStore<T>(selector: (store: BalanceStore) => T): T {
  const store = useContext(BalanceStoreContext);
  if (!store) {
    throw new Error(
      "useBalanceStore must be used within a BalanceStoreProvider",
    );
  }
  return useStore(store, selector);
}
