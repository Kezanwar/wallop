import type { PgBoss } from "pg-boss";
import { eq } from "drizzle-orm";
import { type DbClient, schema } from "@wallop/db";
import { ensureQueue } from "../jobs/queue";
import { JOBS, type PayloadOf } from "../jobs/registry";
import { setSessionTitleIfUnset } from "../designs/designs";
import { summarisePromptToTitle } from "./titles";
import { LLMProviderError, type LLMProvider } from "./types";

const { designSessions } = schema;

export type TitleJobDeps = {
  db: DbClient;
  llm: LLMProvider;
};

/**
 * A title is decoration. Nothing here is worth much retrying and nothing is
 * worth a dead-letter queue — a session that never gets named just keeps its
 * "Untitled piece" fallback, which is a perfectly good outcome.
 *
 * No money is involved either, so there is no refund path.
 */
const TITLE_QUEUE = {
  retryLimit: 2,
  retryDelay: 10,
  retryBackoff: true,
  expireInSeconds: 120,
  notify: true,
} as const;

const TITLE_POLL_SECONDS = 5;

/** Split out so tests can create the queue without starting a worker. */
export async function ensureTitleQueue(boss: PgBoss) {
  await ensureQueue(boss, JOBS.summariseSessionTitle, TITLE_QUEUE);
}

export async function registerTitleHandlers(boss: PgBoss, deps: TitleJobDeps) {
  await ensureTitleQueue(boss);

  await boss.work<PayloadOf<typeof JOBS.summariseSessionTitle>>(
    JOBS.summariseSessionTitle,
    {
      batchSize: 1,
      notifyPollingIntervalSeconds: TITLE_POLL_SECONDS,
      pollingIntervalSeconds: TITLE_POLL_SECONDS,
    },
    async ([job]) => {
      if (!job) return;
      return runSummariseSessionTitle(deps, job.data);
    },
  );
}

export type TitleOutcome =
  | { status: "titled"; sessionId: string; title: string }
  /** Already named, gone, or the model refused — all fine, all final. */
  | { status: "skipped"; sessionId: string; reason: string };

/**
 * Summarise the session's first prompt into its title.
 *
 * Error contract, deliberately the opposite of the generation job's:
 * - Terminal LLM errors (moderation, invalid) are SWALLOWED. The user loses
 *   nothing they paid for, and failing loudly would turn a cosmetic miss into
 *   a noisy dead-letter entry.
 * - Transient errors THROW so pg-boss retries a couple of times, then gives
 *   up quietly.
 */
export async function runSummariseSessionTitle(
  deps: TitleJobDeps,
  payload: PayloadOf<typeof JOBS.summariseSessionTitle>,
): Promise<TitleOutcome> {
  const { db, llm } = deps;
  const { sessionId, prompt } = payload;

  // Checked BEFORE the model call, not just at the write: a redelivery or a
  // retry on an already-named session would otherwise pay for a title that
  // the `title is null` guard then throws away.
  const [session] = await db
    .select({ title: designSessions.title })
    .from(designSessions)
    .where(eq(designSessions.id, sessionId));

  if (!session) {
    return { status: "skipped", sessionId, reason: "session not found" };
  }
  if (session.title) {
    return { status: "skipped", sessionId, reason: "already titled" };
  }

  let title: string;
  try {
    title = await summarisePromptToTitle(prompt, llm);
  } catch (err) {
    if (err instanceof LLMProviderError && !err.retryable) {
      console.warn(
        `[title] ${sessionId} giving up (${err.kind}): ${err.message}`,
      );
      return { status: "skipped", sessionId, reason: err.kind };
    }
    throw err; // transient — let pg-boss have another go
  }

  if (!(await setSessionTitleIfUnset(db, { sessionId, title }))) {
    // Named by someone else between the check above and here.
    return { status: "skipped", sessionId, reason: "titled concurrently" };
  }

  console.log(`[title] ${sessionId} → "${title}"`);
  return { status: "titled", sessionId, title };
}
