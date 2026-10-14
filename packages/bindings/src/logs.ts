import type { Redis } from "ioredis";

/**
 * Worker request logs stored in Redis Streams.
 * Stream key: wp:{workerId}:logs
 *
 * Retention is managed by a background job (see LOG_RETENTION_SECONDS env).
 * Max stream length is capped to prevent unbounded growth.
 */

export interface LogEntry {
  /** ISO timestamp of the request */
  timestamp: string;
  /** Log level: info | warn | error */
  level: "info" | "warn" | "error";
  /** HTTP method */
  method: string;
  /** Request path */
  path: string;
  /** Response status code */
  status: number;
  /** Request latency in milliseconds */
  latencyMs: number;
  /** Request body size in bytes (after redaction) */
  requestSize: number;
  /** Response body size in bytes (after redaction) */
  responseSize: number;
  /** Masked client IP (last octet zeroed) */
  clientIp: string;
  /** Worker ID */
  workerId: string;
  /** Optional: error message if status >= 500 */
  error?: string;
  /** Optional: trace ID for correlation */
  traceId?: string;
}

export interface LogQuery {
  /** Start time (ISO) — inclusive */
  since?: string;
  /** End time (ISO) — exclusive */
  until?: string;
  /** Maximum number of entries to return */
  limit?: number;
  /** Minimum log level (info | warn | error) */
  level?: "info" | "warn" | "error";
  /** Cursor for pagination (stream entry ID) */
  cursor?: string;
}

export interface LogBatch {
  entries: LogEntry[];
  /** Next cursor for pagination */
  nextCursor?: string;
  /** Whether there are more entries */
  hasMore: boolean;
}

/** Keys that must never appear in logs */
const REDACT_KEYS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-ingress-token",
  "x-forwarded-for", // we mask IP separately
  "secret",
  "password",
  "token",
  "apikey",
  "access_token",
  "refresh_token",
]);

/** Regex for values that look like secrets */
const SECRET_PATTERNS = [
  /wpk_[a-zA-Z0-9_-]{20,}/g,        // API keys
  /wit_[a-zA-Z0-9_-]{20,}/g,        // Ingress tokens
  /sk_[a-zA-Z0-9]{20,}/g,           // Service keys
  /[a-zA-Z0-9]{32,}/g,              // Generic long tokens
];

export class LogBinding {
  private readonly streamKey: string;
  private readonly maxLen: number;

  constructor(
    private readonly workerId: string,
    private readonly redis: Redis,
    options: { maxLen?: number } = {}
  ) {
    this.streamKey = `wp:${workerId}:logs`;
    this.maxLen = options.maxLen ?? 100_000; // cap stream length
  }

  /**
   * Write a log entry. Fire-and-forget (non-blocking).
   * Returns the stream entry ID.
   */
  async write(entry: LogEntry): Promise<string> {
    const sanitized = this.sanitize(entry);
    const id = await this.redis.xadd(
      this.streamKey,
      "*",
      "data",
      JSON.stringify(sanitized),
      "MAXLEN",
      "~",
      String(this.maxLen)
    );
    return id ?? "";
  }

  /**
   * Read logs matching the query. Returns entries in reverse chronological order.
   */
  async read(query: LogQuery = {}): Promise<LogBatch> {
    const {
      since,
      until,
      limit = 100,
      level,
      cursor,
    } = query;

    // Build XRANGE/XREVRANGE arguments
    const start = cursor ? `(${cursor}` : "+"; // exclusive cursor; "+" = latest
    const end = "-"; // "-" = earliest

    const results = await this.redis.xrevrange(
      this.streamKey,
      start,
      end,
      "COUNT",
      String(limit * 2) // fetch extra for filtering
    );

    const entries: LogEntry[] = [];
    let lastId: string | undefined;

    for (const [id, fields] of results ?? []) {
      const dataIdx = fields.indexOf("data");
      if (dataIdx < 0) continue;

      let entry: LogEntry;
      try {
        entry = JSON.parse(fields[dataIdx + 1] ?? "{}");
      } catch {
        continue;
      }

      // Time filter
      const ts = new Date(entry.timestamp).getTime();
      if (since && ts < new Date(since).getTime()) continue;
      if (until && ts >= new Date(until).getTime()) continue;

      // Level filter
      if (level && !this.levelMatches(entry.level, level)) continue;

      entries.push(entry);
      lastId = id;

      if (entries.length >= limit) break;
    }

    return {
      entries,
      nextCursor: lastId,
      hasMore: entries.length === limit,
    };
  }

  /** Get stream length (approximate) */
  async length(): Promise<number> {
    return this.redis.xlen(this.streamKey);
  }

  /** Trim old entries by time (called by retention job) */
  async trimByTime(olderThan: Date): Promise<number> {
    const minId = this.timestampToStreamId(olderThan);
    // XTRIM MINID removes entries with ID < minId
    const removed = await this.redis.xtrim(this.streamKey, "MINID", minId);
    return removed ?? 0;
  }

  /** Trim every worker log stream in Redis. */
  async trimAllByTime(olderThan: Date): Promise<number> {
    const minId = this.timestampToStreamId(olderThan);
    let cursor = "0";
    let removed = 0;
    do {
      const [next, keys] = (await this.redis.scan(cursor, "MATCH", "wp:*:logs", "COUNT", 200)) as [string, string[]];
      cursor = next;
      for (const key of keys) removed += (await this.redis.xtrim(key, "MINID", minId)) ?? 0;
    } while (cursor !== "0");
    return removed;
  }

  /** Convert Date to Redis stream ID (ms-seq format) */
  private timestampToStreamId(date: Date): string {
    return `${date.getTime()}-0`;
  }

  private levelMatches(entryLevel: string, minLevel: string): boolean {
    const levels = { info: 0, warn: 1, error: 2 };
    return (levels[entryLevel as keyof typeof levels] ?? 0) >= (levels[minLevel as keyof typeof levels] ?? 0);
  }

  /**
   * Sanitize log entry: redact sensitive headers, mask IP, truncate large bodies.
   */
  private sanitize(entry: LogEntry): LogEntry {
    const sanitized = { ...entry };

    // Mask client IP (zero last octet for IPv4, last 64 bits for IPv6)
    sanitized.clientIp = this.maskIp(entry.clientIp);

    // Truncate large sizes
    sanitized.requestSize = Math.min(entry.requestSize, 10_000);
    sanitized.responseSize = Math.min(entry.responseSize, 10_000);

    // Error message truncation
    if (sanitized.error) {
      sanitized.error = LogBinding.redactString(sanitized.error).slice(0, 500);
    }
    sanitized.path = LogBinding.redactString(sanitized.path).slice(0, 2000);

    return sanitized;
  }

  private maskIp(ip: string): string {
    if (!ip || ip === "unknown") return "unknown";
    // IPv4: zero last octet
    const ipv4 = ip.match(/^(\d+\.\d+\.\d+)\.\d+$/);
    if (ipv4) return `${ipv4[1]}.0`;
    // IPv6: zero last 64 bits (simplified)
    const ipv6 = ip.match(/^([0-9a-f:]+):[0-9a-f:]+$/i);
    if (ipv6) return `${ipv6[1]}::/64`;
    return "masked";
  }

  /** Redact sensitive data from arbitrary string (used for headers/body) */
  static redactString(input: string): string {
    let result = input;
    for (const pattern of SECRET_PATTERNS) {
      result = result.replace(pattern, "[REDACTED]");
    }
    return result;
  }

  /** Redact sensitive headers from a headers object */
  static redactHeaders(headers: Record<string, string>): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      const lowerKey = key.toLowerCase();
      if (REDACT_KEYS.has(lowerKey) || lowerKey.startsWith("x-") && (lowerKey.includes("key") || lowerKey.includes("token") || lowerKey.includes("secret"))) {
        result[key] = "[REDACTED]";
      } else {
        result[key] = this.redactString(value);
      }
    }
    return result;
  }
}

/** Factory for creating log bindings per worker */
export function createLogBinding(
  workerId: string,
  redis: Redis,
  options?: { maxLen?: number }
): LogBinding {
  return new LogBinding(workerId, redis, options);
}