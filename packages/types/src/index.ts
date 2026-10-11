export * from "./schemas/worker.js";
export * from "./schemas/d1.js";
export * from "./schemas/kv.js";
export * from "./schemas/queue.js";
export * from "./schemas/secrets.js";
export * from "./schemas/common.js";
export * from "./schemas/cron.js";

/** Well-known error codes returned by the platform API. */
export const ErrorCodes = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  RATE_LIMITED: "RATE_LIMITED",
  LIMIT_EXCEEDED: "LIMIT_EXCEEDED",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

/** Default per-worker resource limits (overridable at create/deploy). */
export const DEFAULT_LIMITS = {
  cpu_ms: 5000,
  memory_mb: 128,
  concurrency: 100,
} as const;

/** Platform-wide ceilings. */
export const PLATFORM_LIMITS = {
  max_workers: 10000,
  max_d1_databases_per_worker: 16,
  max_kv_namespaces_per_worker: 16,
  max_queues_per_worker: 16,
  max_secrets_per_worker: 100,
  max_deploy_versions_per_worker: 50,
} as const;
