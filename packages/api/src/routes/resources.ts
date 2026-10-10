import { Hono } from "hono";
import type { WorkersService } from "../services/workers-service.js";
import type {
  D1CatalogRepository,
  KVCatalogRepository,
  QueuesCatalogRepository,
} from "@platform/catalog";
import type { Redis } from "ioredis";
import type { D1Binding } from "@platform/bindings";
import { badRequest, notFound, conflict } from "../errors.js";
import { d1CreateSchema, d1QuerySchema, d1MigrateSchema } from "@platform/types";
import { kvCreateSchema, kvBulkSchema } from "@platform/types";
import { queueCreateSchema, queuePushSchema } from "@platform/types";

export function d1Routes(deps: {
  workersService: WorkersService;
  d1Catalog: D1CatalogRepository;
}): Hono {
  const app = new Hono();

  app.post("/d1", async (c) => {
    const parsed = d1CreateSchema.safeParse(await c.req.json());
    if (!parsed.success) throw badRequest("invalid D1 payload", parsed.error.issues);

    await deps.workersService.getWorker(parsed.data.worker_id);
    const existing = await deps.d1Catalog.findByWorkerAndName(parsed.data.worker_id, parsed.data.name);
    if (existing) throw conflict(`D1 database "${parsed.data.name}" already exists`);

    const filePath = deps.workersService.d1FilePath(parsed.data.worker_id, parsed.data.name);
    const db = await deps.d1Catalog.create({
      workerId: parsed.data.worker_id,
      name: parsed.data.name,
      filePath,
    });

    if (parsed.data.schema_sql) {
      const binding = new (await import("@platform/bindings")).D1Binding(
        parsed.data.worker_id,
        parsed.data.name,
        filePath
      );
      await binding.exec(parsed.data.schema_sql);
      await binding.close();
    }

    return c.json({ data: db }, 201);
  });

  app.get("/d1", async (c) => {
    const workerId = c.req.query("worker_id");
    if (!workerId) throw badRequest("worker_id query parameter is required");
    await deps.workersService.getWorker(workerId);
    const databases = await deps.d1Catalog.listByWorker(workerId);
    return c.json({ data: databases });
  });

  app.post("/d1/:workerId/:name/query", async (c) => {
    const workerId = c.req.param("workerId");
    const name = c.req.param("name");
    await deps.workersService.getWorker(workerId);

    const db = await deps.d1Catalog.findByWorkerAndName(workerId, name);
    if (!db) throw notFound("D1 database", `${workerId}/${name}`);

    const parsed = d1QuerySchema.safeParse(await c.req.json());
    if (!parsed.success) throw badRequest("invalid query payload", parsed.error.issues);

    const binding = new (await import("@platform/bindings")).D1Binding(workerId, name, db.filePath);
    const result = await binding.prepare(parsed.data.sql).bind(...(parsed.data.params ?? [])).all();
    await binding.close();

    return c.json({
      data: {
        results: result.rows,
        meta: {
          rows_read: result.rows.length,
          rows_written: result.rowsAffected,
          duration_ms: 0,
        },
      },
    });
  });

  app.post("/d1/:workerId/:name/migrate", async (c) => {
    const workerId = c.req.param("workerId");
    const name = c.req.param("name");
    await deps.workersService.getWorker(workerId);

    const db = await deps.d1Catalog.findByWorkerAndName(workerId, name);
    if (!db) throw notFound("D1 database", `${workerId}/${name}`);

    const parsed = d1MigrateSchema.safeParse(await c.req.json());
    if (!parsed.success) throw badRequest("invalid migrate payload", parsed.error.issues);

    const { D1Binding } = await import("@platform/bindings");
    const binding = new D1Binding(workerId, name, db.filePath);
    await binding.exec(parsed.data.statements.join(";\n"));
    await binding.close();

    await deps.d1Catalog.recordMigration(db.id as string, parsed.data.statements);
    return c.json({ data: { applied: parsed.data.statements.length } });
  });

  app.get("/d1/:workerId/:name/migrations", async (c) => {
    const workerId = c.req.param("workerId");
    const name = c.req.param("name");
    await deps.workersService.getWorker(workerId);

    const db = await deps.d1Catalog.findByWorkerAndName(workerId, name);
    if (!db) throw notFound("D1 database", `${workerId}/${name}`);

    const migrations = await deps.d1Catalog.listMigrations(db.id as string);
    return c.json({ data: migrations });
  });

  app.delete("/d1/:workerId/:name", async (c) => {
    const workerId = c.req.param("workerId");
    const name = c.req.param("name");
    await deps.workersService.getWorker(workerId);

    const deleted = await deps.d1Catalog.delete(workerId, name);
    if (!deleted) throw notFound("D1 database", `${workerId}/${name}`);
    return c.json({ data: { deleted: true } });
  });

  return app;
}

export function kvRoutes(deps: {
  workersService: WorkersService;
  kvCatalog: KVCatalogRepository;
  redis: Redis;
}): Hono {
  const app = new Hono();

  app.post("/kv", async (c) => {
    const parsed = kvCreateSchema.safeParse(await c.req.json());
    if (!parsed.success) throw badRequest("invalid KV payload", parsed.error.issues);

    await deps.workersService.getWorker(parsed.data.worker_id);
    const existing = await deps.kvCatalog.findByWorkerAndName(parsed.data.worker_id, parsed.data.name);
    if (existing) throw conflict(`KV namespace "${parsed.data.name}" already exists`);

    const ns = await deps.kvCatalog.create({ workerId: parsed.data.worker_id, name: parsed.data.name });
    return c.json({ data: ns }, 201);
  });

  app.get("/kv", async (c) => {
    const workerId = c.req.query("worker_id");
    if (!workerId) throw badRequest("worker_id query parameter is required");
    await deps.workersService.getWorker(workerId);
    return c.json({ data: await deps.kvCatalog.listByWorker(workerId) });
  });

  app.post("/kv/:workerId/:namespace/bulk", async (c) => {
    const workerId = c.req.param("workerId");
    const namespace = c.req.param("namespace");
    await deps.workersService.getWorker(workerId);

    const ns = await deps.kvCatalog.findByWorkerAndName(workerId, namespace);
    if (!ns) throw notFound("KV namespace", `${workerId}/${namespace}`);

    const parsed = kvBulkSchema.safeParse(await c.req.json());
    if (!parsed.success) throw badRequest("invalid bulk payload", parsed.error.issues);

    const { KVBinding } = await import("@platform/bindings");
    const binding = new KVBinding(workerId, namespace, deps.redis);
    if (parsed.data.put.length > 0) await binding.bulkPut(parsed.data.put);
    if (parsed.data.delete.length > 0) await binding.bulkDelete(parsed.data.delete);
    return c.json({ data: { put: parsed.data.put.length, deleted: parsed.data.delete.length } });
  });

  app.get("/kv/:workerId/:namespace/keys", async (c) => {
    const workerId = c.req.param("workerId");
    const namespace = c.req.param("namespace");
    await deps.workersService.getWorker(workerId);

    const ns = await deps.kvCatalog.findByWorkerAndName(workerId, namespace);
    if (!ns) throw notFound("KV namespace", `${workerId}/${namespace}`);

    const { KVBinding } = await import("@platform/bindings");
    const binding = new KVBinding(workerId, namespace, deps.redis);
    const listed = await binding.list({
      prefix: c.req.query("prefix") ?? undefined,
      cursor: c.req.query("cursor") ?? undefined,
      limit: Math.min(Number(c.req.query("limit") ?? 100), 1000),
    });
    return c.json({ data: listed });
  });

  app.delete("/kv/:workerId/:namespace", async (c) => {
    const workerId = c.req.param("workerId");
    const namespace = c.req.param("namespace");
    await deps.workersService.getWorker(workerId);

    const deleted = await deps.kvCatalog.delete(workerId, namespace);
    if (!deleted) throw notFound("KV namespace", `${workerId}/${namespace}`);
    return c.json({ data: { deleted: true } });
  });

  return app;
}

export function queuesRoutes(deps: {
  workersService: WorkersService;
  queuesCatalog: QueuesCatalogRepository;
  redis: Redis;
}): Hono {
  const app = new Hono();

  app.post("/queues", async (c) => {
    const parsed = queueCreateSchema.safeParse(await c.req.json());
    if (!parsed.success) throw badRequest("invalid queue payload", parsed.error.issues);

    await deps.workersService.getWorker(parsed.data.worker_id);
    const existing = await deps.queuesCatalog.findByWorkerAndName(parsed.data.worker_id, parsed.data.name);
    if (existing) throw conflict(`queue "${parsed.data.name}" already exists`);

    const queue = await deps.queuesCatalog.create({
      workerId: parsed.data.worker_id,
      name: parsed.data.name,
      maxRetries: parsed.data.max_retries,
      retentionSeconds: parsed.data.retention_seconds,
    });
    return c.json({ data: queue }, 201);
  });

  app.get("/queues", async (c) => {
    const workerId = c.req.query("worker_id");
    if (!workerId) throw badRequest("worker_id query parameter is required");
    await deps.workersService.getWorker(workerId);
    return c.json({ data: await deps.queuesCatalog.listByWorker(workerId) });
  });

  app.post("/queues/:workerId/:queue/messages", async (c) => {
    const workerId = c.req.param("workerId");
    const queueName = c.req.param("queue");
    await deps.workersService.getWorker(workerId);

    const queue = await deps.queuesCatalog.findByWorkerAndName(workerId, queueName);
    if (!queue) throw notFound("queue", `${workerId}/${queueName}`);

    const parsed = queuePushSchema.safeParse(await c.req.json());
    if (!parsed.success) throw badRequest("invalid push payload", parsed.error.issues);

    const { QueueBinding } = await import("@platform/bindings");
    const binding = new QueueBinding(workerId, queueName, deps.redis);
    const result = await binding.send(parsed.data.body);
    return c.json({ data: result }, 201);
  });

  app.get("/queues/:workerId/:queue/metrics", async (c) => {
    const workerId = c.req.param("workerId");
    const queueName = c.req.param("queue");
    await deps.workersService.getWorker(workerId);

    const queue = await deps.queuesCatalog.findByWorkerAndName(workerId, queueName);
    if (!queue) throw notFound("queue", `${workerId}/${queueName}`);

    const { QueueBinding } = await import("@platform/bindings");
    const binding = new QueueBinding(workerId, queueName, deps.redis);
    const depth = await binding.depth();
    return c.json({ data: { ...depth, max_retries: queue.maxRetries, retention_seconds: queue.retentionSeconds } });
  });

  app.delete("/queues/:workerId/:queue", async (c) => {
    const workerId = c.req.param("workerId");
    const queueName = c.req.param("queue");
    await deps.workersService.getWorker(workerId);

    const deleted = await deps.queuesCatalog.delete(workerId, queueName);
    if (!deleted) throw notFound("queue", `${workerId}/${queueName}`);
    return c.json({ data: { deleted: true } });
  });

  return app;
}
