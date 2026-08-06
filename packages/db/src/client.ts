import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

// WEB / serverless: connects through the POOLED endpoint.
// Safe for many short-lived callers.
export function createPooledClient() {
  const pool = new Pool({ connectionString: required("DATABASE_URL_POOLED") });
  return drizzle(pool, { schema });
}

// WORKER / migrations: connects DIRECTLY.
// pg-boss needs LISTEN/NOTIFY, which transaction-mode pooling breaks —
// so anything long-lived or using LISTEN/NOTIFY uses this.
export function createDirectClient() {
  const pool = new Pool({ connectionString: required("DATABASE_URL_DIRECT") });
  return drizzle(pool, { schema });
}

export type DbClient = ReturnType<typeof createPooledClient>;

export type DbTransaction = Parameters<
  Parameters<DbClient["transaction"]>[0]
>[0];

// A Pool is meant to live for the lifetime of the process, not per request.
// The globalThis stash survives Next's hot reload, which would otherwise
// spawn a new pool on every file save.
const globalForDb = globalThis as unknown as {
  __pooledDb?: DbClient;
  __directDb?: DbClient;
};

export function getPooledDb(): DbClient {
  globalForDb.__pooledDb ??= createPooledClient();
  return globalForDb.__pooledDb;
}

export function getDirectDb(): DbClient {
  globalForDb.__directDb ??= createDirectClient();
  return globalForDb.__directDb;
}
