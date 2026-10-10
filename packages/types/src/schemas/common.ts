import { z } from "zod";

/** API key record exposed to clients (never includes the hash). */
export const apiKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
});
export type ApiKey = z.infer<typeof apiKeySchema>;

export const apiKeyCreateSchema = z.object({
  name: z.string().min(1).max(64),
});
export type ApiKeyCreate = z.infer<typeof apiKeyCreateSchema>;

export const auditLogSchema = z.object({
  id: z.number().int(),
  actor_type: z.string(),
  actor_id: z.string(),
  action: z.string(),
  resource_type: z.string(),
  resource_id: z.string(),
  changes_json: z.string().nullable(),
  ip: z.string().nullable(),
  created_at: z.string(),
});
export type AuditLog = z.infer<typeof auditLogSchema>;

/** Log entry captured from worker isolates. */
export const logEntrySchema = z.object({
  ts: z.string(),
  level: z.enum(["debug", "info", "warn", "error"]),
  msg: z.string(),
  worker_id: z.string(),
  version_id: z.string().nullable(),
  request_id: z.string().nullable(),
  fields: z.record(z.string(), z.unknown()).optional(),
});
export type LogEntry = z.infer<typeof logEntrySchema>;

/** Envelope used by every successful API response. */
export interface DataEnvelope<T> {
  data: T;
  meta?: Record<string, unknown>;
}

/** Envelope used by every error response. */
export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: unknown[];
  };
}
