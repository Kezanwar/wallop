import { describe, it, expect } from "vitest";
import { buildGenerationPrompt } from "../src/generation/prompt";

// Pure string assembly — no DB, no network.

const NO_FRAME = /do not include any picture frame/i;
const REMOVE_FRAME = /if the reference image contains a frame/i;

describe("buildGenerationPrompt", () => {
  it("leads with the user's prompt, untouched", () => {
    const built = buildGenerationPrompt(
      "  a renaissance painting of a couple  ",
    );
    expect(built.startsWith("a renaissance painting of a couple")).toBe(true);
  });

  it("forbids framing on a fresh generation", () => {
    const built = buildGenerationPrompt("a renaissance painting of a couple");
    expect(built).toMatch(NO_FRAME);
    expect(built).toMatch(/edge-to-edge/i);
    // Nothing about a reference image — there isn't one.
    expect(built).not.toMatch(REMOVE_FRAME);
  });

  it("forbids framing on an edit too, and strips one already there", () => {
    const built = buildGenerationPrompt("make it warmer", { isEdit: true });
    expect(built.startsWith("make it warmer")).toBe(true);
    expect(built).toMatch(NO_FRAME);
    expect(built).toMatch(REMOVE_FRAME);
  });

  it("states the no-frame rule once, not once per line", () => {
    const built = buildGenerationPrompt("make it warmer", { isEdit: true });
    expect(built.match(NO_FRAME)).toHaveLength(1);
  });

  it("reads as an instruction followed by conditions", () => {
    const built = buildGenerationPrompt("make it warmer", { isEdit: true });
    const [instruction, blank, header] = built.split("\n");
    expect(instruction).toBe("make it warmer");
    expect(blank).toBe("");
    expect(header).toMatch(/output requirements/i);
  });
});
