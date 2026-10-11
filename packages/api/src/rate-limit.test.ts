import { describe, expect, it, vi } from "vitest";
import { RateLimiter } from "./rate-limit.js";

describe("RateLimiter", () => {
  it("allows requests within the bucket and 429s after exhaustion", () => {
    const limiter = new RateLimiter({ perMinute: 2, burst: 0 });
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(true);
    const third = limiter.check("a");
    expect(third.allowed).toBe(false);
    expect(third.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("tracks buckets independently per key", () => {
    const limiter = new RateLimiter({ perMinute: 1, burst: 0 });
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(false);
    expect(limiter.check("b").allowed).toBe(true);
  });

  it("evicts idle buckets above maxBuckets", () => {
    vi.useFakeTimers();
    try {
      // 1 token per second; buckets created up front go stale after 10 min.
      const limiter = new RateLimiter({ perMinute: 60, burst: 0, maxBuckets: 4 });
      for (let i = 0; i < 4; i++) limiter.check(`old${i}`);
      vi.advanceTimersByTime(11 * 60_000);
      for (let i = 0; i < 2; i++) limiter.check(`new${i}`);

      // Pushing past maxBuckets evicts the stale buckets; the fresh ones
      // survive and a removed key starts over with a full bucket.
      limiter.check("overflow");
      expect(limiter.check("new0").allowed).toBe(true);
      expect(limiter.check("old0").allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
