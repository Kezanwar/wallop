import { afterAll, describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { getStorage, storageKeys, StorageError } from "../../src/storage/index";

// Hits real R2. Skipped when creds are absent so CI without them stays green.
const hasR2 =
  !!process.env.R2_ACCOUNT_ID &&
  !!process.env.R2_ACCESS_KEY_ID &&
  !!process.env.R2_SECRET_ACCESS_KEY &&
  !!process.env.R2_BUCKET;

const BODY = "hello from the wallop storage smoke test\n";
// Unique per run: a failed run must not poison the next one.
const KEY = `test/smoke-${randomUUID()}.txt`;

describe.skipIf(!hasR2)("R2 storage round trip", () => {
  const storage = getStorage();

  afterAll(async () => {
    if (hasR2) await storage.delete(KEY);
  });

  test("put, read back through a signed URL, delete", async () => {
    await storage.put({ key: KEY, body: BODY, contentType: "text/plain" });
    expect(await storage.exists(KEY)).toBe(true);

    const url = await storage.getSignedUrl(KEY);
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(await res.text()).toBe(BODY);

    await storage.delete(KEY);
    expect(await storage.exists(KEY)).toBe(false);
  });

  test("getSignedUrl honours a custom expiry", async () => {
    const url = await storage.getSignedUrl(KEY, 60);
    expect(new URL(url).searchParams.get("X-Amz-Expires")).toBe("60");
  });

  test("getPublicUrl refuses private keys even when a CDN domain is set", () => {
    const printKey = storageKeys.print("design-1", "sku-1");
    expect(() => storage.getPublicUrl(printKey)).toThrow(StorageError);
    expect(() => storage.getPublicUrl(printKey)).toThrow(/private key/i);
  });

  test("getPublicUrl on a public key reflects R2_PUBLIC_BASE_URL", () => {
    const previewKey = storageKeys.preview("design-1");
    const base = process.env.R2_PUBLIC_BASE_URL;

    if (!base) {
      expect(() => storage.getPublicUrl(previewKey)).toThrow(
        /R2_PUBLIC_BASE_URL is not set/,
      );
      return;
    }
    expect(storage.getPublicUrl(previewKey)).toBe(
      `${base.replace(/\/+$/, "")}/${previewKey}`,
    );
  });
});
