import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { cropToAspect, cropBox } from "../src/images/crop";
import { ASPECT_RATIOS } from "../src/designs/constants";

/**
 * A solid image with a 1px marker column at the exact horizontal centre, so
 * we can prove the crop is centred and not just the right size.
 */
async function fixture(width: number, height: number) {
  return sharp({
    create: { width, height, channels: 3, background: "#000000" },
  })
    .composite([
      {
        input: {
          create: {
            width: 2,
            height,
            channels: 3,
            background: "#ffffff",
          },
        },
        left: Math.floor(width / 2) - 1,
        top: 0,
      },
    ])
    .jpeg({ quality: 95 })
    .toBuffer();
}

const A_PORTRAIT = ASPECT_RATIOS.portrait.ratio; // 1 / 1.4142
const A_LANDSCAPE = ASPECT_RATIOS.landscape.ratio; // 1.4142

describe("cropToAspect", () => {
  /**
   * The case that matters: Gemini returns 3:4 (0.75), prints are A-series
   * (0.7071). Too wide, so width is trimmed and height kept.
   *
   * IRL: every portrait generation's preview.
   */
  it("crops a 3:4 portrait to A-series by trimming width", async () => {
    const out = await cropToAspect(await fixture(768, 1024), A_PORTRAIT);

    expect(out.height).toBe(1024);
    expect(out.width).toBe(Math.round(1024 * A_PORTRAIT)); // 724
    expect(Math.abs(out.width / out.height - A_PORTRAIT)).toBeLessThan(0.002);
    expect(out.mimeType).toBe("image/webp");

    const meta = await sharp(out.data).metadata();
    expect(meta.format).toBe("webp");
    expect([meta.width, meta.height]).toEqual([out.width, out.height]);
  });

  /** Same for landscape: 4:3 (1.333) is too TALL for 1.4142, so height is trimmed. */
  it("crops a 4:3 landscape to A-series by trimming height", async () => {
    const out = await cropToAspect(await fixture(1024, 768), A_LANDSCAPE);

    expect(out.width).toBe(1024);
    expect(out.height).toBe(Math.round(1024 / A_LANDSCAPE)); // 724
    expect(Math.abs(out.width / out.height - A_LANDSCAPE)).toBeLessThan(0.002);
  });

  /**
   * Centre, not left-aligned: the white marker column sits in the middle of
   * the input and must still be in the middle of the output.
   */
  it("crops from the centre", async () => {
    const out = await cropToAspect(await fixture(768, 1024), A_PORTRAIT, "png");
    const { data, info } = await sharp(out.data)
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Brightest column in the middle row.
    const row = Math.floor(info.height / 2) * info.width;
    let brightest = 0;
    for (let x = 1; x < info.width; x++) {
      if (data[row + x]! > data[row + brightest]!) brightest = x;
    }
    expect(Math.abs(brightest - info.width / 2)).toBeLessThanOrEqual(2);
  });

  /** Already the right shape → unchanged dimensions, never upscaled. */
  it("leaves an image already at the target ratio the same size", async () => {
    const out = await cropToAspect(await fixture(500, 500), 1);
    expect([out.width, out.height]).toEqual([500, 500]);
  });

  it("rejects a nonsense ratio", async () => {
    const img = await fixture(10, 10);
    await expect(cropToAspect(img, 0)).rejects.toThrow(/invalid target ratio/);
    await expect(cropToAspect(img, Number.NaN)).rejects.toThrow(/invalid target ratio/);
  });

  it("cropBox never exceeds the source", () => {
    for (const [w, h] of [
      [896, 1200],
      [1200, 896],
      [1, 1000],
      [1000, 1],
    ] as const) {
      for (const r of [A_PORTRAIT, A_LANDSCAPE, 1, 0.75]) {
        const box = cropBox(w, h, r);
        expect(box.width).toBeLessThanOrEqual(w);
        expect(box.height).toBeLessThanOrEqual(h);
      }
    }
  });
});
