import { z } from "zod";

/** Cron job configuration. */
export const cronJobCreateSchema = z.object({
  worker_id: z.string().min(1),
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z_][a-zA-Z0-9_-]*$/, "letters, digits, underscores and dashes only"),
  schedule: z.string().min(1).regex(/^(\*|[0-9,\-\/]+) (\*|[0-9,\-\/]+) (\*|[0-9,\-\/]+) (\*|[0-9,\-\/]+) (\*|[0-9,\-\/]+)$/, "invalid cron expression (5 fields)"),
  handler: z.string().min(1).max(64).default("scheduled"),
  payload: z.record(z.unknown()).default({}),
  enabled: z.boolean().default(true),
});
export type CronJobCreate = z.infer<typeof cronJobCreateSchema>;

export const cronJobUpdateSchema = z.object({
  schedule: cronJobCreateSchema.shape.schedule.optional(),
  handler: cronJobCreateSchema.shape.handler.optional(),
  payload: cronJobCreateSchema.shape.payload.optional(),
  enabled: cronJobCreateSchema.shape.enabled.optional(),
});
export type CronJobUpdate = z.infer<typeof cronJobUpdateSchema>;

export const cronJobSchema = z.object({
  id: z.string(),
  worker_id: z.string(),
  name: z.string(),
  schedule: z.string(),
  handler: z.string(),
  payload: z.record(z.unknown()),
  enabled: z.boolean(),
  next_run_at: z.string().nullable(),
  last_run_at: z.string().nullable(),
  last_run_status: z.enum(["success", "failed"]).nullable(),
  last_run_error: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type CronJob = z.infer<typeof cronJobSchema>;