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
}

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(private readonly options: RateLimitOptions) {}

  check(key: string): { allowed: boolean; retryAfterSeconds: number } {
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

  middleware(): (c: Context, next: Next) => Promise<Response | void> {
    return async (c, next) => {
      const key = c.get("apiKeyId") as string | undefined ?? c.req.header("x-forwarded-for") ?? "anonymous";
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
