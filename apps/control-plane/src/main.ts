import { createClient } from "@libsql/client";
import { Redis } from "ioredis";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createCatalogDb,
  ApiKeysRepository,
  AuditRepository,
  BindingsRepository,
  D1CatalogRepository,
  KVCatalogRepository,
  QueuesCatalogRepository,
  SecretsRepository,
  UsageRepository,
  VersionsRepository,
  WorkersRepository,
} from "@platform/catalog";
import { IsolateManager } from "@platform/runtime";
import { SecretCrypto } from "@platform/bindings";
import { HealthService, createLogger, getMetrics } from "@platform/observability";
import { buildApp, serveApp, type AppConfig } from "@platform/api";
import { UsageBuffer } from "./usage-buffer.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`required environment variable ${name} is not set`);
  }
  return value;
}

function loadConfig(): AppConfig {
  return {
    databaseUrl: requireEnv("DATABASE_URL"),
    redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
    secretsMasterKey: requireEnv("SECRETS_MASTER_KEY"),
    dataDir: process.env.DATA_DIR ?? "./data",
    port: Number(process.env.PORT ?? 3000),
    rateLimitPerMinute: Number(process.env.API_RATE_LIMIT_PER_MINUTE ?? 600),
    rateLimitBurst: Number(process.env.API_RATE_LIMIT_BURST ?? 100),
    egressAllowedDomains: (process.env.EGRESS_ALLOWED_DOMAINS ?? "")
      .split(",")
      .map((d) => d.trim())
      .filter((d) => d.length > 0),
    apiKey: process.env.API_KEY || undefined,
  };
}

async function main() {
  const config = loadConfig();
  const logger = createLogger({ base: { service: "control-plane" } });

  // --- Infrastructure ------------------------------------------------------
  const { db, pool } = createCatalogDb({ databaseUrl: config.databaseUrl });
  const redis = new Redis(config.redisUrl, {
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 200, 5000),
  });
  const libsqlDir = join(config.dataDir, "libsql");
  await mkdir(libsqlDir, { recursive: true });
  const libsql = createClient({ url: `file:${libsqlDir}/platform.db` });

  const secretCrypto = new SecretCrypto(config.secretsMasterKey);

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
  };

  // --- Runtime ---------------------------------------------------------------
  const usageBuffer = new UsageBuffer(repositories.usage);
  const isolates = new IsolateManager({
    redis,
    libsql,
    d1FilePath: (workerId, name) => `${config.dataDir}/d1/${workerId}/${name}.sqlite`,
    egressDefaults: { allowedDomains: config.egressAllowedDomains },
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
    const activeWorkers = await repositories.workers.listActive(1000, 0);
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
          secrets,
          limits: {
            cpu_ms: (worker.limits.cpu_ms as number) ?? 5000,
            memory_mb: (worker.limits.memory_mb as number) ?? 128,
            concurrency: (worker.limits.concurrency as number) ?? 100,
          },
          egress: { allowedDomains: config.egressAllowedDomains },
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

  // --- Health ------------------------------------------------------------------
  const health = new HealthService();
  health.register("postgres", async () => {
    await db.execute("SELECT 1");
    return { ok: true };
  });
  health.register("redis", async () => {
    const pong = await redis.ping();
    return { ok: pong === "PONG" };
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
}

main().catch((error) => {
  console.error("fatal:", error);
  process.exit(1);
});
