/**
 * The one place the prompt actually sent to the image provider is assembled.
 *
 * Wallop sells the ARTWORK, not a picture of a framed artwork: the buyer (or
 * Printful) frames it. A frame baked into the file wastes printable area and
 * ends up framed again on the wall. Models love adding one unprompted —
 * "renaissance painting" reliably produced a gilt frame — so it has to be
 * ruled out explicitly, on every generation, with no opt-out.
 *
 * Applied at send time and never stored: designs.prompt stays exactly what
 * the user typed, so the thread shows their words rather than ours.
 *
 * This list is expected to grow (bleed, text, watermarks, signatures). Add
 * constraints here rather than inlining them at a call site.
 */
const PRINT_CONSTRAINTS = [
  "The artwork must fill the entire image edge-to-edge. Do not include any " +
    "picture frame, border, mat, mount, or framing device around it — no " +
    "ornate frames, no painted borders, no vignette framing. The art extends " +
    "to all four edges.",
];

/**
 * Only for edits. The reference image may already contain a frame (generated
 * before this wrapper existed, or hallucinated anyway), and "make it warmer"
 * would otherwise faithfully preserve it.
 */
const EDIT_CONSTRAINTS = [
  "If the reference image contains a frame, border or mat, remove it — the " +
    "artwork itself should fill the whole canvas.",
];

const HEADER = "Output requirements for the final image:";

export function buildGenerationPrompt(
  userPrompt: string,
  options: { isEdit?: boolean } = {},
): string {
  const constraints = options.isEdit
    ? [...PRINT_CONSTRAINTS, ...EDIT_CONSTRAINTS]
    : PRINT_CONSTRAINTS;

  // The user's text leads, untouched. The requirements follow as a block, so
  // an edit instruction ("make it warmer") still reads as the instruction and
  // these read as conditions on the result.
  return [
    userPrompt.trim(),
    "",
    HEADER,
    ...constraints.map((line) => `- ${line}`),
  ].join("\n");
}
