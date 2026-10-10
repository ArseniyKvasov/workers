import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** Workers: the primary platform entity. */
export const workers = pgTable(
  "workers",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    name: text("name").notNull(),
    runtime: text("runtime").notNull().default("workerd@v1"),
    status: text("status").notNull().default("active"), // active | paused | deleted
    limits: jsonb("limits").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("workers_name_uq").on(t.name),
    index("workers_status_idx").on(t.status),
  ],
);

/** Immutable versions of worker code. Exactly one may be promoted at a time. */
export const workerVersions = pgTable(
  "worker_versions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    bundleSize: integer("bundle_size").notNull(),
    code: text("code").notNull(),
    manifest: jsonb("manifest").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    promotedAt: timestamp("promoted_at", { withTimezone: true }),
  },
  (t) => [
    index("worker_versions_worker_idx").on(t.workerId),
    index("worker_versions_promoted_idx").on(t.workerId, t.promotedAt),
  ],
);

/** Effective resource bindings per worker (resolved from manifest at promote). */
export const workerBindings = pgTable(
  "worker_bindings",
  {
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    bindingType: text("binding_type").notNull(), // d1 | kv | queue | secret
    bindingName: text("binding_name").notNull(),
    configJson: jsonb("config_json").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("worker_bindings_uq").on(t.workerId, t.bindingType, t.bindingName)],
);

/** Age-encrypted secret values. Plaintext is never stored. */
export const workerSecrets = pgTable(
  "worker_secrets",
  {
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    encryptedValue: text("encrypted_value").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("worker_secrets_uq").on(t.workerId, t.name)],
);

/** Per-worker SQLite databases backing D1 bindings. */
export const d1Databases = pgTable(
  "d1_databases",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    filePath: text("file_path").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("d1_databases_uq").on(t.workerId, t.name),
    index("d1_databases_worker_idx").on(t.workerId),
  ],
);

/** Versioned D1 migrations applied to a database. */
export const d1Migrations = pgTable(
  "d1_migrations",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    d1DatabaseId: uuid("d1_database_id")
      .notNull()
      .references(() => d1Databases.id, { onDelete: "cascade" }),
    statements: jsonb("statements").notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("d1_migrations_db_idx").on(t.d1DatabaseId)],
);

/** KV namespaces backed by Redis with per-worker prefixes. */
export const kvNamespaces = pgTable(
  "kv_namespaces",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("kv_namespaces_uq").on(t.workerId, t.name)],
);

/** Queues backed by Redis Streams with consumer groups. */
export const queues = pgTable(
  "queues",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    maxRetries: integer("max_retries").notNull().default(3),
    retentionSeconds: integer("retention_seconds").notNull().default(86400),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("queues_uq").on(t.workerId, t.name)],
);

/** API keys used to authenticate control-plane requests. */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    hash: text("hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("api_keys_prefix_uq").on(t.prefix),
    index("api_keys_hash_idx").on(t.hash),
  ],
);

/** Audit trail for every mutating control-plane operation. */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    actorType: text("actor_type").notNull().default("api_key"),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    changes: jsonb("changes"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_logs_resource_idx").on(t.resourceType, t.resourceId),
    index("audit_logs_created_idx").on(t.createdAt),
  ],
);

/** Aggregated usage samples, one row per worker per minute bucket. */
export const usageMetrics = pgTable(
  "usage_metrics",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    bucketStart: timestamp("bucket_start", { withTimezone: true }).notNull(),
    requestsCount: integer("requests_count").notNull().default(0),
    errorsCount: integer("errors_count").notNull().default(0),
    cpuMsTotal: bigint("cpu_ms_total", { mode: "number" }).notNull().default(0),
    memoryPeakBytes: bigint("memory_peak_bytes", { mode: "number" }).notNull().default(0),
    egressBytes: bigint("egress_bytes", { mode: "number" }).notNull().default(0),
    d1RowsRead: bigint("d1_rows_read", { mode: "number" }).notNull().default(0),
    d1RowsWritten: bigint("d1_rows_written", { mode: "number" }).notNull().default(0),
    kvOps: bigint("kv_ops", { mode: "number" }).notNull().default(0),
    queueMessages: bigint("queue_messages", { mode: "number" }).notNull().default(0),
  },
    (t) => [uniqueIndex("usage_metrics_worker_bucket_idx").on(t.workerId, t.bucketStart)],
);
