import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { PgBoss } from "pg-boss";
import sharp from "sharp";
import { schema } from "@wallop/db";
import { getBalance, grantAdminAdjustment, InsufficientCreditsError } from "../src/credits";
import {
  createDesignSession,
  getDesign,
  listUserSessions,
  SessionNotFoundError,
} from "../src/designs/designs";
import { ASPECT_RATIOS } from "../src/designs/constants";
import { JOBS } from "../src/jobs/registry";
import {
  createSessionAndEnqueueGeneration,
  enqueueGeneration,
  ensureGenerationQueues,
  failGeneration,
  runGenerateImage,
  InvalidGenerationRequestError,
  type GenerationDeps,
} from "../src/generation";
import {
  ImageProviderError,
  type GenerateParams,
  type ImageProvider,
  type ImageProviderErrorKind,
} from "../src/providers/types";
import type { Storage } from "../src/storage/types";
import { storageKeys } from "../src/storage/keys";
import { ensureTitleQueue } from "../src/llm/title-job";

// No network anywhere in this file: Postgres + pg-boss are local, the image
// provider and storage are in-memory stubs. The live round trip is `pnpm smoke`.

// max well above the widest concurrency test, so the race happens in
// Postgres instead of being serialised waiting for a pool connection.
const pool = new Pool({ connectionString: process.env.DATABASE_URL_TEST, max: 40 });
const db = drizzle(pool, { schema }) as never as GenerationDeps["db"];

// Enqueue-only boss: no workers, so queued jobs just sit there for inspection.
const boss = new PgBoss({
  connectionString: process.env.DATABASE_URL_TEST,
  schema: "pgboss",
  supervise: false,
  schedule: false,
});

let userId: string;
let sessionId: string;

beforeAll(async () => {
  await boss.start();
  await ensureGenerationQueues(boss);
  await ensureTitleQueue(boss);
});

afterAll(async () => {
  await boss.stop({ graceful: false });
  await pool.end();
});

beforeEach(async () => {
  await pool.query("truncate table credit_transactions, users cascade");
  await pool.query("delete from pgboss.job where name = any($1)", [
    [JOBS.generateImage, JOBS.generateImageFailed, JOBS.summariseSessionTitle],
  ]);
  const res = await pool.query(
    "insert into users (id, email) values (gen_random_uuid(), $1) returning id",
    [`gen-${Date.now()}-${Math.random()}@example.com`],
  );
  userId = res.rows[0].id;
  sessionId = (await createDesignSession(db, { userId, aspectRatio: "portrait" })).id;
});

/**
 * Give a test user credits. Each call is its own intent (a fresh top-up),
 * so it mints its action id once, here — the same rule production follows.
 */
function seed(forUser: string, amount: number) {
  return grantAdminAdjustment(db, {
    userId: forUser,
    amount,
    adminActionId: `test-seed:${randomUUID()}`,
  });
}

async function count(table: string): Promise<number> {
  const { rows } = await pool.query(`select count(*)::int as n from ${table}`);
  return rows[0].n;
}

async function titleJobs() {
  const { rows } = await pool.query(
    "select data, singleton_key from pgboss.job where name = $1",
    [JOBS.summariseSessionTitle],
  );
  return rows as {
    data: { sessionId: string; prompt: string };
    singleton_key: string;
  }[];
}

async function generateJobs() {
  const { rows } = await pool.query(
    "select data, singleton_key, state from pgboss.job where name = $1",
    [JOBS.generateImage],
  );
  return rows as { data: { designId: string }; singleton_key: string; state: string }[];
}

describe("createSessionAndEnqueueGeneration (lazy session creation)", () => {
  // beforeEach already opened one session, so counts are measured as deltas.
  it("opens the session and generates into it in one go", async () => {
    await seed(userId, 3);
    const before = await count("design_sessions");

    const result = await createSessionAndEnqueueGeneration(db, boss, {
      userId,
      aspectRatio: "portrait",
      requestId: randomUUID(),
      prompt: "  a lighthouse at dusk  ",
    });

    expect(result.duplicate).toBe(false);
    expect(result.jobId).toBeTruthy();
    expect(result.balanceAfter).toBe(2);
    expect(await count("design_sessions")).toBe(before + 1);

    const design = await getDesign(db, result.designId);
    expect(design?.sessionId).toBe(result.sessionId);
    expect(design?.prompt).toBe("a lighthouse at dusk");
    expect(design?.status).toBe("pending");

    const sessions = await listUserSessions(db, userId);
    expect(sessions.map((s) => s.id)).toContain(result.sessionId);
  });

  it("queues the title job once, for the first prompt only", async () => {
    await seed(userId, 3);
    const { sessionId: newSession } = await createSessionAndEnqueueGeneration(
      db,
      boss,
      {
        userId,
        aspectRatio: "portrait",
        requestId: randomUUID(),
        prompt: "a lone figure on a pier",
      },
    );

    const queued = await titleJobs();
    expect(queued).toHaveLength(1);
    expect(queued[0]!.data).toEqual({
      sessionId: newSession,
      prompt: "a lone figure on a pier",
    });

    // A second generation in that session is not a second naming.
    await enqueueGeneration(db, boss, {
      userId,
      sessionId: newSession,
      requestId: randomUUID(),
      prompt: "make it warmer",
    });
    expect(await titleJobs()).toHaveLength(1);
  });

  /**
   * A title is decoration. If naming the session can't even be queued, the
   * generation the user paid for still has to go through.
   */
  it("still generates when the title job cannot be queued", async () => {
    await seed(userId, 3);
    const send = boss.send.bind(boss);
    const spy = vi
      .spyOn(boss, "send")
      .mockImplementation(async (name: string, ...rest: unknown[]) => {
        if (name === JOBS.summariseSessionTitle) {
          throw new Error("queue is on fire");
        }
        return (send as never as (...a: unknown[]) => Promise<string | null>)(
          name,
          ...rest,
        );
      });

    try {
      const result = await createSessionAndEnqueueGeneration(db, boss, {
        userId,
        aspectRatio: "portrait",
        requestId: randomUUID(),
        prompt: "a lone figure on a pier",
      });
      expect(result.designId).toBeTruthy();
      expect(result.jobId).toBeTruthy();
      expect(await getBalance(db, userId)).toBe(2); // charged exactly once
      expect((await getDesign(db, result.designId))?.status).toBe("pending");
      expect(await titleJobs()).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * The whole point of lazy creation: a refused generation must not leave an
   * empty session in the studio.
   */
  it("leaves NO session behind when the generation is refused", async () => {
    const before = await count("design_sessions");

    await expect(
      createSessionAndEnqueueGeneration(db, boss, {
        userId,
        aspectRatio: "portrait",
        requestId: randomUUID(),
        prompt: "no credits for this",
      }),
    ).rejects.toBeInstanceOf(InsufficientCreditsError);

    expect(await count("design_sessions")).toBe(before);
    expect(await count("designs")).toBe(0);
  });

  it("rejects a bad requestId or an empty prompt before creating anything", async () => {
    await seed(userId, 3);
    const before = await count("design_sessions");

    await expect(
      createSessionAndEnqueueGeneration(db, boss, {
        userId,
        aspectRatio: "portrait",
        requestId: "not-a-uuid",
        prompt: "x",
      }),
    ).rejects.toBeInstanceOf(InvalidGenerationRequestError);
    await expect(
      createSessionAndEnqueueGeneration(db, boss, {
        userId,
        aspectRatio: "portrait",
        requestId: randomUUID(),
        prompt: "   ",
      }),
    ).rejects.toBeInstanceOf(InvalidGenerationRequestError);

    expect(await count("design_sessions")).toBe(before);
    expect(await getBalance(db, userId)).toBe(3);
  });

  it("a replayed requestId reuses the first session — no second piece, no second charge", async () => {
    await seed(userId, 3);
    const requestId = randomUUID();
    const before = await count("design_sessions");

    const first = await createSessionAndEnqueueGeneration(db, boss, {
      userId,
      aspectRatio: "portrait",
      requestId,
      prompt: "same prompt",
    });
    const second = await createSessionAndEnqueueGeneration(db, boss, {
      userId,
      aspectRatio: "portrait",
      requestId,
      prompt: "same prompt",
    });

    expect(second.duplicate).toBe(true);
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.designId).toBe(first.designId);
    expect(second.jobId).toBeNull();
    expect(await count("design_sessions")).toBe(before + 1);
    expect(await count("designs")).toBe(1);
    expect(await getBalance(db, userId)).toBe(2); // charged once
  });

  it("refuses the same requestId carrying a different prompt", async () => {
    await seed(userId, 3);
    const requestId = randomUUID();
    await createSessionAndEnqueueGeneration(db, boss, {
      userId,
      aspectRatio: "portrait",
      requestId,
      prompt: "first prompt",
    });

    await expect(
      createSessionAndEnqueueGeneration(db, boss, {
        userId,
        aspectRatio: "portrait",
        requestId,
        prompt: "a different prompt",
      }),
    ).rejects.toBeInstanceOf(InvalidGenerationRequestError);
  });
});

describe("linear iteration (parentDesignId)", () => {
  /** A ready design with a preview, i.e. something iterable. */
  async function readyDesign() {
    const designId = await enqueueOne();
    const storage = memoryStorage();
    await runGenerateImage({ db, provider: fakeProvider(), storage }, designId);
    expect((await getDesign(db, designId))?.status).toBe("ready");
    return { designId, storage };
  }

  it("stores parentDesignId on the new design", async () => {
    const { designId: parentId } = await readyDesign();
    await seed(userId, 1);

    const { designId } = await enqueueGeneration(db, boss, {
      requestId: randomUUID(),
      userId,
      sessionId,
      parentDesignId: parentId,
      prompt: "make it warmer",
    });

    expect((await getDesign(db, designId))?.parentDesignId).toBe(parentId);
  });

  it("passes the parent's preview to the provider as the reference image", async () => {
    const { designId: parentId } = await readyDesign();
    await seed(userId, 1);
    const { designId } = await enqueueGeneration(db, boss, {
      requestId: randomUUID(),
      userId,
      sessionId,
      parentDesignId: parentId,
      prompt: "make it warmer",
    });

    // Same storage, so the parent's preview written above is readable here.
    const storage = memoryStorage();
    await storage.put({
      key: storageKeys.preview(parentId),
      body: Buffer.from("parent"),
      contentType: "image/webp",
    });
    const provider = fakeProvider();
    const outcome = await runGenerateImage({ db, provider, storage }, designId);

    expect(outcome.status).toBe("ready");
    expect(provider.calls[0]?.parentImageUrl).toBe(
      `memory://${storageKeys.preview(parentId)}`,
    );
  });

  it("asks an edit to drop any frame the reference already has", async () => {
    const { designId: parentId } = await readyDesign();
    await seed(userId, 1);
    const { designId } = await enqueueGeneration(db, boss, {
      requestId: randomUUID(),
      userId,
      sessionId,
      parentDesignId: parentId,
      prompt: "make it warmer",
    });

    const storage = memoryStorage();
    await storage.put({
      key: storageKeys.preview(parentId),
      body: Buffer.from("parent"),
      contentType: "image/webp",
    });
    const provider = fakeProvider();
    await runGenerateImage({ db, provider, storage }, designId);

    const sent = provider.calls[0]!.prompt;
    expect(sent).toContain("make it warmer");
    expect(sent).toMatch(/do not include any picture frame/i);
    // The extra line only an edit needs: the parent may already be framed.
    expect(sent).toMatch(/if the reference image contains a frame/i);
    expect((await getDesign(db, designId))?.prompt).toBe("make it warmer");
  });

  it("sends no reference image when there is no parent", async () => {
    const designId = await enqueueOne();
    const provider = fakeProvider();
    await runGenerateImage({ db, provider, storage: memoryStorage() }, designId);
    expect(provider.calls[0]?.parentImageUrl).toBeUndefined();
  });

  /**
   * The three ways a parent is unusable are refused identically, so a probe
   * can't tell another user's design from one that doesn't exist.
   */
  it("refuses a parent from another session, another user, or with no preview", async () => {
    // readyDesign seeds and spends exactly one credit, so top up after it.
    const { designId: mine } = await readyDesign();
    await seed(userId, 5);

    // Another session of the same user.
    const otherSession = await createDesignSession(db, {
      userId,
      aspectRatio: "portrait",
    });
    await expect(
      enqueueGeneration(db, boss, {
        requestId: randomUUID(),
        userId,
        sessionId: otherSession.id,
        parentDesignId: mine,
        prompt: "x",
      }),
    ).rejects.toBeInstanceOf(InvalidGenerationRequestError);

    // Another user entirely.
    const other = await pool.query(
      "insert into users (id, email) values (gen_random_uuid(), $1) returning id",
      [`parent-${randomUUID()}@example.com`],
    );
    const strangerId = other.rows[0].id;
    await seed(strangerId, 2);
    const strangerSession = await createDesignSession(db, {
      userId: strangerId,
      aspectRatio: "portrait",
    });
    await expect(
      enqueueGeneration(db, boss, {
        requestId: randomUUID(),
        userId: strangerId,
        sessionId: strangerSession.id,
        parentDesignId: mine,
        prompt: "x",
      }),
    ).rejects.toBeInstanceOf(InvalidGenerationRequestError);

    // A design in this session that never produced a preview.
    const pending = await enqueueGeneration(db, boss, {
      requestId: randomUUID(),
      userId,
      sessionId,
      prompt: "still pending",
    });
    await expect(
      enqueueGeneration(db, boss, {
        requestId: randomUUID(),
        userId,
        sessionId,
        parentDesignId: pending.designId,
        prompt: "x",
      }),
    ).rejects.toBeInstanceOf(InvalidGenerationRequestError);
  });

  it("refuses the iteration rather than silently generating without the reference", async () => {
    const { designId: parentId } = await readyDesign();
    await seed(userId, 1);
    const { designId } = await enqueueGeneration(db, boss, {
      requestId: randomUUID(),
      userId,
      sessionId,
      parentDesignId: parentId,
      prompt: "make it warmer",
    });

    // The parent's preview asset disappears between enqueue and the job
    // running — the one case the enqueue-time guard can't cover.
    await pool.query("delete from design_assets where design_id = $1", [
      parentId,
    ]);

    const provider = fakeProvider();
    const outcome = await runGenerateImage(
      { db, provider, storage: memoryStorage() },
      designId,
    );

    expect(outcome.status).toBe("failed");
    expect(provider.calls).toHaveLength(0); // never paid for a wrong result
    expect((await getDesign(db, designId))?.status).toBe("failed");
    expect(await getBalance(db, userId)).toBe(1); // refunded
  });
});

describe("listUserSessions", () => {
  it("returns only this user's sessions, newest first", async () => {
    const other = await pool.query(
      "insert into users (id, email) values (gen_random_uuid(), $1) returning id",
      [`other-${randomUUID()}@example.com`],
    );
    const otherId = other.rows[0].id;

    // beforeEach already opened one session for userId.
    const second = await createDesignSession(db, { userId, aspectRatio: "landscape" });
    const strangers = await createDesignSession(db, {
      userId: otherId,
      aspectRatio: "portrait",
    });

    const mine = await listUserSessions(db, userId);
    expect(mine.map((s) => s.id)).toEqual([second.id, sessionId]);
    expect(mine.map((s) => s.id)).not.toContain(strangers.id);

    const theirs = await listUserSessions(db, otherId);
    expect(theirs.map((s) => s.id)).toEqual([strangers.id]);
  });
});

describe("enqueueGeneration", () => {
  /**
   * The happy path commits all three together: a pending design, a -1 spend
   * pointing at it, and a job carrying its id.
   */
  it("creates the design, spends one credit and queues the job atomically", async () => {
    await seed(userId, 3);

    const { designId, jobId, balanceAfter } = await enqueueGeneration(db, boss, { requestId: randomUUID(),
      userId,
      sessionId,
      prompt: "  a lighthouse at dusk  ",
    });

    expect(jobId).toBeTruthy();
    expect(balanceAfter).toBe(2);
    expect(await getBalance(db, userId)).toBe(2);

    const design = await getDesign(db, designId);
    expect(design?.status).toBe("pending");
    expect(design?.prompt).toBe("a lighthouse at dusk");
    expect(design?.aspectRatio).toBe("portrait");
    expect(design?.params).toEqual({ resolution: "1K", providerAspectRatio: "3:4" });

    const { rows: spends } = await pool.query(
      "select amount, reason, ref_id from credit_transactions where amount < 0",
    );
    expect(spends).toEqual([{ amount: -1, reason: "generation_spend", ref_id: designId }]);

    const jobs = await generateJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.data).toEqual({ designId });
    expect(jobs[0]!.singleton_key).toBe(designId);
  });

  /**
   * IRL: a user with 0 credits hits generate. Nothing may survive — no
   * orphan pending design, no job that would run for free.
   */
  it("rolls everything back on insufficient credits", async () => {
    await expect(
      enqueueGeneration(db, boss, { requestId: randomUUID(), userId, sessionId, prompt: "free lunch" }),
    ).rejects.toBeInstanceOf(InsufficientCreditsError);

    expect(await count("designs")).toBe(0);
    expect(await count("credit_transactions")).toBe(0);
    expect(await generateJobs()).toHaveLength(0);
  });

  /**
   * IRL: the job insert fails after the spend succeeded (pg-boss error, or a
   * crash). The spend must roll back with it — never charge for a job that
   * won't run.
   */
  it("rolls back the spend when the job can't be queued", async () => {
    await seed(userId, 1);

    const brokenBoss = {
      send: async () => {
        throw new Error("pg-boss is down");
      },
    } as unknown as PgBoss;
    await expect(
      enqueueGeneration(db, brokenBoss, { requestId: randomUUID(), userId, sessionId, prompt: "x" }),
    ).rejects.toThrow("pg-boss is down");

    const decliningBoss = { send: async () => null } as unknown as PgBoss;
    await expect(
      enqueueGeneration(db, decliningBoss, { requestId: randomUUID(), userId, sessionId, prompt: "x" }),
    ).rejects.toThrow(/not created/);

    expect(await getBalance(db, userId)).toBe(1);
    expect(await count("designs")).toBe(0);
  });

  /** A job for the same design can't be queued twice (exclusive policy + singletonKey). */
  it("refuses a second queued job for the same design", async () => {
    await seed(userId, 1);
    const { designId } = await enqueueGeneration(db, boss, { requestId: randomUUID(), userId, sessionId, prompt: "x" });

    const dup = await boss.send(JOBS.generateImage, { designId }, { singletonKey: designId });
    expect(dup).toBeNull();
    expect(await generateJobs()).toHaveLength(1);
  });

  it("rejects another user's session, an empty prompt, and an oversized one", async () => {
    await seed(userId, 5);
    const other = await pool.query(
      "insert into users (id, email) values (gen_random_uuid(), 'other@example.com') returning id",
    );
    const otherSession = await createDesignSession(db, {
      userId: other.rows[0].id,
      aspectRatio: "portrait",
    });

    await expect(
      enqueueGeneration(db, boss, { requestId: randomUUID(), userId, sessionId: otherSession.id, prompt: "x" }),
    ).rejects.toBeInstanceOf(SessionNotFoundError);
    await expect(
      enqueueGeneration(db, boss, { requestId: randomUUID(), userId, sessionId, prompt: "   " }),
    ).rejects.toBeInstanceOf(InvalidGenerationRequestError);
    await expect(
      enqueueGeneration(db, boss, { requestId: randomUUID(), userId, sessionId, prompt: "x".repeat(2001) }),
    ).rejects.toBeInstanceOf(InvalidGenerationRequestError);

    expect(await getBalance(db, userId)).toBe(5);
    expect(await count("designs")).toBe(0);
  });
});

describe("enqueueGeneration idempotency (double-click protection)", () => {
  const PROMPT = "a pier at dusk";
  const enqueue = (requestId: string, prompt = PROMPT, as = userId, session = sessionId) =>
    enqueueGeneration(db, boss, { userId: as, sessionId: session, prompt, requestId });

  async function designsFor(ownerId = userId) {
    const { rows } = await pool.query(
      "select id, request_id from designs where owner_id = $1",
      [ownerId],
    );
    return rows as { id: string; request_id: string }[];
  }
  async function spendsFor(ownerId = userId) {
    const { rows } = await pool.query(
      "select ref_id, idempotency_key from credit_transactions where user_id = $1 and amount < 0",
      [ownerId],
    );
    return rows as { ref_id: string; idempotency_key: string }[];
  }

  /**
   * THE bug this guards: a double-click. 20 simultaneous submits carrying the
   * same requestId must collapse to one design, one spend and one job — and
   * every caller gets the same design id back (none of them errors).
   *
   * Repeated over 10 rounds so the race actually lands in different
   * interleavings; a single two-way pass can be green by luck.
   */
  it("20 concurrent submits with the SAME requestId → one design, one spend, one job", async () => {
    const ROUNDS = 10;
    await seed(userId, ROUNDS);

    for (let round = 1; round <= ROUNDS; round++) {
      const requestId = randomUUID();
      const results = await Promise.allSettled(
        Array.from({ length: 20 }, () => enqueue(requestId)),
      );

      const rejected = results.filter((r) => r.status === "rejected");
      expect(rejected, `round ${round}: ${JSON.stringify(rejected)}`).toHaveLength(0);
      const values = results.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof enqueue>>>).value);

      expect(new Set(values.map((v) => v.designId)).size).toBe(1);
      expect(values.filter((v) => !v.duplicate)).toHaveLength(1);
      expect(values.filter((v) => v.jobId !== null)).toHaveLength(1);

      expect(await designsFor()).toHaveLength(round);
      expect(await spendsFor()).toHaveLength(round);
      expect(await generateJobs()).toHaveLength(round);
      expect(await getBalance(db, userId)).toBe(ROUNDS - round);
    }
  });

  /** The normal case still works under the same pressure: distinct keys, distinct designs. */
  it("20 concurrent submits with DIFFERENT requestIds → 20 designs, 20 spends", async () => {
    await seed(userId, 20);

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => enqueue(randomUUID())),
    );

    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected, JSON.stringify(rejected)).toHaveLength(0);
    const ids = results.map((r) => (r as PromiseFulfilledResult<{ designId: string }>).value.designId);
    expect(new Set(ids).size).toBe(20);
    expect(await designsFor()).toHaveLength(20);
    expect(await spendsFor()).toHaveLength(20);
    expect(await generateJobs()).toHaveLength(20);
    expect(await getBalance(db, userId)).toBe(0);
  });

  /**
   * Both at once: 5 intended generations, each double/triple-submitted,
   * shuffled together. Exactly 5 charges, and every duplicate maps back to
   * its own original — never to another key's design.
   */
  it("interleaved duplicates across several keys → one design and one spend per key", async () => {
    const ROUNDS = 5;
    const KEYS = 5;
    const COPIES = 6;
    await seed(userId, ROUNDS * KEYS);

    for (let round = 1; round <= ROUNDS; round++) {
      const keys = Array.from({ length: KEYS }, () => randomUUID());
      const calls = keys.flatMap((k) => Array.from({ length: COPIES }, () => k));
      calls.sort(() => Math.random() - 0.5);

      const results = await Promise.all(calls.map((k) => enqueue(k).then((v) => ({ k, ...v }))));

      for (const k of keys) {
        const mine = results.filter((r) => r.k === k);
        expect(new Set(mine.map((r) => r.designId)).size).toBe(1);
        expect(mine.filter((r) => !r.duplicate)).toHaveLength(1);
      }
      expect(new Set(results.map((r) => r.designId)).size).toBe(KEYS);
      expect(await spendsFor()).toHaveLength(round * KEYS);
      expect(await getBalance(db, userId)).toBe((ROUNDS - round) * KEYS);
    }

    // Each spend is keyed to its design's own requestId.
    const designs = await designsFor();
    const spends = await spendsFor();
    for (const d of designs) {
      const spend = spends.filter((sp) => sp.ref_id === d.id);
      expect(spend).toHaveLength(1);
      expect(spend[0]!.idempotency_key).toBe(`generation_spend:${userId}:${d.request_id}`);
    }
  });

  /**
   * The edge that a naive ledger key gets wrong: the first click spends the
   * LAST credit. The duplicate must still return the design — not fail with
   * InsufficientCreditsError because the balance is now 0.
   */
  it("duplicates of a request that used the last credit still succeed", async () => {
    await seed(userId, 1);
    const requestId = randomUUID();

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => enqueue(requestId)),
    );

    expect(results.filter((r) => r.status === "rejected")).toHaveLength(0);
    expect(await designsFor()).toHaveLength(1);
    expect(await getBalance(db, userId)).toBe(0);
  });

  /** And the converse: distinct requests racing for one credit — exactly one wins, no orphans. */
  it("distinct requests racing for the last credit: one design, the rest refused", async () => {
    await seed(userId, 1);

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => enqueue(randomUUID())),
    );

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(19);
    for (const r of rejected) expect(r.reason).toBeInstanceOf(InsufficientCreditsError);
    expect(await designsFor()).toHaveLength(1);
    expect(await generateJobs()).toHaveLength(1);
    expect(await getBalance(db, userId)).toBe(0);
  });

  /** A slow retry (after the first committed) gets the same answer, flagged duplicate. */
  it("a later retry with the same requestId returns the original without charging", async () => {
    await seed(userId, 5);
    const requestId = randomUUID();

    const first = await enqueue(requestId);
    const retry = await enqueue(requestId);

    expect(first).toMatchObject({ duplicate: false, balanceAfter: 4 });
    expect(first.jobId).toBeTruthy();
    expect(retry).toEqual({
      designId: first.designId,
      jobId: null,
      balanceAfter: 4,
      duplicate: true,
    });
    expect(await getBalance(db, userId)).toBe(4);
    expect(await generateJobs()).toHaveLength(1);
  });

  /**
   * A request that rolled back (here: no credits) must not burn its key —
   * the user tops up and the same submit goes through.
   */
  it("a requestId whose first attempt rolled back can be used again", async () => {
    const requestId = randomUUID();
    await expect(enqueue(requestId)).rejects.toBeInstanceOf(InsufficientCreditsError);
    expect(await designsFor()).toHaveLength(0);

    await seed(userId, 1);
    const result = await enqueue(requestId);
    expect(result.duplicate).toBe(false);
    expect(await getBalance(db, userId)).toBe(0);
  });

  /** No server-side fallback: a missing or malformed key is refused, nothing written. */
  it("rejects a missing or malformed requestId", async () => {
    await seed(userId, 5);

    for (const bad of [undefined, null, "", "not-a-uuid", 42]) {
      await expect(
        enqueueGeneration(db, boss, {
          userId,
          sessionId,
          prompt: PROMPT,
          requestId: bad as unknown as string,
        }),
      ).rejects.toBeInstanceOf(InvalidGenerationRequestError);
    }
    expect(await designsFor()).toHaveLength(0);
    expect(await getBalance(db, userId)).toBe(5);
  });

  /** Same key, different prompt = client bug. Refuse; don't hand back the wrong design. */
  it("refuses a requestId reused for a different prompt", async () => {
    await seed(userId, 5);
    const requestId = randomUUID();
    await enqueue(requestId, "first prompt");

    await expect(enqueue(requestId, "second prompt")).rejects.toBeInstanceOf(
      InvalidGenerationRequestError,
    );
    expect(await designsFor()).toHaveLength(1);
    expect(await getBalance(db, userId)).toBe(4);
  });

  /** Keys are scoped per owner: two users can't collide even on an identical UUID. */
  it("the same requestId from two different users creates two designs", async () => {
    const other = await pool.query(
      "insert into users (id, email) values (gen_random_uuid(), 'other2@example.com') returning id",
    );
    const otherId: string = other.rows[0].id;
    const otherSession = await createDesignSession(db, { userId: otherId, aspectRatio: "portrait" });
    await seed(userId, 1);
    await seed(otherId, 1);

    const requestId = randomUUID();
    const [a, b] = await Promise.all([
      enqueue(requestId),
      enqueue(requestId, PROMPT, otherId, otherSession.id),
    ]);

    expect(a.designId).not.toBe(b.designId);
    expect(await getBalance(db, userId)).toBe(0);
    expect(await getBalance(db, otherId)).toBe(0);
  });

  /** The guarantee lives in the schema, not just in our code path. */
  it("the unique index rejects a second design for the same owner + requestId", async () => {
    await seed(userId, 1);
    const requestId = randomUUID();
    await enqueue(requestId);

    await expect(
      pool.query(
        `insert into designs (id, session_id, owner_id, request_id, prompt, model, aspect_ratio)
         values (gen_random_uuid(), $1, $2, $3, 'x', 'm', 'portrait')`,
        [sessionId, userId, requestId],
      ),
    ).rejects.toMatchObject({ code: "23505", constraint: "designs_owner_request_idx" });
  });
});

// --- the job ---------------------------------------------------------------

function memoryStorage(): Storage & { objects: Map<string, { body: Buffer; contentType: string }> } {
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  return {
    objects,
    async put({ key, body, contentType }) {
      objects.set(key, { body: Buffer.from(body as Uint8Array), contentType });
    },
    async getSignedUrl(key) {
      return `memory://${key}`;
    },
    getPublicUrl(key) {
      return `memory://${key}`;
    },
    async delete(key) {
      objects.delete(key);
    },
    async exists(key) {
      return objects.has(key);
    },
  };
}

/** Returns a 3:4 JPEG, like Gemini, and records what it was asked for. */
function fakeProvider() {
  const calls: GenerateParams[] = [];
  const provider: ImageProvider & { calls: GenerateParams[] } = {
    calls,
    async generate(params) {
      calls.push(params);
      const imageData = await sharp({
        create: { width: 768, height: 1024, channels: 3, background: "#6b2d8f" },
      })
        .jpeg()
        .toBuffer();
      return { imageData, mimeType: "image/jpeg", model: "fake-model-001" };
    },
  };
  return provider;
}

function failingProvider(kind: ImageProviderErrorKind): ImageProvider {
  return {
    async generate() {
      throw new ImageProviderError(`stubbed ${kind} failure`, { kind });
    },
  };
}

async function enqueueOne() {
  await seed(userId, 1);
  const { designId } = await enqueueGeneration(db, boss, { requestId: randomUUID(),
    userId,
    sessionId,
    prompt: "a lone figure on a pier",
  });
  expect(await getBalance(db, userId)).toBe(0);
  return designId;
}

async function assets(designId: string) {
  const { rows } = await pool.query(
    "select kind, storage_key, width, height from design_assets where design_id = $1",
    [designId],
  );
  return rows;
}

describe("runGenerateImage", () => {
  it("generates, crops to A-series, stores the preview and marks ready", async () => {
    const designId = await enqueueOne();
    const provider = fakeProvider();
    const storage = memoryStorage();

    const outcome = await runGenerateImage({ db, provider, storage }, designId);
    expect(outcome.status).toBe("ready");

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toMatchObject({
      aspectRatio: "3:4",
      resolution: "1K",
    });
    // The provider gets the user's prompt plus the print constraints…
    expect(provider.calls[0]!.prompt).toContain("a lone figure on a pier");
    expect(provider.calls[0]!.prompt).toMatch(
      /do not include any picture frame/i,
    );
    // …but the stored prompt stays the user's words, which is what the
    // thread renders back to them.
    expect((await getDesign(db, designId))?.prompt).toBe(
      "a lone figure on a pier",
    );

    const key = storageKeys.preview(designId);
    const object = storage.objects.get(key);
    expect(object?.contentType).toBe("image/webp");
    const meta = await sharp(object!.body).metadata();
    expect(meta.height).toBe(1024);
    expect(Math.abs(meta.width! / meta.height! - ASPECT_RATIOS.portrait.ratio)).toBeLessThan(0.002);

    expect(await assets(designId)).toEqual([
      { kind: "preview", storage_key: key, width: meta.width, height: 1024 },
    ]);
    const design = await getDesign(db, designId);
    expect(design?.status).toBe("ready");
    expect(design?.model).toBe("fake-model-001");
    // The spend stands: they got their image.
    expect(await getBalance(db, userId)).toBe(0);
  });

  /**
   * A redelivered job for a finished design must not call the paid provider
   * again or add a second asset row.
   */
  it("skips a design that is already ready", async () => {
    const designId = await enqueueOne();
    const deps = { db, provider: fakeProvider(), storage: memoryStorage() };
    await runGenerateImage(deps, designId);

    const again = await runGenerateImage(deps, designId);
    expect(again.status).toBe("skipped");
    expect(deps.provider.calls).toHaveLength(1);
    expect(await assets(designId)).toHaveLength(1);
  });

  /**
   * Moderation is terminal: fail and refund immediately, don't throw (a throw
   * would mean minutes of pointless retries for the same refusal).
   */
  it("handles a moderation rejection in-band: refund, no throw", async () => {
    const designId = await enqueueOne();
    const outcome = await runGenerateImage(
      { db, provider: failingProvider("moderation"), storage: memoryStorage() },
      designId,
    );

    expect(outcome).toMatchObject({ status: "failed", refunded: true });
    const design = await getDesign(db, designId);
    expect(design?.status).toBe("moderation_rejected");
    expect(design?.failureReason).toMatch(/stubbed moderation/);
    expect(await getBalance(db, userId)).toBe(1);
  });

  it("handles an invalid request in-band as plain failed", async () => {
    const designId = await enqueueOne();
    await runGenerateImage(
      { db, provider: failingProvider("invalid"), storage: memoryStorage() },
      designId,
    );
    expect((await getDesign(db, designId))?.status).toBe("failed");
    expect(await getBalance(db, userId)).toBe(1);
  });

  /**
   * Transient errors throw so pg-boss retries — and must NOT refund yet, or
   * a retry that then succeeds would deliver an image for free.
   */
  it("throws on a transient error without refunding", async () => {
    const designId = await enqueueOne();
    await expect(
      runGenerateImage(
        { db, provider: failingProvider("transient"), storage: memoryStorage() },
        designId,
      ),
    ).rejects.toThrow(/stubbed transient/);

    expect((await getDesign(db, designId))?.status).toBe("generating");
    expect(await getBalance(db, userId)).toBe(0);

    // ...and a retry can still succeed from `generating`.
    const retry = await runGenerateImage(
      { db, provider: fakeProvider(), storage: memoryStorage() },
      designId,
    );
    expect(retry.status).toBe("ready");
    expect(await getBalance(db, userId)).toBe(0);
  });

  /** Bugs and non-provider errors (here: a storage outage) also go the retry route. */
  it("throws when storage fails, leaving the design in flight", async () => {
    const designId = await enqueueOne();
    const storage = memoryStorage();
    storage.put = async () => {
      throw new Error("R2 503");
    };
    await expect(
      runGenerateImage({ db, provider: fakeProvider(), storage }, designId),
    ).rejects.toThrow("R2 503");
    expect((await getDesign(db, designId))?.status).toBe("generating");
    expect(await assets(designId)).toHaveLength(0);
  });

  /** An attempt whose job already expired must leave the design to the retry/DLQ. */
  it("does not mark ready once the job's signal has aborted", async () => {
    const designId = await enqueueOne();
    const ac = new AbortController();
    const provider: ImageProvider = {
      async generate(params) {
        const result = await fakeProvider().generate(params);
        ac.abort(); // expiry fires while we were waiting on the provider
        return result;
      },
    };
    await expect(
      runGenerateImage({ db, provider, storage: memoryStorage() }, designId, {
        signal: ac.signal,
      }),
    ).rejects.toThrow(/expired/);
    expect((await getDesign(db, designId))?.status).toBe("generating");
  });
});

describe("failGeneration (the DLQ path)", () => {
  /**
   * Terminal path and DLQ can both fire for one design. The refund is keyed
   * on the design id, so the user gets exactly one credit back.
   */
  it("refunds exactly once however many times it runs", async () => {
    const designId = await enqueueOne();

    expect(await failGeneration(db, { designId, reason: "first" })).toEqual({ refunded: true });
    expect(await failGeneration(db, { designId, reason: "second" })).toEqual({ refunded: false });

    expect(await getBalance(db, userId)).toBe(1);
    const design = await getDesign(db, designId);
    expect(design?.status).toBe("failed");
    expect(design?.failureReason).toBe("first");
  });

  /** A design the user already received must never be failed or refunded. */
  it("never refunds or fails a ready design", async () => {
    const designId = await enqueueOne();
    await runGenerateImage({ db, provider: fakeProvider(), storage: memoryStorage() }, designId);

    expect(await failGeneration(db, { designId, reason: "late DLQ" })).toEqual({ refunded: false });
    expect((await getDesign(db, designId))?.status).toBe("ready");
    expect(await getBalance(db, userId)).toBe(0);
  });

  /** And the reverse race: once failed + refunded, a late success can't flip it to ready. */
  it("a late success cannot resurrect a failed design", async () => {
    const designId = await enqueueOne();
    await failGeneration(db, { designId, reason: "DLQ won" });

    const outcome = await runGenerateImage(
      { db, provider: fakeProvider(), storage: memoryStorage() },
      designId,
    );
    expect(outcome.status).toBe("skipped");
    expect((await getDesign(db, designId))?.status).toBe("failed");
    expect(await assets(designId)).toHaveLength(0);
    expect(await getBalance(db, userId)).toBe(1);
  });
});
