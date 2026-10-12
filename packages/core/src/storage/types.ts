// Deliberately narrow: anything an S3-compatible backend can do in one call.
// Swapping R2 for S3 (or anything else) should mean writing one new file
// that returns this interface — callers never see the SDK.
export interface Storage {
  put(input: {
    key: string;
    body: Buffer | Uint8Array | string;
    contentType: string;
  }): Promise<void>;

  /** Time-limited read URL. Works for private keys. Default 15 minutes. */
  getSignedUrl(key: string, expiresInSeconds?: number): Promise<string>;

  /** Permanent CDN URL. Throws for private keys — those are signed-URL only. */
  getPublicUrl(key: string): string;

  delete(key: string): Promise<void>;

  exists(key: string): Promise<boolean>;
}
