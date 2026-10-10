import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { logger as honoLogger } from "hono/logger";
import { serve } from "@hono/node-server";
import type { Redis } from "ioredis";
import type { Client as LibSQLClient } from "@libsql/client";
import type { CatalogDb } from "@platform/catalog";
import type { SecretCrypto } from "@platform/bindings";
import type { IsolateManager } from "@platform/runtime";
import type { Logger, MetricsRegistry, HealthService } from "@platform/observability";
import { z } from "zod";

import { AuthService } from "./auth.js";
import { RateLimiter } from "./rate-limit.js";
import { HttpError } from "./errors.js";
import { WorkersService } from "./services/workers-service.js";
import { workersRoutes } from "./routes/workers.js";
import { d1Routes, kvRoutes, queuesRoutes } from "./routes/resources.js";
import { secretsRoutes } from "./routes/secrets.js";
import { apiKeyRoutes } from "./routes/api-keys.js";
import type {
  WorkersRepository,
  VersionsRepository,
  BindingsRepository,
  SecretsRepository,
  D1CatalogRepository,
  KVCatalogRepository,
  QueuesCatalogRepository,
  UsageRepository,
  AuditRepository,
  ApiKeysRepository,
} from "@platform/catalog";
import { join } from "node:path";

export interface AppConfig {
  databaseUrl: string;
  redisUrl: string;
  secretsMasterKey: string;
  dataDir: string;
  port: number;
  rateLimitPerMinute: number;
  rateLimitBurst: number;
  egressAllowedDomains: string[];
  /** Static management API key from env; also accepts DB-stored keys. */
  apiKey?: string;
}

export interface AppRepositories {
  workers: WorkersRepository;
  versions: VersionsRepository;
  bindings: BindingsRepository;
  secrets: SecretsRepository;
  d1Catalog: D1CatalogRepository;
  kvCatalog: KVCatalogRepository;
  queuesCatalog: QueuesCatalogRepository;
  usage: UsageRepository;
  audit: AuditRepository;
  apiKeys: ApiKeysRepository;
}

export interface AppDeps {
  db: CatalogDb;
  redis: Redis;
  libsql: LibSQLClient;
  repositories: AppRepositories;
  secretCrypto: SecretCrypto;
  isolates: IsolateManager;
  logger: Logger;
  metrics: MetricsRegistry;
  health: HealthService;
  config: AppConfig;
}

type AppVariables = {
  Bindings: Record<string, unknown>;
  Variables: {
    requestId: string;
    apiKeyId: string;
    apiKeyName: string;
  };
};

export function buildApp(deps: AppDeps): Hono<AppVariables> {
  const app = new Hono<AppVariables>();

  const auth = new AuthService(deps.repositories.apiKeys);
  const rateLimiter = new RateLimiter({
    perMinute: deps.config.rateLimitPerMinute,
    burst: deps.config.rateLimitBurst,
  });

  const workersService = new WorkersService({
    workers: deps.repositories.workers,
    versions: deps.repositories.versions,
    bindingsRepo: deps.repositories.bindings,
    secretsRepo: deps.repositories.secrets,
    d1Catalog: deps.repositories.d1Catalog,
    kvCatalog: deps.repositories.kvCatalog,
    queuesCatalog: deps.repositories.queuesCatalog,
    usage: deps.repositories.usage,
    isolates: deps.isolates,
    secretCrypto: deps.secretCrypto,
    dataDir: deps.config.dataDir,
  });

  // --- Global middleware ---------------------------------------------------
  app.use(secureHeaders());
  app.use("*", cors({ origin: (origin) => origin, allowHeaders: ["Authorization", "Content-Type", "x-worker-id"] }));
  if (process.env.NODE_ENV !== "production") {
    app.use(honoLogger());
  }

  // Request ID + logging + metrics + auth + rate limiting
  app.use("*", async (c, next) => {
    const requestId = c.req.header("x-request-id") ?? crypto.randomUUID();
    c.set("requestId", requestId);
    c.header("x-request-id", requestId);

    const startedAt = Date.now();
    await next();
    const duration = (Date.now() - startedAt) / 1000;
    const route = c.req.path;
    const method = c.req.method;
    const status = c.res.status;

    deps.metrics.apiRequestsTotal.inc({ route, method, status: String(status) });
    deps.metrics.apiRequestDuration.observe({ route, method }, duration);
    deps.logger.info(
      {
        request_id: requestId,
        method,
        path: route,
        status,
        duration_ms: Math.round(duration * 1000),
      },
      "request completed"
    );
  });

  // --- Public worker ingress (no auth): anyone can invoke a worker ---------
  const forwardToWorker = async (c: Context<AppVariables>) => {
    const workerName = c.req.param("name");
    const subpath = c.req.param("0") ?? "";
    if (!workerName) {
      return c.json({ error: { code: "NOT_FOUND", message: "worker name is required" } }, 404);
    }

    const query: Record<string, string> = {};
    c.req.raw.url
      .split("?")[1]
      ?.split("&")
      .filter((pair) => pair.length > 0)
      .forEach((pair) => {
        const [key, ...rest] = pair.split("=");
        query[decodeURIComponent(key!)] = decodeURIComponent(rest.join("="));
      });

    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => {
      if (key !== "host" && key !== "connection") headers[key] = value;
    });

    const body = ["GET", "HEAD"].includes(c.req.method)
      ? undefined
      : Buffer.from(await c.req.raw.arrayBuffer()).toString("utf8");

    const result = await workersService.invokeByName(workerName, {
      method: c.req.method,
      path: subpath ? `/${subpath}` : "/",
      query,
      headers,
      body,
    });

    for (const [key, value] of Object.entries(result.headers)) {
      if (key !== "transfer-encoding" && key !== "content-length") c.header(key, value);
    }
    return c.body(result.body, result.status as 200);
  };

  app.all("/w/:name", forwardToWorker);
  app.all("/w/:name/*", forwardToWorker);

  // --- Public endpoints (no auth) -------------------------------------------
  app.get("/health", (c) => {
    if (deps.health.live()) return c.json({ status: "ok" });
    return c.json({ status: "unhealthy" }, 503);
  });

  app.get("/ready", async (c) => {
    const report = await deps.health.ready();
    return c.json(report, report.healthy ? 200 : 503);
  });

  app.get("/metrics", async (c) => {
    c.header("content-type", "text/plain; version=0.0.4; charset=utf-8");
    return c.body(await deps.metrics.serve());
  });

  app.get("/version", (c) =>
    c.json({ data: { version: process.env.npm_package_version ?? "0.1.0", node: process.version } })
  );

  // --- Auth middleware for /api/* -------------------------------------------
  // Management API accepts: (1) the static key from API_KEY env, or
  // (2) DB-stored API keys (POST /api/api-keys).
  app.use("/api/*", async (c, next) => {
    const bootstrapMode = process.env.BOOTSTRAP_OPEN_API === "1";
    const isApiKeyCreate = c.req.method === "POST" && c.req.path === "/api/api-keys";

    if (!(bootstrapMode && isApiKeyCreate)) {
      const token = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "") || null;
      let authContext: { keyId: string; keyName: string } | null = null;

      if (deps.config.apiKey && token === deps.config.apiKey) {
        authContext = { keyId: "env:API_KEY", keyName: "env-api-key" };
      } else {
        authContext = await auth.authenticate(token);
      }

      if (!authContext) {
        return c.json(
          { error: { code: "UNAUTHORIZED", message: "missing or invalid API key" } },
          401
        );
      }

      c.set("apiKeyId", authContext.keyId);
      c.set("apiKeyName", authContext.keyName);
    }
    await next();
  });

  app.use("/api/*", rateLimiter.middleware());

  // --- Audit wrapper for mutating requests ----------------------------------
  app.use("/api/*", async (c, next) => {
    await next();
    if (["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method)) {
      const apiKeyId = c.get("apiKeyId") as string | undefined;
      if (apiKeyId) {
        try {
          await deps.repositories.audit.record({
            actorId: apiKeyId,
            action: `${c.req.method} ${c.req.path}`,
            resourceType: "http_request",
            resourceId: c.req.path,
            ip: c.req.header("x-forwarded-for") ?? null,
            userAgent: c.req.header("user-agent") ?? null,
            changes: c.res.status < 400 ? { status: c.res.status } : { status: c.res.status },
          });
        } catch (error) {
          deps.logger.warn({ error: String(error) }, "failed to write audit log");
        }
      }
    }
  });

  // --- API routes -------------------------------------------------------------
  const api = new Hono();
  api.route("/", workersRoutes({ workersService }));
  api.route("/", d1Routes({ workersService, d1Catalog: deps.repositories.d1Catalog }));
  api.route("/", kvRoutes({ workersService, kvCatalog: deps.repositories.kvCatalog, redis: deps.redis }));
  api.route("/", queuesRoutes({ workersService, queuesCatalog: deps.repositories.queuesCatalog, redis: deps.redis }));
  api.route("/", secretsRoutes({ secretsRepo: deps.repositories.secrets, secretCrypto: deps.secretCrypto }));
  api.route("/api-keys", apiKeyRoutes({ apiKeys: deps.repositories.apiKeys }));
  app.route("/api", api);

  // --- Error handling ----------------------------------------------------------
  app.onError((error, c) => {
    if (error instanceof HttpError) {
      return c.json(
        { error: { code: error.code, message: error.message, details: error.details } },
        error.status as 400
      );
    }

    if (error instanceof z.ZodError) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "validation failed", details: error.issues } },
        400
      );
    }

    deps.logger.error({ error: error instanceof Error ? error.stack : String(error) }, "unhandled error");
    return c.json(
      { error: { code: "INTERNAL_ERROR", message: "internal server error" } },
      500
    );
  });

  // --- 404 -------------------------------------------------------------------
  app.notFound((c) =>
    c.json({ error: { code: "NOT_FOUND", message: `no route for ${c.req.method} ${c.req.path}` } }, 404)
  );

  return app;
}

/** Serve the app with @hono/node-server; returns a stop function. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function serveApp(app: Hono<any>, port: number): { stop: () => Promise<void> } {
  const server = serve({ fetch: app.fetch, port });
  return {
    stop: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export function dataDirPath(base: string): string {
  return join(base);
}
