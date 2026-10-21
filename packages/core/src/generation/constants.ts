import type { ImageResolution } from "../providers/types";
import type { AspectRatio } from "../designs/constants";

/** Credits charged per generation — spent at enqueue, refunded on failure. */
export const GENERATION_CREDIT_COST = 1;

/** The iterate-loop default. Print-resolution renders are a later ticket. */
export const DEFAULT_GENERATION_RESOLUTION: ImageResolution = "1K";

export const MAX_PROMPT_LENGTH = 2000;

/**
 * What we ask the provider for, per design aspect ratio. Providers don't do
 * A-series (1:√2), so we request the nearest ratio that is slightly too
 * wide/tall and centre-crop down to the exact ASPECT_RATIOS value.
 */
export const PROVIDER_ASPECT_RATIO: Record<AspectRatio, string> = {
  portrait: "3:4",
  landscape: "4:3",
  square: "1:1",
};

/** Stored in designs.params at enqueue, read back by the job. */
export type GenerationParams = {
  resolution: ImageResolution;
  providerAspectRatio: string;
  /**
   * The build that made this design. Write-only provenance — nothing reads
   * it back at runtime. See getAppVersion.
   */
  appVersion: string;
};
