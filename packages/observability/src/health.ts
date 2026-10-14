export interface HealthCheckResult {
  ok: boolean;
  /** Milliseconds the check took (measured by the service). */
  latencyMs?: number;
  detail?: string;
}

export interface HealthReport {
  healthy: boolean;
  /** Unix ms timestamp of the report. */
  timestamp?: string;
  /** Seconds since process start (when startedAt is provided). */
  uptimeSeconds?: number;
  checks: Record<string, HealthCheckResult>;
}

/** A single dependency health probe. */
export type HealthCheck = () => Promise<{ ok: boolean; detail?: string }>;

export interface HealthServiceOptions {
  /** Per-check timeout in ms (default 5000). A timed-out check is `ok: false`. */
  checkTimeoutMs?: number;
  /** Process start time for uptime reporting. */
  startedAt?: number;
}

const DEFAULT_CHECK_TIMEOUT_MS = 5000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`health check "${name}" timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export class HealthService {
  private readonly checks = new Map<string, HealthCheck>();
  private readonly checkTimeoutMs: number;
  private readonly startedAt: number;

  constructor(options: HealthServiceOptions = {}) {
    this.checkTimeoutMs = options.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
    this.startedAt = options.startedAt ?? Date.now();
  }

  register(name: string, check: HealthCheck): void {
    this.checks.set(name, check);
  }

  unregister(name: string): void {
    this.checks.delete(name);
  }

  /** Liveness: the process is up and serving. Always true while running. */
  live(): boolean {
    return true;
  }

  /** Readiness: all registered dependency probes pass (with per-check timeout). */
  async ready(): Promise<HealthReport> {
    return this.detailed();
  }

  /**
   * Full system report: runs every registered check with a timeout, measures
   * latency per check, and never throws (a failing check is `ok: false`).
   * Used by both `/health` (deep) and `/ready`.
   */
  async detailed(): Promise<HealthReport> {
    const checks: HealthReport["checks"] = {};
    let healthy = true;

    for (const [name, check] of this.checks) {
      const started = Date.now();
      try {
        const result = await withTimeout(Promise.resolve().then(check), this.checkTimeoutMs, name);
        checks[name] = {
          ok: result.ok,
          latencyMs: Date.now() - started,
          ...(result.detail ? { detail: result.detail } : {}),
        };
        if (!result.ok) healthy = false;
      } catch (error) {
        checks[name] = {
          ok: false,
          latencyMs: Date.now() - started,
          detail: error instanceof Error ? error.message : String(error),
        };
        healthy = false;
      }
    }

    return {
      healthy,
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      checks,
    };
  }
}

/**
 * Minimal interface the HTTP framework adapter must satisfy so this package
 * stays decoupled from any specific server implementation.
 */
export interface FastifyInstanceLike {
  get(path: string, handler: (req: unknown, reply: ReplyLike) => Promise<unknown>): unknown;
}

export interface ReplyLike {
  code(status: number): ReplyLike;
  send(body: unknown): unknown;
}

export function registerHealthRoutes(server: FastifyInstanceLike, health: HealthService): void {
  server.get("/health", async (_req, reply) => {
    if (health.live()) {
      return reply.code(200).send({ status: "ok" });
    }
    return reply.code(503).send({ status: "unhealthy" });
  });

  server.get("/ready", async (_req, reply) => {
    const report = await health.ready();
    return reply.code(report.healthy ? 200 : 503).send(report);
  });
}
