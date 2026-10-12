import { createR2Storage } from "./r2";
import type { Storage } from "./types";

export * from "./types";
export * from "./keys";
export * from "./r2";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

// The S3Client holds a connection pool and should live for the process.
// The globalThis stash survives Next's hot reload, which would otherwise
// leak a new client on every file save.
const globalForStorage = globalThis as unknown as {
  __storage?: Storage;
};

export function getStorage(): Storage {
  globalForStorage.__storage ??= createR2Storage({
    accountId: required("R2_ACCOUNT_ID"),
    accessKeyId: required("R2_ACCESS_KEY_ID"),
    secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
    bucket: required("R2_BUCKET"),
    publicBaseUrl: process.env.R2_PUBLIC_BASE_URL || undefined,
  });
  return globalForStorage.__storage;
}
