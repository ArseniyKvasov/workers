import { z } from "zod";

/** Runtime versions supported by the platform. */
export const RUNTIMES = ["workerd@v1"] as const;
export const runtimeSchema = z.enum(RUNTIMES);

/** Resource limits applied per worker at the isolate level. */
export const limitsSchema = z.object({
  cpu_ms: z.number().int().min(50).max(30000).default(5000),
  memory_mb: z.number().int().min(64).max(1024).default(128),
  concurrency: z.number().int().min(1).max(1000).default(100),
});
export type Limits = z.infer<typeof limitsSchema>;

/** Worker resource bindings declared at deploy time. */
export const bindingsSchema = z.object({
  d1_databases: z.array(z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/)).max(16).default([]),
  kv_namespaces: z.array(z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/)).max(16).default([]),
  queues: z.array(z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/)).max(16).default([]),
  secrets: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).max(100).default([]),
});
export type BindingsConfig = z.infer<typeof bindingsSchema>;

/** Deploy manifest accepted alongside worker code. */
export const manifestSchema = z.object({
  entrypoint: z.string().default("src/index.ts"),
  bindings: bindingsSchema.default({}),
  limits: limitsSchema.default({}),
  compatibility_date: z.string().default("2026-10-10"),
  node_compat: z.boolean().default(true),
});
export type Manifest = z.infer<typeof manifestSchema>;

export const workerCreateSchema = z.object({
  runtime: runtimeSchema.default("workerd@v1"),
  limits: limitsSchema.optional(),
});
export type WorkerCreate = z.infer<typeof workerCreateSchema>;

export const workerUpdateSchema = z.object({
  status: z.enum(["active", "paused"]).optional(),
  limits: limitsSchema.partial().optional(),
});
export type WorkerUpdate = z.infer<typeof workerUpdateSchema>;

export const DEPLOY_CODE_MAX_BYTES = 5 * 1024 * 1024; // 5 MB uncompressed
export const DEPLOY_CODE_MIME = [
  "application/javascript",
  "text/javascript",
  "application/zip",
  "application/octet-stream",
  "text/plain",
];

export const workerDeploySchema = z.object({
  manifest: manifestSchema.optional(),
});
export type WorkerDeploy = z.infer<typeof workerDeploySchema>;

export const versionSchema = z.object({
  id: z.string(),
  worker_id: z.string(),
  code_hash: z.string(),
  bundle_size: z.number().int(),
  manifest: manifestSchema,
  created_at: z.string(),
  promoted_at: z.string().nullable(),
});
export type WorkerVersion = z.infer<typeof versionSchema>;

export const workerSchema = z.object({
  id: z.string(),
  runtime: runtimeSchema,
  status: z.enum(["active", "paused", "deleted"]),
  limits: limitsSchema,
  created_at: z.string(),
  updated_at: z.string(),
});
export type Worker = z.infer<typeof workerSchema>;

export const invokeSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]).default("GET"),
  path: z.string().default("/"),
  query: z.record(z.string(), z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
});
export type InvokeRequest = z.infer<typeof invokeSchema>;
