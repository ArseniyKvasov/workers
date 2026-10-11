import { Hono } from "hono";
import type { WorkersService } from "../services/workers-service.js";
import type { CronJobsRepository } from "@platform/catalog";
import { badRequest, notFound, conflict } from "../errors.js";
import { cronJobCreateSchema, cronJobUpdateSchema } from "@platform/types";
import { parseCronExpression, getNextRunTime } from "../utils/cron.js";

export function cronRoutes(deps: {
  workersService: WorkersService;
  cronJobs: CronJobsRepository;
}): Hono {
  const app = new Hono();

  // --- Create cron job -------------------------------------------------------
  app.post("/", async (c) => {
    const parsed = cronJobCreateSchema.safeParse(await c.req.json());
    if (!parsed.success) throw badRequest("invalid cron job payload", parsed.error.issues);

    await deps.workersService.getWorker(parsed.data.worker_id);

    // Validate cron expression
    try {
      parseCronExpression(parsed.data.schedule);
    } catch (e) {
      throw badRequest("invalid cron schedule", [String(e)]);
    }

    const existing = await deps.cronJobs.find(parsed.data.worker_id, parsed.data.name);
    if (existing) throw conflict(`cron job "${parsed.data.name}" already exists`);

    const nextRunAt = getNextRunTime(parsed.data.schedule, new Date());

    const job = await deps.cronJobs.create({
      workerId: parsed.data.worker_id,
      name: parsed.data.name,
      schedule: parsed.data.schedule,
      handler: parsed.data.handler,
      payload: parsed.data.payload,
      enabled: parsed.data.enabled ? 1 : 0,
    });

    // Update nextRunAt
    await deps.cronJobs.updateRunInfo(job.id, {
      nextRunAt,
      lastRunAt: new Date(), // dummy, will be overwritten on first run
      lastRunStatus: "success",
      lastRunError: null,
    });

    const updated = await deps.cronJobs.find(parsed.data.worker_id, parsed.data.name);
    return c.json({ data: updated }, 201);
  });

  // --- List cron jobs for a worker ------------------------------------------
  app.get("/", async (c) => {
    const workerId = c.req.query("worker_id");
    if (!workerId) throw badRequest("worker_id query parameter is required");

    await deps.workersService.getWorker(workerId);
    const jobs = await deps.cronJobs.listByWorker(workerId);
    return c.json({ data: jobs });
  });

  // --- Get single cron job ---------------------------------------------------
  app.get("/:name", async (c) => {
    const workerId = c.req.query("worker_id");
    if (!workerId) throw badRequest("worker_id query parameter is required");

    await deps.workersService.getWorker(workerId);
    const job = await deps.cronJobs.find(workerId, c.req.param("name"));
    if (!job) throw notFound("cron job", c.req.param("name"));
    return c.json({ data: job });
  });

  // --- Update cron job -------------------------------------------------------
  app.patch("/:name", async (c) => {
    const workerId = c.req.query("worker_id");
    if (!workerId) throw badRequest("worker_id query parameter is required");

    const parsed = cronJobUpdateSchema.safeParse(await c.req.json());
    if (!parsed.success) throw badRequest("invalid cron job update", parsed.error.issues);

    await deps.workersService.getWorker(workerId);

    const existing = await deps.cronJobs.find(workerId, c.req.param("name"));
    if (!existing) throw notFound("cron job", c.req.param("name"));

    if (parsed.data.schedule) {
      try {
        parseCronExpression(parsed.data.schedule);
      } catch (e) {
        throw badRequest("invalid cron schedule", [String(e)]);
      }
    }

    const updated = await deps.cronJobs.update(workerId, c.req.param("name"), {
      schedule: parsed.data.schedule,
      handler: parsed.data.handler,
      payload: parsed.data.payload,
      enabled: parsed.data.enabled ? 1 : 0,
    });

    if (!updated) throw notFound("cron job", c.req.param("name"));

    // Recalculate nextRunAt if schedule changed
    if (parsed.data.schedule && updated.enabled) {
      const nextRunAt = getNextRunTime(parsed.data.schedule, new Date());
      await deps.cronJobs.updateRunInfo(updated.id, {
        nextRunAt,
        lastRunAt: updated.lastRunAt ?? new Date(),
        lastRunStatus: (updated.lastRunStatus ?? "success") as "success" | "failed",
        lastRunError: updated.lastRunError,
      });
    }

    const refreshed = await deps.cronJobs.find(workerId, c.req.param("name"));
    return c.json({ data: refreshed });
  });

  // --- Delete cron job -------------------------------------------------------
  app.delete("/:name", async (c) => {
    const workerId = c.req.query("worker_id");
    if (!workerId) throw badRequest("worker_id query parameter is required");

    await deps.workersService.getWorker(workerId);
    const deleted = await deps.cronJobs.delete(workerId, c.req.param("name"));
    if (!deleted) throw notFound("cron job", c.req.param("name"));
    return c.json({ data: { deleted: true } });
  });

  // --- Manually trigger cron job (for testing) ------------------------------
  app.post("/:name/trigger", async (c) => {
    const workerId = c.req.query("worker_id");
    if (!workerId) throw badRequest("worker_id query parameter is required");

    await deps.workersService.getWorker(workerId);
    const job = await deps.cronJobs.find(workerId, c.req.param("name"));
    if (!job) throw notFound("cron job", c.req.param("name"));

    // Invoke the worker's handler via the workers service
    const result = await deps.workersService.invoke(workerId, {
      method: "POST",
      path: `/__cron/${job.handler}`,
      body: JSON.stringify(job.payload),
      headers: { "content-type": "application/json" },
    });

    const nextRunAt = getNextRunTime(job.schedule, new Date());
    await deps.cronJobs.updateRunInfo(job.id, {
      nextRunAt,
      lastRunAt: new Date(),
      lastRunStatus: result.status < 500 ? "success" : "failed",
      lastRunError: result.status < 500 ? null : result.body,
    });

    return c.json({ data: { status: result.status, body: result.body, nextRunAt: nextRunAt.toISOString() } });
  });

  return app;
}