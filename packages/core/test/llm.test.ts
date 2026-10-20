import { describe, it, expect } from "vitest";
import {
  cleanTitle,
  summarisePromptToTitle,
  LLMProviderError,
  type CompleteParams,
  type LLMProvider,
} from "../src/llm";

// Pure: no network, no key. The live round trip is `pnpm smoke llm-title`.

/** Returns whatever it's told to, and records what it was asked. */
function stubLLM(reply: string | (() => string)): LLMProvider & {
  calls: CompleteParams[];
} {
  const calls: CompleteParams[] = [];
  return {
    calls,
    async complete(params) {
      calls.push(params);
      return typeof reply === "function" ? reply() : reply;
    },
  };
}

describe("cleanTitle", () => {
  it("strips the ways a model dresses a title up", () => {
    expect(cleanTitle("Dusk Pier Study")).toBe("Dusk Pier Study");
    expect(cleanTitle('  "Dusk Pier Study"  ')).toBe("Dusk Pier Study");
    expect(cleanTitle("“Dusk Pier Study”")).toBe("Dusk Pier Study");
    expect(cleanTitle("Title: Dusk Pier Study")).toBe("Dusk Pier Study");
    expect(cleanTitle("Name — Dusk Pier Study")).toBe("Dusk Pier Study");
    expect(cleanTitle("Dusk Pier Study.")).toBe("Dusk Pier Study");
    expect(cleanTitle("Dusk   Pier\tStudy")).toBe("Dusk Pier Study");
  });

  it("keeps only the first line when the model explains itself", () => {
    expect(cleanTitle("Dusk Pier Study\n\nThis captures the mood of…")).toBe(
      "Dusk Pier Study",
    );
  });

  it("truncates on a word boundary rather than mid-word", () => {
    const long = "Extraordinarily Long Title About A Figure Standing Alone";
    const cleaned = cleanTitle(long);
    expect(cleaned.length).toBeLessThanOrEqual(48);
    expect(long.startsWith(cleaned)).toBe(true);
    expect(cleaned.endsWith(" ")).toBe(false);
    // Whatever survived is whole words.
    expect(long.split(" ")).toEqual(expect.arrayContaining(cleaned.split(" ")));
  });

  it("returns empty for input with nothing in it", () => {
    expect(cleanTitle("   ")).toBe("");
    expect(cleanTitle('""')).toBe("");
  });
});

describe("summarisePromptToTitle", () => {
  it("sends a system instruction and disables reasoning", async () => {
    const llm = stubLLM("Dusk Pier Study");
    await summarisePromptToTitle("a lone figure on a pier", llm);

    const call = llm.calls[0]!;
    expect(call.prompt).toBe("a lone figure on a pier");
    expect(call.system).toContain("2 to 4 words");
    expect(call.reasoning).toBe("none");
    // Capped, but with headroom: thinking tokens come out of this same
    // budget and Gemini 3 can't be told to stop thinking entirely, so too
    // small a ceiling returns empty text. See the note in titles.ts.
    expect(call.maxOutputTokens).toBeGreaterThanOrEqual(64);
    expect(call.maxOutputTokens).toBeLessThanOrEqual(512);
  });

  it("cleans whatever the model actually returns", async () => {
    const llm = stubLLM('"Pale Eucalyptus Branch."');
    expect(await summarisePromptToTitle("eucalyptus", llm)).toBe(
      "Pale Eucalyptus Branch",
    );
  });

  it("refuses an empty prompt without calling the model", async () => {
    const llm = stubLLM("anything");
    await expect(summarisePromptToTitle("   ", llm)).rejects.toBeInstanceOf(
      LLMProviderError,
    );
    expect(llm.calls).toHaveLength(0);
  });

  it("throws rather than returning an empty title", async () => {
    const llm = stubLLM('""');
    await expect(
      summarisePromptToTitle("a lone figure", llm),
    ).rejects.toBeInstanceOf(LLMProviderError);
  });
});
