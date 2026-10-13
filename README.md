# wallop

AI wall art. Users generate original artwork through a conversational interface and order it as physical prints, fulfilled on demand.

A pnpm + Turborepo monorepo. Two deployable apps, three shared packages.

---

## Architecture

```
apps/
  web/        Next.js 16 (App Router) — UI, API routes, Server Actions
  worker/     long-lived Node process — runs background jobs

packages/
  db/         Drizzle schema, migrations, connection clients
  core/       all domain logic — credits, auth, jobs, designs, storage
  providers/  (not yet created) external-service wrappers behind interfaces
```

### How the packages interact

The rule the whole thing hangs on: **`db` owns how we reach Postgres, `core` owns the business rules, and neither app writes SQL.**

- **`@wallop/db`** exposes the Drizzle schema and two connection clients — a _pooled_ one (`getPooledDb`) and a _direct_ one (`getDirectDb`). It knows nothing about credits or auth. It also owns the migration files and the migration runner.

- **`@wallop/core`** is pure domain logic. Every function takes a `DbClient` as an argument rather than opening its own connection — which is what keeps it testable (pass a test db) and lets the _caller_ decide pooled vs direct. `pg` is only a devDependency here; if it ever became a real dependency, something has leaked across the boundary. Current modules: `credits`, `auth` (crypto/sessions/otp/google/users), `jobs` (the pg-boss queue), `designs`, and `storage` (R2).

- **`@wallop/web`** and **`@wallop/worker`** both import `@wallop/core` and `@wallop/db` as `workspace:*` dependencies. They provide the connection; core provides the logic. So the worker refunding a failed generation and the web app showing a balance are provably running the _same_ ledger code, not two implementations that drift.

### The two connection strings

Web and worker connect differently, on purpose:

- **web → pooled** (`DATABASE_URL_POOLED`). Serverless-style request handlers open many short-lived connections; the pooler multiplexes them so Postgres doesn't run out.
- **worker → direct** (`DATABASE_URL_DIRECT`). pg-boss uses Postgres `LISTEN/NOTIFY` to pick up jobs instantly, and that needs a session-pinned connection — it breaks through a transaction-mode pooler.

Locally both point at the same Docker Postgres, so the split is invisible until production, where they diverge (Neon pooled vs direct endpoints).

### The job queue (pg-boss)

Background work — generation, cleanup — runs through pg-boss, which stores jobs as rows in Postgres (no Redis). The worker holds the full queue runtime; web only enqueues, borrowing the Drizzle pool via an adapter so it doesn't spin up a second connection pool. `enqueueInTransaction` lets a job be enqueued _inside_ a database transaction, so e.g. spending a credit and queueing the generation commit atomically — a crash between them can't charge someone for work that never runs.

---

## Getting started

Requires Node 22.13+ (`.nvmrc` pins it), pnpm, and Docker.

```bash
nvm use                  # Node 22
pnpm install

cp .env.example .env     # then fill in Google + R2 credentials (see below)

pnpm db:dev              # start Postgres in Docker
pnpm db:migrate          # apply migrations
pnpm db:test:create      # create the test database (one-off)

pnpm web:dev             # Next.js on :3000
pnpm worker:dev          # the background worker (separate terminal)
```

OTP login codes print to the **terminal** in dev — there's no email provider wired up yet, so watch the web dev output for the code when signing in.

### Environment

`.env` at the repo root is the single source for every package (each reads it via a `dotenv` prefix in its scripts).

- **DATABASE_URL_POOLED / \_DIRECT / \_TEST** — all point at local Docker Postgres in dev
- **GOOGLE_CLIENT_ID / \_SECRET / \_REDIRECT_URI** — OAuth; redirect URI must match the Google console exactly
- **R2_ACCOUNT_ID / \_ACCESS_KEY_ID / \_SECRET_ACCESS_KEY / \_BUCKET / \_PUBLIC_BASE_URL** — Cloudflare R2 storage (leave `_PUBLIC_BASE_URL` empty until a CDN domain exists)

> Note: the R2 vars may not yet be in `.env.example` — add them when you wire up storage locally.

---

## Scripts

Run from the repo root.

| Script                                        | What it does                                         |
| --------------------------------------------- | ---------------------------------------------------- |
| `pnpm dev`                                    | Everything via Turbo                                 |
| `pnpm web:dev` / `pnpm worker:dev`            | Run one app                                          |
| `pnpm build` / `pnpm typecheck` / `pnpm lint` | Across all packages                                  |
| `pnpm test:core`                              | The core test suite (credit ledger, auth)            |
| `pnpm db:dev` / `pnpm db:stop`                | Start / stop Docker Postgres                         |
| `pnpm db:migrate`                             | Apply migrations                                     |
| `pnpm db:generate`                            | Generate a migration from schema changes             |
| `pnpm db:studio`                              | Drizzle Studio (browse the DB)                       |
| `pnpm db:test:create`                         | Create the test database                             |
| `pnpm db:truncate`                            | Wipe all rows, keep the schema                       |
| `pnpm db:reset`                               | Nuke the volume, recreate, migrate, recreate test db |

---

## Conventions

- **Branching**: feature branches off `develop`, PR into `develop`.
- **Migrations run before deploy**, never on app boot — multiple instances starting up would race each other.
- **IDs are UUIDv7**, generated in app code (not a DB default), so raw SQL inserts must supply their own `id`.
- **Tests run against a real Postgres** (`wallop_test`), not mocks — the credit ledger's concurrency safety is exactly the thing a mock would hide.

---

## Testing

`pnpm test:core` runs the suite against the `wallop_test` database. The highest-value tests are the credit-ledger concurrency ones — fire N parallel spends against a balance of M, assert exactly M succeed. A race condition that passes a two-way test can still be real, so these run at volume.
