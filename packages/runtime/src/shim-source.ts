import { readFileSync } from "node:fs";

/**
 * Loads the platform shim source as text. The shim is compiled alongside this
 * package (src/shim.ts -> dist/shim.js) and never executed directly: its text
 * is bundled into every worker by bundleWithShim().
 */
let cached: string | undefined;

export function loadShimSource(): string {
  if (cached !== undefined) return cached;

  const candidates = [
    new URL("./shim.js", import.meta.url), // compiled (dist/)
    new URL("./shim.ts", import.meta.url), // raw source (dev, tsx)
  ];

  for (const url of candidates) {
    try {
      cached = readFileSync(url, "utf8");
      return cached;
    } catch {
      // try next candidate
    }
  }

  throw new Error("platform shim source not found (looked for shim.js / shim.ts next to runtime module)");
}
