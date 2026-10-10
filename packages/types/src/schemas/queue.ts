import { z } from "zod";

export const queueCreateSchema = z.object({
  worker_id: z.string().min(1),
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "letters, digits and underscores only"),
  max_retries: z.number().int().min(0).max(20).default(3),
  retention_seconds: z.number().int().min(60).max(604800).default(86400),
});
export type QueueCreate = z.infer<typeof queueCreateSchema>;

export const queuePushSchema = z.object({
  body: z.string().min(1).max(1024 * 1024),
});
export type QueuePush = z.infer<typeof queuePushSchema>;

export const queueSchema = z.object({
  id: z.string(),
  worker_id: z.string(),
  name: z.string(),
  max_retries: z.number().int(),
  retention_seconds: z.number().int(),
  depth: z.number().int(),
  created_at: z.string(),
});
export type Queue = z.infer<typeof queueSchema>;
