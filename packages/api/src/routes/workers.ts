import { Hono } from "hono";
import type { WorkersService } from "../services/workers-service.js";
import { badRequest } from "../errors.js";
import { workerCreateSchema, workerUpdateSchema, invokeSchema } from "@platform/types";
import { readBodyCapped } from "../body-limit.js";
import { LogBinding, type LogQuery } from "@platform/bindings";

function serializeWorker(w: {
  id: string;
  runtime: string;
  status: string;
  limits: unknown;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: w.id,
    runtime: w.runtime,
    status: w.status,
    limits: w.limits,
    created_at: w.createdAt.toISOString(),
    updated_at: w.updatedAt.toISOString(),
  };
}

export function workersRoutes(deps: { workersService: WorkersService; maxBodyBytes: number; logs: LogBinding }): Hono {
  const app = new Hono();

  // --- Workers CRUD -------------------------------------------------------
  app.post("/workers", async (c) => {
    const parsed = workerCreateSchema.safeParse(await c.req.json());
    if (!parsed.success) throw badRequest("invalid worker payload", parsed.error.issues);

    const worker = await deps.workersService.createWorker(parsed.data);
    return c.json({ data: serializeWorker(worker) }, 201);
  });

  app.get("/workers", async (c) => {
    const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
    const offset = Math.max(Number(c.req.query("offset") ?? 0), 0);
    const { items, total } = await deps.workersService.listWorkers(limit, offset);
    return c.json({
      data: items.map(serializeWorker),
      meta: { total, limit, offset },
    });
  });

  app.get("/workers/:id", async (c) => {
    const worker = await deps.workersService.getWorker(c.req.param("id"));
    return c.json({ data: serializeWorker(worker) });
  });

  app.patch("/workers/:id", async (c) => {
    const parsed = workerUpdateSchema.safeParse(await c.req.json());
    if (!parsed.success) throw badRequest("invalid worker update", parsed.error.issues);
    const updated = await deps.workersService.updateWorker(c.req.param("id"), parsed.data as Record<string, unknown>);
    return c.json({ data: updated ? serializeWorker(updated) : null });
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
      const form = await c.req.formData();
      const file = form.get("code");
      if (!(file instanceof File)) throw badRequest("multipart field 'code' (file) is required");
      code = Buffer.from(await file.arrayBuffer());
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
    const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
    const offset = Math.max(Number(c.req.query("offset") ?? 0), 0);
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

    const query: LogQuery = {
      since: c.req.query("since"),
      until: c.req.query("until"),
      limit: c.req.query("limit") ? Math.min(Number(c.req.query("limit")!), 1000) : 100,
      level: c.req.query("level") as "info" | "warn" | "error" | undefined,
      cursor: c.req.query("cursor"),
    };

    const result = await deps.logs.read(query);
    return c.json({ data: result });
  });

  return app;
}
