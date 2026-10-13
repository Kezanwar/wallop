import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { isPrivateKey } from "./keys";
import type { Storage } from "./types";

export type R2Config = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Custom CDN domain. Optional until we set one up. */
  publicBaseUrl?: string;
};

export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageError";
  }
}

const DEFAULT_SIGNED_URL_TTL_SECONDS = 900;

export function createR2Storage(config: R2Config): Storage {
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  const Bucket = config.bucket;

  return {
    async put({ key, body, contentType }) {
      await client.send(
        new PutObjectCommand({
          Bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
    },

    async getSignedUrl(key, expiresInSeconds = DEFAULT_SIGNED_URL_TTL_SECONDS) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket, Key: key }), {
        expiresIn: expiresInSeconds,
      });
    },

    getPublicUrl(key) {
      if (isPrivateKey(key)) {
        throw new StorageError(
          `Refusing public URL for private key "${key}" — use getSignedUrl`,
        );
      }
      if (!config.publicBaseUrl) {
        throw new StorageError(
          "R2_PUBLIC_BASE_URL is not set — no public CDN domain configured. Use getSignedUrl instead.",
        );
      }
      return `${config.publicBaseUrl.replace(/\/+$/, "")}/${key}`;
    },

    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },

    async exists(key) {
      try {
        await client.send(new HeadObjectCommand({ Bucket, Key: key }));
        return true;
      } catch (err) {
        // HeadObject has no body, so a missing key surfaces as a bare 404
        // ("NotFound") rather than NoSuchKey.
        if (
          err instanceof S3ServiceException &&
          err.$metadata.httpStatusCode === 404
        ) {
          return false;
        }
        throw err;
      }
    },
  };
}
