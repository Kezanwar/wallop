/**
 * Every object key in the bucket is built here — never by hand elsewhere.
 *
 * THE `private/` PREFIX IS THE PAYWALL. Do not "simplify" this structure.
 *
 * - Anything under `private/` (print-resolution files, user uploads) must
 *   NEVER be publicly readable. Access is by short-lived signed URL only,
 *   issued after purchase / ownership checks.
 * - Everything else (previews, mockups) is low-res marketing material and
 *   may be served from the public CDN domain.
 *
 * The public CDN / bucket policy is scoped to exclude `private/`, and
 * getPublicUrl() refuses private keys. Moving print files out of
 * `private/` would hand away the product for free.
 */
const PRIVATE_PREFIX = "private/";

export const storageKeys = {
  preview: (designId: string) => `designs/${designId}/preview.webp`,
  mockup: (designId: string, sku: string) =>
    `designs/${designId}/mockup-${sku}.jpg`,
  print: (designId: string, sku: string) =>
    `${PRIVATE_PREFIX}designs/${designId}/print-${sku}.png`,
  upload: (uploadId: string, ext: string) =>
    `${PRIVATE_PREFIX}uploads/${uploadId}.${ext}`,
} as const;

export function isPrivateKey(key: string): boolean {
  return key.startsWith(PRIVATE_PREFIX);
}
