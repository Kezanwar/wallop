import { getLLMProvider } from "./provider";
import { LLMProviderError, type LLMProvider } from "./types";

const SYSTEM = `You name artworks.

Given the prompt an artist used to generate an image, reply with a short title
for it.

Rules:
- 2 to 4 words.
- Title Case.
- Evocative but concrete: name the subject and its mood, not the medium.
- Reply with the title and NOTHING else. No quotes, no trailing punctuation,
  no explanation, no "Title:" prefix.

Examples:
Prompt: "Moody cinematic photograph, a lone figure at the end of a long pier in full silhouette against a violet dusk glow"
Dusk Pier Study

Prompt: "Abstract botanical study, single eucalyptus branch, flat sage and cream, minimalist"
Pale Eucalyptus Branch`;

/**
 * Headroom, not a target — the title itself measures 3-4 tokens.
 *
 * Thinking tokens come out of THIS budget and Gemini 3 cannot be told to stop
 * thinking. Measured on gemini-3.8-flash at the lowest level it accepts: 0
 * thinking tokens on most calls but 183 on one of three, for the same trivial
 * task. At 24 the model spent the whole allowance reasoning and returned
 * empty text with finishReason=MAX_TOKENS, intermittently.
 *
 * So this is a safety valve, not a budget: you are billed for tokens actually
 * produced, and cleanTitle keeps only the first line, so a ceiling far above
 * the real output costs nothing and buys reliability.
 */
const MAX_OUTPUT_TOKENS = 512;
const MAX_TITLE_LENGTH = 48;

/**
 * Turn a generation prompt into a short human title for its session.
 *
 * The provider is a defaulted parameter so tests can pass a stub without the
 * singleton (and without an API key).
 */
export async function summarisePromptToTitle(
  prompt: string,
  llm: LLMProvider = getLLMProvider(),
): Promise<string> {
  const trimmed = prompt.trim();
  if (!trimmed) {
    throw new LLMProviderError("Cannot title an empty prompt", {
      kind: "invalid",
    });
  }

  const raw = await llm.complete({
    prompt: trimmed,
    system: SYSTEM,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    // Low, not zero: titles should be a little evocative, not random.
    temperature: 0.4,
    // Required, not merely cheaper. Thinking tokens come out of the same
    // budget as the answer, so with MAX_OUTPUT_TOKENS this small the model
    // could spend the lot reasoning and return nothing.
    reasoning: "none",
  });

  const title = cleanTitle(raw);
  if (!title) {
    throw new LLMProviderError(
      `Model returned no usable title (got: ${JSON.stringify(raw.slice(0, 80))})`,
      { kind: "transient" },
    );
  }
  return title;
}

/**
 * The system prompt asks for a bare title; this is the belt to its braces.
 * Models drift back to quoting, prefixing and explaining, and a stray quote
 * mark would be visible in the studio list forever.
 */
export function cleanTitle(raw: string): string {
  let title = raw.trim().split("\n")[0]?.trim() ?? "";
  title = title.replace(/^(title|name)\s*[:\-—]\s*/i, "");
  title = title.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "");
  title = title.replace(/[.,;:!]+$/, "");
  title = title.replace(/\s+/g, " ").trim();
  if (title.length > MAX_TITLE_LENGTH) {
    // Cut on a word boundary rather than mid-word.
    title = title.slice(0, MAX_TITLE_LENGTH).replace(/\s+\S*$/, "");
  }
  return title;
}
