/**
 * The single source of truth for job names and their payloads.
 * Web enqueues against these types; the worker handles against the same
 * ones — so a mismatch is a compile error rather than a runtime surprise.
 */
export const JOBS = {
  ping: "ping",
  pingFailed: "ping-failed",
  cleanupExpired: "cleanup-expired",
  generateImage: "generate-image",
  generateImageFailed: "generate-image-dlq",
  summariseSessionTitle: "summarise-session-title",
} as const;

export type JobName = (typeof JOBS)[keyof typeof JOBS];

export type PingPayload = { message: string; userId?: string };

/** Everything else (prompt, aspect ratio, resolution) is read off the design row. */
export type GenerateImagePayload = { designId: string };

/**
 * The prompt travels in the payload rather than being read back off the
 * session: it's the FIRST prompt specifically, and by the time the job runs
 * the session may well have others.
 */
export type SummariseSessionTitlePayload = {
  sessionId: string;
  prompt: string;
};

export type JobPayloads = {
  [JOBS.ping]: PingPayload;
  [JOBS.pingFailed]: PingPayload;
  [JOBS.cleanupExpired]: Record<string, never>;
  [JOBS.generateImage]: GenerateImagePayload;
  // pg-boss copies the original payload into the dead letter queue.
  [JOBS.generateImageFailed]: GenerateImagePayload;
  [JOBS.summariseSessionTitle]: SummariseSessionTitlePayload;
};

export type PayloadOf<T extends JobName> = JobPayloads[T];
