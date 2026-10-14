import { createClient } from "@libsql/client";
import { Redis } from "ioredis";
import { access, mkdir, unlink, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";
import {
  createCatalogDb,
  ApiKeysRepository,
  AuditRepository,
  BindingsRepository,
  CronJobsRepository,
  D1CatalogRepository,
  KVCatalogRepository,
  QueuesCatalogRepository,
  SecretsRepository,
  UsageRepository,
  VersionsRepository,
  WorkersRepository,
  type CatalogDb,
} from "@platform/catalog";
import { IsolateManager } from "@platform/runtime";
import { SecretCrypto, LogBinding } from "@platform/bindings";
import { HealthService, createLogger, getMetrics, type Logger } from "@platform/observability";
import {
  buildApp,
  serveApp,
  parseTrustedProxies,
  DEFAULT_MAX_BODY_BYTES,
  type AppConfig,
  WorkersService,
} from "@platform/api";
import { UsageBuffer } from "./usage-buffer.js";
import { CronScheduler } from "@platform/api";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`required environment variable ${name} is not set`);
  }
  return value;
}

function intEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function loadConfig(): AppConfig {
  return {
    databaseUrl: requireEnv("DATABASE_URL"),
    redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
    secretsMasterKey: requireEnv("SECRETS_MASTER_KEY"),
    dataDir: process.env.DATA_DIR ?? "./data",
    port: Number(process.env.PORT ?? 3000),
    rateLimitPerMinute: Number(process.env.API_RATE_LIMIT_PER_MINUTE ?? 300),
    rateLimitBurst: Number(process.env.API_RATE_LIMIT_BURST ?? 50),
    rateLimitExemptIps: (process.env.RATE_LIMIT_EXEMPT_IPS ?? "")
      .split(",")
      .map((ip) => ip.trim())
      .filter((ip) => ip.length > 0),
    // Empty means unrestricted access to public domains. Private/internal
    // destinations remain blocked by the runtime's SSRF protection.
    egressAllowedDomains: (process.env.EGRESS_ALLOWED_DOMAINS ?? "*")
      .split(",")
      .map((d) => d.trim())
      .filter((d) => d.length > 0).length > 0
      ? (process.env.EGRESS_ALLOWED_DOMAINS ?? "*")
          .split(",")
          .map((d) => d.trim())
          .filter((d) => d.length > 0)
      : ["*"],
    apiKey: process.env.API_KEY || undefined,
    egressTimeoutMs: intEnv("EGRESS_TIMEOUT_MS", 120_000),
    maxResponseBytes: intEnv("MAX_RESPONSE_BODY_BYTES", DEFAULT_MAX_BODY_BYTES),
    maxBodyBytes: intEnv("MAX_BODY_BYTES", DEFAULT_MAX_BODY_BYTES),
    /** Rate limiting for public worker ingress (per IP+worker). */
    ingressRateLimitPerMinute: intEnv("INGRESS_RATE_LIMIT_PER_MINUTE", 120),
    ingressRateLimitBurst: intEnv("INGRESS_RATE_LIMIT_BURST", 30),
    trustedProxies: parseTrustedProxies(process.env.TRUSTED_PROXIES),
    corsAllowedOrigins: (process.env.CORS_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((o) => o.trim())
      .filter((o) => o.length > 0),
    metricsToken: process.env.METRICS_TOKEN || undefined,
  };
}

/**
 * Static (no I/O to pg/redis) config validation. Throws with an actionable
 * message so `docker logs` tells exactly which env var is wrong instead of
 * surfacing later as "auth stopped working".
 */
function preflightStaticConfig(config: AppConfig, logger: Logger): void {
  // DATABASE_URL must at least parse as a postgres URL.
  let parsed: URL;
  try {
    parsed = new URL(config.databaseUrl);
  } catch {
    throw new Error(
      "preflight FAIL: DATABASE_URL is not a valid URL. " +
        "Expected e.g. postgresql://postgres:<password>@postgres:5432/workers_platform " +
        "(if the password contains @ / : ? # % it must be percent-encoded — see deploy/docker-entrypoint.sh)"
    );
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
    throw new Error(`preflight FAIL: DATABASE_URL scheme must be postgresql:// (got "${parsed.protocol}//")`);
  }
  if (!parsed.password) {
    throw new Error("preflight FAIL: DATABASE_URL has no password — postgres auth will fail");
  }

  // SECRETS_MASTER_KEY must decode to exactly 32 bytes (AES-256).
  const keyBytes = Buffer.from(config.secretsMasterKey, "base64");
  if (keyBytes.length !== 32) {
    throw new Error(
      `preflight FAIL: SECRETS_MASTER_KEY must be 32 bytes base64-encoded (got ${keyBytes.length} bytes). ` +
        "Generate one with: openssl rand -base64 32"
    );
  }

  if (!config.apiKey) {
    logger.warn("preflight: API_KEY is not set — every /api/* request will 401 until a key is configured");
  }

  if (!Number.isFinite(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error(`preflight FAIL: PORT must be 1-65535 (got "${process.env.PORT ?? "3000"}")`);
  }
}

/** Wait until postgres answers SELECT 1 (bounded retries, clear logs). */
async function waitForPostgres(
  db: CatalogDb,
  logger: Logger,
  opts: { attempts?: number; intervalMs?: number } = {}
): Promise<void> {
  const attempts = opts.attempts ?? Number(process.env.PREFLIGHT_PG_ATTEMPTS ?? 30);
  const intervalMs = opts.intervalMs ?? Number(process.env.PREFLIGHT_PG_INTERVAL_MS ?? 2000);
  let lastError = "";
  for (let i = 1; i <= attempts; i++) {
    try {
      await db.execute("SELECT 1");
      logger.info({ attempts: i }, "preflight: postgres reachable");
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (i === 1 || i % 5 === 0 || i === attempts) {
        logger.warn({ attempt: `${i}/${attempts}`, error: lastError }, "preflight: waiting for postgres...");
      }
      if (i < attempts) await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  throw new Error(
    `preflight FAIL: postgres not reachable after ${attempts} attempts: ${lastError}. ` +
      "Check DATABASE_URL (host, user, percent-encoded password) and that postgres is healthy."
  );
}

/** Wait until redis answers PING (bounded retries, clear logs). */
async function waitForRedis(
  redis: Redis,
  logger: Logger,
  opts: { attempts?: number; intervalMs?: number } = {}
): Promise<void> {
  const attempts = opts.attempts ?? Number(process.env.PREFLIGHT_REDIS_ATTEMPTS ?? 30);
  const intervalMs = opts.intervalMs ?? Number(process.env.PREFLIGHT_REDIS_INTERVAL_MS ?? 2000);
  let lastError = "";
  for (let i = 1; i <= attempts; i++) {
    try {
      const pong = await redis.ping();
      if (pong !== "PONG") throw new Error(`unexpected PING reply: ${pong}`);
      logger.info({ attempts: i }, "preflight: redis reachable");
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (/NOAUTH|WRONGPASS|invalid username-password/i.test(lastError)) {
        throw new Error(
          `preflight FAIL: redis auth rejected (${lastError}). ` +
            "Check REDIS_URL / REDIS_PASSWORD — the app URL must contain the same password as redis --requirepass."
        );
      }
      if (i === 1 || i % 5 === 0 || i === attempts) {
        logger.warn({ attempt: `${i}/${attempts}`, error: lastError }, "preflight: waiting for redis...");
      }
      if (i < attempts) await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  throw new Error(
    `preflight FAIL: redis not reachable after ${attempts} attempts: ${lastError}. ` +
      "Check REDIS_URL (host, port, password) and that redis is healthy."
  );
}

/** Ensure the data directory exists and is writable (D1 sqlite + libsql live here). */
async function verifyDataDirWritable(dataDir: string): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await access(dataDir, fsConstants.W_OK);
  const probe = join(dataDir, ".write-probe");
  await writeFile(probe, "ok");
  await unlink(probe).catch(() => {});
}

async function main() {
  const startedAt = Date.now();
  const config = loadConfig();
  const logger = createLogger({ base: { service: "control-plane" } });

  // --- Startup preflight -----------------------------------------------------
  // Fail fast with a CLEAR message instead of serving a half-dead API whose
  // /api/* auth mysteriously 401/500s minutes later. Every check below used
  // to be an observed production failure mode.
  preflightStaticConfig(config, logger);

  // --- Infrastructure ------------------------------------------------------
  const { db, pool } = createCatalogDb({
    databaseUrl: config.databaseUrl,
    onPoolError: (error) => logger.warn({ error: error.message }, "pg pool background error (recovering)"),
  });
  const redis = new Redis(config.redisUrl, {
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 200, 5000),
    enableReadyCheck: true,
    // A dropped redis connection must NEVER crash the process via an
    // unhandled 'error' event (that was the "restarts by itself" symptom:
    // uncaughtException -> exit(1) -> docker restart -> brief auth outage).
    // Reconnects happen in the background; commands fail fast meanwhile.
  });
  redis.on("error", (error) => {
    logger.warn({ error: error.message }, "redis connection error (reconnecting in background)");
  });

  await waitForPostgres(db, logger);
  await waitForRedis(redis, logger);

  const libsqlDir = join(config.dataDir, "libsql");
  await mkdir(libsqlDir, { recursive: true });
  await verifyDataDirWritable(config.dataDir);
  logger.info({ data_dir: config.dataDir }, "preflight: data dir writable");
  const libsql = createClient({ url: `file:${libsqlDir}/platform.db` });

  const secretCrypto = new SecretCrypto(config.secretsMasterKey);

  // --- Log binding -----------------------------------------------------------
  const logs = new LogBinding("system", redis, { maxLen: 100_000 });

  // --- Repositories --------------------------------------------------------
  const repositories = {
    workers: new WorkersRepository(db),
    versions: new VersionsRepository(db),
    bindings: new BindingsRepository(db),
    secrets: new SecretsRepository(db),
    d1Catalog: new D1CatalogRepository(db),
    kvCatalog: new KVCatalogRepository(db),
    queuesCatalog: new QueuesCatalogRepository(db),
    usage: new UsageRepository(db),
    audit: new AuditRepository(db),
    apiKeys: new ApiKeysRepository(db),
    cronJobs: new CronJobsRepository(db),
  };

  // --- Runtime ---------------------------------------------------------------
  const usageBuffer = new UsageBuffer(repositories.usage);
  const isolates = new IsolateManager({
    redis,
    libsql,
    d1FilePath: (workerId, name) => `${config.dataDir}/d1/${workerId}/${name}.sqlite`,
    egressDefaults: { allowedDomains: config.egressAllowedDomains, timeoutMs: config.egressTimeoutMs },
    maxResponseBytes: config.maxResponseBytes,
    bindingUsageHooks: {
      onRowsRead: (wid, rows) => usageBuffer.onRowsRead(wid, rows),
      onRowsWritten: (wid, rows) => usageBuffer.onRowsWritten(wid, rows),
      onKvOp: (wid, op) => usageBuffer.onKvOp(wid, op),
      onQueueSend: (wid) => usageBuffer.onQueueSend(wid),
    },
  });
  usageBuffer.start();

  // --- Warm-up: restore deployed workers from the catalog --------------------
  try {
    const activeWorkers = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await repositories.workers.listActive(1000, offset);
      activeWorkers.push(...page);
      if (page.length < 1000) break;
    }
    let restored = 0;
    for (const worker of activeWorkers) {
      const promoted = await repositories.versions.findPromoted(worker.id);
      if (!promoted) continue;

      const secretNames = await repositories.secrets.listNames(worker.id);
      const secrets: Record<string, string> = {};
      for (const name of secretNames) {
        const envelope = await repositories.secrets.getDecryptedSource(worker.id, name);
        if (envelope) secrets[name] = secretCrypto.decrypt(worker.id, envelope);
      }

      const bindingRows = await repositories.bindings.listForWorker(worker.id);
      try {
        await isolates.deploy({
          workerId: worker.id,
          versionId: promoted.id,
          code: promoted.code,
          bindings: {
            d1_databases: bindingRows.filter((b) => b.bindingType === "d1").map((b) => b.bindingName),
            kv_namespaces: bindingRows.filter((b) => b.bindingType === "kv").map((b) => b.bindingName),
            queues: bindingRows.filter((b) => b.bindingType === "queue").map((b) => b.bindingName),
          },
          queueOptions: Object.fromEntries(bindingRows
            .filter((b) => b.bindingType === "queue")
            .map((b) => [b.bindingName, {
                          maxRetries: Number(b.configJson.maxRetries ?? 3),
                          retentionSeconds: Number(b.configJson.retentionSeconds ?? 86400),
                        }])),
          secrets,
          limits: {
            cpu_ms: (worker.limits.cpu_ms as number) ?? 5000,
            memory_mb: (worker.limits.memory_mb as number) ?? 128,
            concurrency: (worker.limits.concurrency as number) ?? 100,
          },
          egress: { allowedDomains: config.egressAllowedDomains, timeoutMs: config.egressTimeoutMs },
        });
        restored++;
      } catch (error) {
        logger.warn({ worker_id: worker.id, error: String(error) }, "failed to restore worker isolate");
      }
    }
    logger.info({ restored, total: activeWorkers.length }, "worker warm-up complete");
  } catch (error) {
    logger.warn({ error: String(error) }, "worker warm-up skipped");
  }

  // --- Cron Scheduler -----------------------------------------------------------
  const cronScheduler = new CronScheduler({
    cronJobs: repositories.cronJobs,
    workersService: new WorkersService({
      workers: repositories.workers,
      versions: repositories.versions,
      bindingsRepo: repositories.bindings,
      secretsRepo: repositories.secrets,
      d1Catalog: repositories.d1Catalog,
      kvCatalog: repositories.kvCatalog,
      queuesCatalog: repositories.queuesCatalog,
      usage: repositories.usage,
      isolates,
      secretCrypto,
      dataDir: config.dataDir,
      egressAllowedDomains: config.egressAllowedDomains,
      egressTimeoutMs: config.egressTimeoutMs,
      maxResponseBytes: config.maxResponseBytes,
      redis,
      logs,
    }),
    logger,
    logs,
    redis,
    scanIntervalMs: 30_000,
    batchSize: 100,
    logRetentionIntervalMs: intEnv("LOG_RETENTION_INTERVAL_MS", 60 * 60 * 1000), // 1 hour
    logRetentionSeconds: intEnv("LOG_RETENTION_SECONDS", 7 * 24 * 60 * 60), // 7 days
  });
  cronScheduler.start();

  // --- Health ------------------------------------------------------------------
  // /health проверяет ВСЕ системы: postgres, redis и data dir.
  // Отвечает 200 только когда всё здорово, иначе 503 (см. packages/api app.ts).
  const health = new HealthService({
    startedAt,
    checkTimeoutMs: Number(process.env.HEALTH_CHECK_TIMEOUT_MS ?? 5000),
  });
  health.register("postgres", async () => {
    await db.execute("SELECT 1");
    return { ok: true };
  });
  health.register("redis", async () => {
    const pong = await redis.ping();
    return pong === "PONG" ? { ok: true } : { ok: false, detail: `unexpected reply: ${pong}` };
  });
  health.register("datadir", async () => {
    await access(config.dataDir, fsConstants.W_OK);
    return { ok: true };
  });

  // --- App ----------------------------------------------------------------------
  const app = buildApp({
    db,
    redis,
    libsql,
    repositories,
    secretCrypto,
    isolates,
    logger,
    metrics: getMetrics(),
    health,
    config,
  });

  const { stop } = serveApp(app, config.port);
  logger.info({ port: config.port, node: process.version }, "control plane started");

  // --- Graceful shutdown ----------------------------------------------------------
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");

    const timeout = setTimeout(() => {
      logger.error("graceful shutdown timed out; forcing exit");
      process.exit(1);
    }, 35_000);

    try {
      await stop(); // stop accepting new connections
      cronScheduler.stop(); // stop cron scheduler
      await isolates.stopAll(30_000); // drain in-flight, dispose isolates
      await usageBuffer.stop(); // flush remaining usage deltas
      redis.disconnect();
      await pool.end();
      clearTimeout(timeout);
      logger.info("shutdown complete");
      process.exit(0);
    } catch (error) {
      logger.error({ error: String(error) }, "error during shutdown");
      clearTimeout(timeout);
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // Fatal errors: log, flush usage metrics, exit non-zero. Without these an
  // unhandled rejection in background work kills the process silently mid-flight.
  const fatal = async (kind: string, error: unknown) => {
    logger.fatal({ kind, error: error instanceof Error ? error.stack : String(error) }, "fatal error");
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await Promise.race([
        (async () => {
          await stop();
          await usageBuffer.stop();
        })(),
        new Promise((resolve) => setTimeout(resolve, 10_000)),
      ]);
    } catch (flushError) {
      logger.error({ error: String(flushError) }, "error flushing state before fatal exit");
    }
    redis.disconnect();
    process.exit(1);
  };
  process.on("uncaughtException", (error) => void fatal("uncaughtException", error));
  process.on("unhandledRejection", (reason) => void fatal("unhandledRejection", reason));
}

main().catch((error) => {
  console.error("fatal:", error);
  process.exit(1);
});
