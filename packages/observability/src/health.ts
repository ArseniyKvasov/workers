export interface HealthReport {
  healthy: boolean;
  checks: Record<string, { ok: boolean; detail?: string }>;
}

/** A single dependency health probe. */
export type HealthCheck = () => Promise<{ ok: boolean; detail?: string }>;

export class HealthService {
  private readonly checks = new Map<string, HealthCheck>();

  register(name: string, check: HealthCheck): void {
    this.checks.set(name, check);
  }

  /** Liveness: the process is up and serving. Always true while running. */
  live(): boolean {
    return true;
  }

  /** Readiness: all registered dependency probes pass. */
  async ready(): Promise<HealthReport> {
    const checks: HealthReport["checks"] = {};
    let healthy = true;

    for (const [name, check] of this.checks) {
      try {
        const result = await check();
        checks[name] = result;
        if (!result.ok) healthy = false;
      } catch (error) {
        checks[name] = { ok: false, detail: error instanceof Error ? error.message : String(error) };
        healthy = false;
      }
    }

    return { healthy, checks };
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
