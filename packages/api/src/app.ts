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

import { AuthService, timingSafeEqualStr } from "./auth.js";
import { RateLimiter } from "./rate-limit.js";
import { HttpError } from "./errors.js";
import { bodyLimitMiddleware, readBodyCapped } from "./body-limit.js";
import { getClientIp } from "./client-ip.js";
import { WorkersService } from "./services/workers-service.js";
import { workersRoutes } from "./routes/workers.js";
import { d1Routes, kvRoutes, queuesRoutes } from "./routes/resources.js";
import { secretsRoutes } from "./routes/secrets.js";
import { apiKeyRoutes } from "./routes/api-keys.js";
import { cronRoutes } from "./routes/cron.js";
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
  CronJobsRepository,
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
  /** Cap for request bodies (413 above); default 10 MB. */
  maxBodyBytes: number;
  /** Rate limiting for public worker ingress (per IP+worker). */
  ingressRateLimitPerMinute: number;
  ingressRateLimitBurst: number;
  /** CIDRs/IPs allowed to set x-forwarded-for (reverse proxies). */
  trustedProxies: string[];
  /** CORS allowlist; empty = no CORS headers emitted at all. */
  corsAllowedOrigins: string[];
  /** When set, /metrics requires this bearer token. */
  metricsToken?: string;
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
  cronJobs: CronJobsRepository;
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
  const ingressRateLimiter = new RateLimiter({
    perMinute: deps.config.ingressRateLimitPerMinute,
    burst: deps.config.ingressRateLimitBurst,
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
  app.use("*", bodyLimitMiddleware(deps.config.maxBodyBytes));
  if (deps.config.corsAllowedOrigins.length > 0) {
    const allowed = new Set(deps.config.corsAllowedOrigins);
    app.use(
      "*",
      cors({
        origin: (origin) => (allowed.has(origin) ? origin : null),
        allowHeaders: ["Authorization", "Content-Type", "x-worker-id", "x-ingress-token"],
      })
    );
  }
  if (process.env.NODE_ENV !== "production") {
    app.use(honoLogger());
  }

  if (process.env.BOOTSTRAP_OPEN_API === "1" && process.env.NODE_ENV === "production") {
    deps.logger.warn(
      "BOOTSTRAP_OPEN_API=1 in production: POST /api/api-keys is UNAUTHENTICATED. Finish bootstrapping and unset it immediately."
    );
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

  // --- Public worker ingress (rate-limited by IP): invoke a worker by id -------
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // Rate limit the public ingress before any processing (per IP + worker).
  const ingressKey = (c: Context<AppVariables>) =>
    `${c.req.param("id") ?? "?"}:${getClientIp(c, deps.config.trustedProxies)}`;
  app.use("/w/:id", ingressRateLimiter.middleware(ingressKey));
  app.use("/w/:id/*", ingressRateLimiter.middleware(ingressKey));

  const forwardToWorker = async (c: Context<AppVariables>) => {
    const workerId = c.req.param("id");
    const subpath = c.req.param("0") ?? "";
    if (!workerId || !UUID_RE.test(workerId)) {
      return c.json({ error: { code: "NOT_FOUND", message: "worker id is required" } }, 404);
    }

    const query: Record<string, string> = {};
    try {
      c.req.raw.url
        .split("?")[1]
        ?.split("&")
        .filter((pair) => pair.length > 0)
        .forEach((pair) => {
          const [key, ...rest] = pair.split("=");
          query[decodeURIComponent(key!)] = decodeURIComponent(rest.join("="));
        });
    } catch {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "malformed query string" } },
        400
      );
    }

    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => {
      if (key !== "host" && key !== "connection") headers[key] = value;
    });

    const body =
      ["GET", "HEAD"].includes(c.req.method) || c.req.raw.body === null
        ? undefined
        : await readBodyCapped(c.req.raw, deps.config.maxBodyBytes);

    const result = await workersService.invokeById(workerId, {
      method: c.req.method,
      path: subpath ? `/${subpath}` : "/",
      query,
      headers,
      body,
    });

    for (const [key, value] of Object.entries(result.headers)) {
      if (key !== "transfer-encoding" && key !== "content-length") c.header(key, value);
    }
    return c.body(result.body.buffer as ArrayBuffer, result.status as 200);
  };

  app.all("/w/:id", forwardToWorker);
  app.all("/w/:id/*", forwardToWorker);

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
    if (deps.config.metricsToken) {
      const token = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
      if (!token || !timingSafeEqualStr(token, deps.config.metricsToken)) {
        return c.json({ error: { code: "UNAUTHORIZED", message: "metrics token required" } }, 401);
      }
    } else if (process.env.NODE_ENV === "production") {
      deps.logger.warn("GET /metrics without METRICS_TOKEN: metrics are publicly exposed");
    }
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
    } else if (process.env.NODE_ENV === "production") {
      deps.logger.warn(
        { request_id: c.get("requestId") },
        "BOOTSTRAP_OPEN_API=1: issuing management API key WITHOUT authentication"
      );
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
            ip: getClientIp(c, deps.config.trustedProxies),
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
  api.route("/", workersRoutes({ workersService, maxBodyBytes: deps.config.maxBodyBytes }));
  api.route("/", d1Routes({ workersService, d1Catalog: deps.repositories.d1Catalog }));
  api.route("/", kvRoutes({ workersService, kvCatalog: deps.repositories.kvCatalog, redis: deps.redis }));
  api.route("/", queuesRoutes({ workersService, queuesCatalog: deps.repositories.queuesCatalog, redis: deps.redis }));
  api.route("/", secretsRoutes({ secretsRepo: deps.repositories.secrets, secretCrypto: deps.secretCrypto }));
  api.route("/cron", cronRoutes({ workersService, cronJobs: deps.repositories.cronJobs }));
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
