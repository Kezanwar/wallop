# Client stores (Zustand)

One small store per entity that needs hot cross-component client state. Keep
them small and focused — a balance store, later perhaps an active-parent store
or a wand-facets store. Never one giant app store.

## What belongs here

A value that is **live, shown in several places at once, and mutated by user
actions**. The credit balance is the type case: the sidebar and the composer
both show it and every generation changes it, so a round trip between them
would show two different numbers.

## What does NOT belong here

**Server data.** The session list, the design thread, anything read once and
rendered. Those stay server-as-truth — Server Components plus
`router.refresh()` — which is how we avoid cache-invalidation drift. A store
that mirrors the DB is a cache, and caches go stale.

Rule of thumb: read once and rendered → keep it server-side. Live value in
several places, mutated by the user → a small store.

See `plan/ui-build-plan.md`, "State management", for the reasoning.

## Seeding

Stores are hydrated from a prop the server already read, never from a
client-side DB call. `BalanceHydrator` in `balance.ts` is the shape to copy:
the shell reads the value, passes it in, and the hydrator seeds the store and
re-seeds on refresh.

## Known limit

These are module-level stores, so on the server they live for the life of the
process rather than the request. The value a store holds can therefore appear
in another request's server-rendered HTML before the client corrects it on
hydration. That is tolerable for a credit count and nothing else currently
qualifies. Anything sensitive, or anything where a wrong first paint matters,
should use the per-request store-factory pattern instead
(https://zustand.docs.pmnd.rs/guides/nextjs).
