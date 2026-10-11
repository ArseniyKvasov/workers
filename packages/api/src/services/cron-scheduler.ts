import type { CronJobsRepository } from "@platform/catalog";
import type { WorkersService } from "../services/workers-service.js";
import type { Logger } from "@platform/observability";
import { getNextRunTime } from "../utils/cron.js";

export interface CronSchedulerDeps {
  cronJobs: CronJobsRepository;
  workersService: WorkersService;
  logger: Logger;
  /** How often to scan for due jobs (ms). Default 30s. */
  scanIntervalMs?: number;
  /** Max jobs to process per scan. Default 100. */
  batchSize?: number;
}

export class CronScheduler {
  private readonly deps: Required<CronSchedulerDeps>;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(deps: CronSchedulerDeps) {
    this.deps = {
      cronJobs: deps.cronJobs,
      workersService: deps.workersService,
      logger: deps.logger,
      scanIntervalMs: deps.scanIntervalMs ?? 30_000,
      batchSize: deps.batchSize ?? 100,
    };
  }

  start(): void {
    if (this.timer) return;
    this.running = true;
    this.deps.logger.info({ intervalMs: this.deps.scanIntervalMs }, "cron scheduler started");
    this.tick();
    this.timer = setInterval(() => this.tick(), this.deps.scanIntervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.deps.logger.info("cron scheduler stopped");
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    const startedAt = Date.now();
    try {
      const dueJobs = await this.deps.cronJobs.listDue(this.deps.batchSize);
      if (dueJobs.length === 0) return;

      this.deps.logger.info({ count: dueJobs.length }, "cron: processing due jobs");

      for (const job of dueJobs) {
        await this.executeJob(job);
      }
    } catch (error) {
      this.deps.logger.error({ error: String(error) }, "cron scheduler tick failed");
    } finally {
      const duration = Date.now() - startedAt;
      // metrics removed for now - can be added when metrics are available
    }
  }

  private async executeJob(job: { id: string; workerId: string; name: string; schedule: string; handler: string; payload: Record<string, unknown> }): Promise<void> {
    const startedAt = Date.now();
    let runStatus: "success" | "failed" = "success";
    let runError: string | null = null;

    try {
      // Invoke the worker's handler
      const result = await this.deps.workersService.invoke(job.workerId, {
        method: "POST",
        path: `/__cron/${job.handler}`,
        body: JSON.stringify(job.payload),
        headers: { "content-type": "application/json" },
      });

      if (result.status >= 500) {
        runStatus = "failed";
        runError = result.body;
      }
    } catch (error) {
      runStatus = "failed";
      runError = String(error);
      this.deps.logger.error({ jobId: job.id, workerId: job.workerId, error: String(error) }, "cron job execution failed");
    }

    // Calculate next run time
    const nextRunAt = getNextRunTime(job.schedule, new Date());

    try {
      await this.deps.cronJobs.updateRunInfo(job.id, {
        nextRunAt,
        lastRunAt: new Date(),
        lastRunStatus: runStatus,
        lastRunError: runError,
      });
    } catch (error) {
      this.deps.logger.error({ jobId: job.id, error: String(error) }, "failed to update cron job run info");
    }

    const duration = Date.now() - startedAt;
    this.deps.logger.info(
      { jobId: job.id, workerId: job.workerId, handler: job.handler, status: runStatus, durationMs: duration },
      runStatus === "success" ? "cron job executed" : "cron job failed"
    );
  }
}