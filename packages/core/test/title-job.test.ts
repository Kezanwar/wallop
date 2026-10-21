import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { schema } from "@wallop/db";
import { createDesignSession } from "../src/designs/designs";
import { runSummariseSessionTitle } from "../src/llm/title-job";
import { LLMProviderError, type LLMProvider } from "../src/llm/types";

// Real Postgres, stubbed model: no network, no key, no spend.

const pool = new Pool({ connectionString: process.env.DATABASE_URL_TEST });
const db = drizzle(pool, { schema }) as never as Parameters<
  typeof runSummariseSessionTitle
>[0]["db"];

let userId: string;
let sessionId: string;

beforeAll(async () => {
  const res = await pool.query(
    "insert into users (id, email) values (gen_random_uuid(), $1) returning id",
    [`title-${randomUUID()}@example.com`],
  );
  userId = res.rows[0].id;
});

afterAll(async () => {
  await pool.query("delete from users where id = $1", [userId]);
  await pool.end();
});

beforeEach(async () => {
  sessionId = (
    await createDesignSession(db, { userId, aspectRatio: "portrait" })
  ).id;
});

function stubLLM(reply: string | Error): LLMProvider & { calls: number } {
  return {
    calls: 0,
    async complete() {
      this.calls += 1;
      if (reply instanceof Error) throw reply;
      return reply;
    },
  } as LLMProvider & { calls: number };
}

async function titleOf(id: string) {
  const [row] = await db
    .select({ title: schema.designSessions.title })
    .from(schema.designSessions)
    .where(eq(schema.designSessions.id, id));
  return row?.title ?? null;
}

describe("runSummariseSessionTitle", () => {
  it("names a session that has no title yet", async () => {
    const llm = stubLLM("Dusk Pier Study");

    const outcome = await runSummariseSessionTitle(
      { db, llm },
      { sessionId, prompt: "a lone figure at the end of a long pier" },
    );

    expect(outcome).toEqual({
      status: "titled",
      sessionId,
      title: "Dusk Pier Study",
    });
    expect(await titleOf(sessionId)).toBe("Dusk Pier Study");
  });

  /**
   * A redelivery, or a job landing after the user renamed the session, must
   * not overwrite what's there — and must not pay the model to find that out.
   */
  it("leaves an existing title alone, without calling the model", async () => {
    await db
      .update(schema.designSessions)
      .set({ title: "My Own Name" })
      .where(eq(schema.designSessions.id, sessionId));

    const llm = stubLLM("Something Else Entirely");
    const outcome = await runSummariseSessionTitle(
      { db, llm },
      { sessionId, prompt: "a lone figure" },
    );

    expect(outcome).toEqual({
      status: "skipped",
      sessionId,
      reason: "already titled",
    });
    expect(llm.calls).toBe(0);
    expect(await titleOf(sessionId)).toBe("My Own Name");
  });

  it("skips a session that no longer exists", async () => {
    const llm = stubLLM("Never Used");
    const gone = randomUUID();

    const outcome = await runSummariseSessionTitle(
      { db, llm },
      { sessionId: gone, prompt: "a lone figure" },
    );

    expect(outcome.status).toBe("skipped");
    expect(llm.calls).toBe(0);
  });

  /**
   * A title is cosmetic: a refusal from the model is the end of it, not a
   * loud failure. The session keeps its "Untitled piece" fallback.
   */
  it("gives up quietly on a terminal model error", async () => {
    const llm = stubLLM(
      new LLMProviderError("refused", { kind: "moderation" }),
    );

    const outcome = await runSummariseSessionTitle(
      { db, llm },
      { sessionId, prompt: "something the model dislikes" },
    );

    expect(outcome).toEqual({
      status: "skipped",
      sessionId,
      reason: "moderation",
    });
    expect(await titleOf(sessionId)).toBeNull();
  });

  it("rethrows a transient error so pg-boss can retry", async () => {
    const llm = stubLLM(new LLMProviderError("502", { kind: "transient" }));

    await expect(
      runSummariseSessionTitle(
        { db, llm },
        { sessionId, prompt: "a lone figure" },
      ),
    ).rejects.toBeInstanceOf(LLMProviderError);
    expect(await titleOf(sessionId)).toBeNull();
  });
});
