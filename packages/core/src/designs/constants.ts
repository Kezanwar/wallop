export const ASPECT_RATIOS = {
  portrait: {
    name: "portrait",
    ratio: 1 / 1.4142,
    label: "Portrait (A-series)",
  },
  landscape: {
    name: "landscape",
    ratio: 1.4142,
    label: "Landscape (A-series)",
  },
  square: { name: "square", ratio: 1, label: "Square" },
} as const;

export type AspectRatio = keyof typeof ASPECT_RATIOS;

// Square is schema-supported but not offered in v1 — one aspect ratio
// family means one code path to get right in the generation pipeline.
export const AVAILABLE_ASPECT_RATIOS: AspectRatio[] = ["portrait", "landscape"];

export const DESIGN_STATUS = {
  pending: "pending",
  generating: "generating",
  ready: "ready",
  failed: "failed",
  moderationRejected: "moderation_rejected",
} as const;

export const VISIBILITY = {
  private: "private",
  unlisted: "unlisted",
  public: "public",
} as const;

export const ASSET_KIND = {
  preview: "preview",
  print: "print",
  mockup: "mockup",
} as const;
