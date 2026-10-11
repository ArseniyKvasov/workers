import type { Context, Next } from "hono";

/**
 * Token-bucket rate limiter per client key (in-memory; per process).
 * For multi-instance deployments put a shared store (Redis) behind this.
 */
export interface RateLimitOptions {
  /** Steady-state requests per minute. */
  perMinute: number;
  /** Bucket capacity above the steady rate. */
  burst: number;
  /** Evict untouched buckets above this count (memory safety). */
  maxBuckets?: number;
}

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const DEFAULT_MAX_BUCKETS = 10_000;
/** Buckets untouched for this long are evictable. */
const EVICT_AFTER_MS = 10 * 60_000;

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(private readonly options: RateLimitOptions) {}

  check(key: string): { allowed: boolean; retryAfterSeconds: number } {
    this.evictIfNeeded();
    const now = Date.now();
    const refillRate = this.options.perMinute / 60_000; // tokens per ms

    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.options.burst + this.options.perMinute, lastRefill: now };
      this.buckets.set(key, bucket);
    }

    bucket.tokens = Math.min(
      this.options.burst + this.options.perMinute,
      bucket.tokens + (now - bucket.lastRefill) * refillRate
    );
    bucket.lastRefill = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, retryAfterSeconds: 0 };
    }

    const tokensToNext = 1 - bucket.tokens;
    return { allowed: false, retryAfterSeconds: Math.ceil(tokensToNext / refillRate / 1000) };
  }

  /**
   * Lazy eviction: once the map exceeds maxBuckets, drop buckets idle past
   * EVICT_AFTER_MS (an attacker sending unique keys cannot grow memory
   * unboundedly; active buckets survive).
   */
  private evictIfNeeded(): void {
    const max = this.options.maxBuckets ?? DEFAULT_MAX_BUCKETS;
    if (this.buckets.size <= max) return;
    const cutoff = Date.now() - EVICT_AFTER_MS;
    for (const [key, bucket] of this.buckets) {
      if (bucket.lastRefill < cutoff) this.buckets.delete(key);
      if (this.buckets.size <= max / 2) break;
    }
  }

  middleware(
    getKey?: (c: Context) => string
  ): (c: Context, next: Next) => Promise<Response | void> {
    return async (c, next) => {
      const key =
        getKey?.(c) ??
        (c.get("apiKeyId") as string | undefined) ??
        c.req.header("x-forwarded-for") ??
        "anonymous";
      const { allowed, retryAfterSeconds } = this.check(key);
      if (!allowed) {
        c.header("Retry-After", String(retryAfterSeconds));
        return c.json(
          { error: { code: "RATE_LIMITED", message: `rate limit exceeded; retry in ${retryAfterSeconds}s` } },
          429
        );
      }
      await next();
    };
  }
}
