import { describe, it, expect, afterEach, vi } from "vitest";
import { getAppVersion, DEV_VERSION } from "../src/version";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getAppVersion", () => {
  it("reads APP_VERSION when a build sets one", () => {
    vi.stubEnv("APP_VERSION", "2026.10.1");
    expect(getAppVersion()).toBe("2026.10.1");
  });

  it("falls back to dev when unset", () => {
    vi.stubEnv("APP_VERSION", undefined);
    expect(getAppVersion()).toBe(DEV_VERSION);
  });

  /**
   * An unsubstituted template or a stray newline in a deploy script would
   * otherwise stamp whitespace onto every design.
   */
  it("treats blank or whitespace-only as unset", () => {
    vi.stubEnv("APP_VERSION", "");
    expect(getAppVersion()).toBe(DEV_VERSION);
    vi.stubEnv("APP_VERSION", "   \n");
    expect(getAppVersion()).toBe(DEV_VERSION);
  });

  it("trims a value that arrives padded", () => {
    vi.stubEnv("APP_VERSION", " 2026.10.1\n");
    expect(getAppVersion()).toBe("2026.10.1");
  });
});
