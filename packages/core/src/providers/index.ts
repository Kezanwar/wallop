import { createGeminiProvider } from "./gemini";
import type { ImageProvider } from "./types";

export * from "./types";
export * from "./gemini";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

// The client holds a connection pool and should live for the process.
// The globalThis stash survives Next's hot reload, which would otherwise
// leak a new client on every file save.
const globalForProvider = globalThis as unknown as {
  __imageProvider?: ImageProvider;
};

export function getImageProvider(): ImageProvider {
  globalForProvider.__imageProvider ??= createGeminiProvider({
    apiKey: required("GEMINI_API_KEY"),
    model: process.env.GEMINI_IMAGE_MODEL || undefined,
  });
  return globalForProvider.__imageProvider;
}
