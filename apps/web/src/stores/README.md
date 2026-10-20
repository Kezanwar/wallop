# Client stores (Zustand)

One small store per entity that needs hot cross-component client state. Keep
them small and focused — a balance store, later perhaps a wand-facets store or
an active-parent store. Never one giant app store.

## House style: factory + provider + selector hook

**Every store is created inside the React tree. Never at module level.**

A `create(...)` at module scope is a process singleton. On the server that
means it is shared by every concurrent request, so one user's value can be
served into another user's HTML. Building the store in a provider gives one
instance per render tree — per request on the server, per tab on the client —
and the leak cannot happen.

One file per store, exporting three things. Copy `balance.tsx`:

1. **`createXStore(initial)`** — a factory using `createStore` from
   `zustand/vanilla`, seeded with the server's value.
2. **`XStoreProvider`** — builds the instance once with
   `useState(() => createXStore(seed))` so it survives re-renders, and provides
   it through a small context. The context carries the store _instance_; the
   state itself lives in Zustand. Use `useState`, not the `useRef` the Zustand
   docs show: `react-hooks/refs` rejects reading `ref.current` during render,
   and the lazy initialiser gives the same once-per-instance guarantee.
3. **`useXStore(selector)`** — reads from that context. Always takes a
   selector, so a consumer re-renders only when the slice it reads changes.

Mount the provider in the shell (or the subtree) that already has the server
value to seed it with.

## What belongs in a store

A value that is **live, shown in several places at once, and mutated by user
actions**. The credit balance is the type case: the sidebar and the composer
both show it and every generation changes it, so a round trip between them
would show two different numbers.

## What does NOT belong

**Server data.** The session list, the design thread, anything read once and
rendered. Those stay server-as-truth — Server Components plus
`router.refresh()` — which is how we avoid cache-invalidation drift. A store
that mirrors the DB is a cache, and caches go stale.

Rule of thumb: read once and rendered → keep it server-side. Live value in
several places, mutated by the user → a small store.

See `plan/ui-build-plan.md`, "State management", for the reasoning.
