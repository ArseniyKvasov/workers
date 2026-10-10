import { z } from "zod";

export const kvCreateSchema = z.object({
  worker_id: z.string().min(1),
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "letters, digits and underscores only"),
});
export type KVCreate = z.infer<typeof kvCreateSchema>;

export const kvBulkSchema = z.object({
  put: z
    .array(
      z.object({
        key: z.string().min(1).max(512),
        value: z.string().max(1024 * 1024),
        ttl_seconds: z.number().int().min(60).max(31536000).optional(),
      })
    )
    .max(10000)
    .default([]),
  delete: z.array(z.string().min(1).max(512)).max(10000).default([]),
});
export type KVBulk = z.infer<typeof kvBulkSchema>;

export const kvNamespaceSchema = z.object({
  id: z.string(),
  worker_id: z.string(),
  name: z.string(),
  key_count: z.number().int(),
  size_bytes: z.number().int(),
  created_at: z.string(),
});
export type KVNamespace = z.infer<typeof kvNamespaceSchema>;
