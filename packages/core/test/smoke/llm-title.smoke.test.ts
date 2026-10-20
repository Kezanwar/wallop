import { describe, expect, test } from "vitest";
import {
  getLLMProvider,
  summarisePromptToTitle,
  resolveTextModel,
  type LLMUsage,
} from "../../src/llm";

/**
 * The text model, live. Titles a few real prompts and prints each with its
 * timing and token usage, so title quality can be eyeballed and the per-call
 * cost is visible before the wand composer leans on this.
 *
 * PAID, but trivially so: these are tens of tokens each.
 *
 *   pnpm smoke llm-title
 */
const missing = ["GEMINI_API_KEY"].filter((name) => !process.env[name]);

const PROMPTS = [
  "Moody cinematic photograph, a lone figure at the end of a long pier in full " +
    "silhouette against a violet-to-magenta-to-orange dusk glow, shot on film.",
  "Abstract botanical study, single eucalyptus branch, flat sage and cream, minimalist",
  "digitally drawn setting sun hovering over the sea, cosmic and modern, minimal " +
    "and artsy, grainy poster texture",
];

describe.skipIf(missing.length > 0)("text LLM: session titles (live)", () => {
  test("turns real generation prompts into short titles", async () => {
    const llm = getLLMProvider();
    const rows: string[] = [];
    let totalTokens = 0;

    for (const prompt of PROMPTS) {
      let usage: LLMUsage = {};
      const started = Date.now();
      const title = await summarisePromptToTitle(prompt, {
        complete: (params) =>
          llm.complete({ ...params, onUsage: (u) => (usage = u) }),
      });
      const elapsed = Date.now() - started;
      totalTokens += usage.totalTokens ?? 0;

      // The shape the title job depends on: short, bare, no stray punctuation.
      expect(title.length).toBeGreaterThan(0);
      expect(title.length).toBeLessThanOrEqual(48);
      expect(title).not.toMatch(/^["'“]/);
      expect(title).not.toMatch(/[.;:]$/);
      expect(title.split(/\s+/).length).toBeLessThanOrEqual(6);

      rows.push(
        [
          `  prompt   ${prompt.slice(0, 72)}${prompt.length > 72 ? "…" : ""}`,
          `  title    ${title}`,
          `  tokens   in=${usage.inputTokens ?? "?"} out=${usage.outputTokens ?? "?"} ` +
            `thinking=${usage.thinkingTokens ?? 0} total=${usage.totalTokens ?? "?"}`,
          `  elapsed  ${elapsed}ms`,
          "",
        ].join("\n"),
      );
    }

    console.log(
      [
        "",
        "── session titles ───────────────────────────────────",
        `model  ${resolveTextModel()}`,
        "",
        ...rows,
        `total tokens across ${PROMPTS.length} calls: ${totalTokens}`,
        "─────────────────────────────────────────────────────",
        "",
      ].join("\n"),
    );
  });

  test("an empty title budget is reported, not silently swallowed", async () => {
    // Thinking ON with a tiny budget is the trap the `reasoning` option
    // exists for: the model spends the allowance reasoning and returns no
    // text. Proves the provider surfaces that rather than returning "".
    const llm = getLLMProvider();
    await expect(
      llm.complete({
        prompt: "Name this: a lone figure on a pier at dusk",
        system: "Reply with a 2-4 word title and nothing else.",
        maxOutputTokens: 8,
        reasoning: "default",
      }),
    ).rejects.toThrow(/no text|MAX_TOKENS/i);
  });
});
