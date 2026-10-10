import { z } from "zod";

export const d1CreateSchema = z.object({
  worker_id: z.string().min(1),
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "letters, digits and underscores only"),
  schema_sql: z.string().max(1024 * 1024).optional(),
});
export type D1Create = z.infer<typeof d1CreateSchema>;

export const d1QuerySchema = z.object({
  sql: z.string().min(1).max(1024 * 1024),
  params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).max(100).optional(),
});
export type D1Query = z.infer<typeof d1QuerySchema>;

export const d1MigrateSchema = z.object({
  statements: z.array(z.string().min(1).max(1024 * 1024)).min(1).max(200),
});
export type D1Migrate = z.infer<typeof d1MigrateSchema>;

export const d1DatabaseSchema = z.object({
  id: z.string(),
  worker_id: z.string(),
  name: z.string(),
  size_bytes: z.number().int(),
  created_at: z.string(),
});
export type D1Database = z.infer<typeof d1DatabaseSchema>;
