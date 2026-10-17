import { Hono } from "hono";
import type { WorkersService } from "../services/workers-service.js";
import { badRequest } from "../errors.js";
import { workerCreateSchema, workerUpdateSchema, invokeSchema } from "@platform/types";
import { readBodyCapped } from "../body-limit.js";
import { LogBinding, type LogQuery } from "@platform/bindings";
import type { Redis } from "ioredis";

function serializeWorker(w: {
  id: string;
  runtime: string;
  status: string;
  limits: unknown;
  createdAt: Date;
  updatedAt: Date;
}, domain: string) {
  return {
    id: w.id,
    runtime: w.runtime,
    status: w.status,
    limits: w.limits,
    created_at: w.createdAt.toISOString(),
    updated_at: w.updatedAt.toISOString(),
    public_url: `https://${w.id}.${domain}`,
  };
}

export function workersRoutes(deps: { workersService: WorkersService; maxBodyBytes: number; redis: Redis; logs: LogBinding; domain: string }): Hono {
  const app = new Hono();

  // --- Workers CRUD -------------------------------------------------------
  app.post("/workers", async (c) => {
    const parsed = workerCreateSchema.safeParse(await c.req.json());
    if (!parsed.success) throw badRequest("invalid worker payload", parsed.error.issues);

    const worker = await deps.workersService.createWorker(parsed.data);
    return c.json({ data: serializeWorker(worker, deps.domain) }, 201);
  });

  app.get("/workers", async (c) => {
    const requestedLimit = Number(c.req.query("limit") ?? 50);
    const requestedOffset = Number(c.req.query("offset") ?? 0);
    if (!Number.isInteger(requestedLimit) || !Number.isInteger(requestedOffset) || requestedLimit < 0 || requestedOffset < 0) {
      throw badRequest("limit and offset must be non-negative integers");
    }
    const limit = Math.min(requestedLimit, 200);
    const offset = requestedOffset;
    const { items, total } = await deps.workersService.listWorkers(limit, offset);
    return c.json({
      data: items.map((worker) => serializeWorker(worker, deps.domain)),
      meta: { total, limit, offset },
    });
  });

  app.get("/workers/:id", async (c) => {
    const worker = await deps.workersService.getWorker(c.req.param("id"));
    return c.json({ data: serializeWorker(worker, deps.domain) });
  });

  app.patch("/workers/:id", async (c) => {
    const parsed = workerUpdateSchema.safeParse(await c.req.json());
    if (!parsed.success) throw badRequest("invalid worker update", parsed.error.issues);
    const updated = await deps.workersService.updateWorker(c.req.param("id"), parsed.data as Record<string, unknown>);
    return c.json({ data: updated ? serializeWorker(updated, deps.domain) : null });
  });

  app.delete("/workers/:id", async (c) => {
    await deps.workersService.deleteWorker(c.req.param("id"));
    return c.json({ data: { deleted: true } });
  });

  // --- Deploy / Versions --------------------------------------------------
  app.post("/workers/:id/versions", async (c) => {
    const workerId = c.req.param("id");
    const contentType = c.req.header("content-type") ?? "";

    let code: Buffer;
    let manifest: Record<string, unknown> | undefined;

    if (contentType.includes("multipart/form-data")) {
      const contentLength = Number(c.req.header("content-length") ?? "NaN");
      if (!Number.isFinite(contentLength) || contentLength > deps.maxBodyBytes) {
        throw badRequest("multipart deploy requires Content-Length within the request size limit");
      }
      const form = await c.req.formData();
      const file = form.get("code");
      if (!(file instanceof File)) throw badRequest("multipart field 'code' (file) is required");
      code = Buffer.from(await file.arrayBuffer());
      if (code.byteLength > 5 * 1024 * 1024) {
        throw badRequest("worker code exceeds the 5 MB deploy limit");
      }
      const manifestRaw = form.get("manifest");
      if (typeof manifestRaw === "string" && manifestRaw.length > 0) {
        try {
          manifest = JSON.parse(manifestRaw) as Record<string, unknown>;
        } catch {
          throw badRequest("manifest field is not valid JSON");
        }
      }
    } else {
      // Cap the read: chunked requests bypass the Content-Length middleware.
      const raw = await readBodyCapped(c.req.raw, deps.maxBodyBytes);
      let body: { code?: string; manifest?: Record<string, unknown> };
      try {
        body = JSON.parse(new TextDecoder().decode(raw));
      } catch {
        throw badRequest("JSON body is not valid JSON");
      }
      if (typeof body.code !== "string" || body.code.length === 0) {
        throw badRequest("JSON body must contain non-empty 'code' string");
      }
      code = Buffer.from(body.code, "utf8");
      manifest = body.manifest;
    }

    const result = await deps.workersService.deploy({ workerId, code, manifest: manifest as never });
    return c.json(
      {
        data: {
          version_id: result.version.id,
          code_hash: result.version.codeHash,
          bundle_size: result.version.bundleSize,
          promoted_at: result.promoted.promotedAt?.toISOString() ?? null,
        },
      },
      201
    );
  });

  app.get("/workers/:id/versions", async (c) => {
    const requestedLimit = Number(c.req.query("limit") ?? 50);
    const requestedOffset = Number(c.req.query("offset") ?? 0);
    if (!Number.isInteger(requestedLimit) || !Number.isInteger(requestedOffset) || requestedLimit < 0 || requestedOffset < 0) {
      throw badRequest("limit and offset must be non-negative integers");
    }
    const limit = Math.min(requestedLimit, 200);
    const offset = requestedOffset;
    const versions = await deps.workersService.listVersions(c.req.param("id"), limit, offset);
    return c.json({
      data: versions.map((v) => ({
        id: v.id,
        code_hash: v.codeHash,
        bundle_size: v.bundleSize,
        created_at: v.createdAt.toISOString(),
        promoted_at: v.promotedAt?.toISOString() ?? null,
      })),
    });
  });

  app.post("/workers/:id/versions/:versionId/promote", async (c) => {
    const promoted = await deps.workersService.promoteVersion(c.req.param("id"), c.req.param("versionId"));
    return c.json({ data: { version_id: promoted.id, promoted_at: promoted.promotedAt?.toISOString() ?? null } });
  });

  app.post("/workers/:id/rollback", async (c) => {
    const rolled = await deps.workersService.rollback(c.req.param("id"));
    return c.json({ data: { version_id: rolled.id, promoted_at: rolled.promotedAt?.toISOString() ?? null } });
  });

  app.delete("/workers/:id/versions/:versionId", async (c) => {
    await deps.workersService.deleteVersion(c.req.param("id"), c.req.param("versionId"));
    return c.json({ data: { deleted: true } });
  });

  // --- Version code access --------------------------------------------------
  app.get("/workers/:id/versions/:versionId/code", async (c) => {
    const { code, manifest } = await deps.workersService.getVersionCode(c.req.param("id"), c.req.param("versionId"));
    return c.json({ data: { code, manifest } });
  });

  app.get("/workers/:id/code", async (c) => {
    const result = await deps.workersService.getCurrentCode(c.req.param("id"));
    if (!result) return c.json({ data: { code: null, manifest: null } });
    return c.json({ data: result });
  });

  // --- Invoke (sync testing) ----------------------------------------------
  app.post("/workers/:id/invoke", async (c) => {
    const parsed = invokeSchema.safeParse(await c.req.json());
    if (!parsed.success) throw badRequest("invalid invoke payload", parsed.error.issues);

    const result = await deps.workersService.invoke(c.req.param("id"), parsed.data);
    return c.json({ data: result });
  });

  // --- Metrics / Usage ----------------------------------------------------
  app.get("/workers/:id/metrics", async (c) => {
    await deps.workersService.getWorker(c.req.param("id"));
    return c.json({ data: { message: "see /metrics for Prometheus format; usage via /workers/:id/usage" } });
  });

  app.get("/workers/:id/usage", async (c) => {
    const worker = await deps.workersService.getWorker(c.req.param("id"));
    const from = new Date(c.req.query("from") ?? Date.now() - 7 * 86400_000);
    const to = new Date(c.req.query("to") ?? Date.now());
    const summary = await deps.workersService.usageSummary(worker.id, from, to);
    return c.json({ data: { period: { from: from.toISOString(), to: to.toISOString() }, summary } });
  });

  // --- Logs (REST) ----------------------------------------------------------
  app.get("/workers/:id/logs", async (c) => {
    const workerId = c.req.param("id");
    await deps.workersService.getWorker(workerId); // validate worker exists

    const requestedLogLimit = Number(c.req.query("limit") ?? 100);
    if (!Number.isInteger(requestedLogLimit) || requestedLogLimit < 1) throw badRequest("log limit must be a positive integer");
    const since = c.req.query("since");
    const until = c.req.query("until");
    if ((since && Number.isNaN(Date.parse(since))) || (until && Number.isNaN(Date.parse(until)))) throw badRequest("since and until must be valid dates");
    const query: LogQuery = {
      since,
      until,
      limit: Math.min(requestedLogLimit, 1000),
      level: c.req.query("level") as "info" | "warn" | "error" | undefined,
      cursor: c.req.query("cursor"),
    };

    const result = await new LogBinding(workerId, deps.redis, { maxLen: 100_000 }).read(query);
    return c.json({ data: result });
  });

  return app;
}
