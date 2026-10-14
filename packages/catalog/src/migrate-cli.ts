import { createHash } from "node:crypto";
import { createCatalogDb, schema } from "./client.js";
import { sql } from "drizzle-orm";

const BASELINE_VERSION = 1;
const BASELINE_NAME = "catalog-baseline";
const BASELINE_CHECKSUM = createHash("sha256")
  .update("workers-platform/catalog-baseline/v1/workers/versions/bindings/secrets/d1/kv/queues/api-keys/audit/usage/cron")
  .digest("hex");
const MIGRATION_LOCK_KEY = 8_731_104_211n;

/**
 * Minimal migration runner: creates every table defined in the Drizzle schema
 * if it does not already exist (idempotent CREATE TABLE IF NOT EXISTS flow via
 * drizzle-kit generated SQL is preferred; this keeps bootstrap dependency-free).
 */
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const { pool, db } = createCatalogDb({ databaseUrl: url });
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`);
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const existing = await tx.execute(sql`
      SELECT version, name, checksum FROM schema_migrations WHERE version = ${BASELINE_VERSION}
    `);
    const row = existing.rows[0] as { version?: number; name?: string; checksum?: string } | undefined;
    if (row && (row.name !== BASELINE_NAME || row.checksum !== BASELINE_CHECKSUM)) {
      throw new Error(`migration checksum mismatch for version ${BASELINE_VERSION}`);
    }
    if (row) {
      return;
    }

    await tx.execute(sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

    // Create all tables first (idempotent)
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS workers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        runtime TEXT NOT NULL DEFAULT 'workerd@v1',
        status TEXT NOT NULL DEFAULT 'active',
        limits JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await tx.execute(sql`CREATE INDEX IF NOT EXISTS workers_status_idx ON workers (status)`);

    // Legacy schema convergence: drop the removed worker name column/index.
    // Use ALTER TABLE IF EXISTS (PostgreSQL 9.5+) so it works on fresh DBs.
    await tx.execute(sql`ALTER TABLE IF EXISTS workers DROP COLUMN IF EXISTS name`);
    await tx.execute(sql`DROP INDEX IF EXISTS workers_name_uq`);

    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS worker_versions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        worker_id UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
        code_hash TEXT NOT NULL,
        bundle_size INTEGER NOT NULL,
        code TEXT NOT NULL,
        manifest JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        promoted_at TIMESTAMPTZ
      )
    `);
    await tx.execute(
      sql`CREATE INDEX IF NOT EXISTS worker_versions_worker_idx ON worker_versions (worker_id)`
    );
    await tx.execute(
      sql`CREATE INDEX IF NOT EXISTS worker_versions_promoted_idx ON worker_versions (worker_id, promoted_at)`
    );
    await tx.execute(sql`
      DELETE FROM worker_versions a
      USING worker_versions b
      WHERE a.worker_id = b.worker_id
        AND a.promoted_at IS NOT NULL
        AND b.promoted_at IS NOT NULL
        AND (a.promoted_at < b.promoted_at OR (a.promoted_at = b.promoted_at AND a.id < b.id))
    `);
    await tx.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS worker_versions_one_promoted_uq
      ON worker_versions (worker_id) WHERE promoted_at IS NOT NULL
    `);

    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS worker_bindings (
        worker_id UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
        binding_type TEXT NOT NULL,
        binding_name TEXT NOT NULL,
        config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await tx.execute(
      sql`CREATE UNIQUE INDEX IF NOT EXISTS worker_bindings_uq ON worker_bindings (worker_id, binding_type, binding_name)`
    );

    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS worker_secrets (
        worker_id UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        encrypted_value TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        rotated_at TIMESTAMPTZ
      )
    `);
    await tx.execute(
      sql`CREATE UNIQUE INDEX IF NOT EXISTS worker_secrets_uq ON worker_secrets (worker_id, name)`
    );

    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS d1_databases (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        worker_id UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        size_bytes BIGINT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await tx.execute(
      sql`CREATE UNIQUE INDEX IF NOT EXISTS d1_databases_uq ON d1_databases (worker_id, name)`
    );
    await tx.execute(
      sql`CREATE INDEX IF NOT EXISTS d1_databases_worker_idx ON d1_databases (worker_id)`
    );

    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS d1_migrations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        d1_database_id UUID NOT NULL REFERENCES d1_databases(id) ON DELETE CASCADE,
        statements JSONB NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await tx.execute(
      sql`CREATE INDEX IF NOT EXISTS d1_migrations_db_idx ON d1_migrations (d1_database_id)`
    );

    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS kv_namespaces (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        worker_id UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await tx.execute(
      sql`CREATE UNIQUE INDEX IF NOT EXISTS kv_namespaces_uq ON kv_namespaces (worker_id, name)`
    );

    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS queues (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        worker_id UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        max_retries INTEGER NOT NULL DEFAULT 3,
        retention_seconds INTEGER NOT NULL DEFAULT 86400,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await tx.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS queues_uq ON queues (worker_id, name)`);

    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS api_keys (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        prefix TEXT NOT NULL,
        hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_used_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ
      )
    `);
    await tx.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS api_keys_prefix_uq ON api_keys (prefix)`);
    await tx.execute(sql`CREATE INDEX IF NOT EXISTS api_keys_hash_idx ON api_keys (hash)`);

    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        actor_type TEXT NOT NULL DEFAULT 'api_key',
        actor_id TEXT NOT NULL,
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        changes JSONB,
        ip TEXT,
        user_agent TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await tx.execute(
      sql`CREATE INDEX IF NOT EXISTS audit_logs_resource_idx ON audit_logs (resource_type, resource_id)`
    );
    await tx.execute(sql`CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs (created_at)`);

    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS usage_metrics (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        worker_id UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
        bucket_start TIMESTAMPTZ NOT NULL,
        requests_count INTEGER NOT NULL DEFAULT 0,
        errors_count INTEGER NOT NULL DEFAULT 0,
        cpu_ms_total BIGINT NOT NULL DEFAULT 0,
        memory_peak_bytes BIGINT NOT NULL DEFAULT 0,
        egress_bytes BIGINT NOT NULL DEFAULT 0,
        d1_rows_read BIGINT NOT NULL DEFAULT 0,
        d1_rows_written BIGINT NOT NULL DEFAULT 0,
        kv_ops BIGINT NOT NULL DEFAULT 0,
        queue_messages BIGINT NOT NULL DEFAULT 0
      )
    `);
    await tx.execute(
      sql`CREATE UNIQUE INDEX IF NOT EXISTS usage_metrics_worker_bucket_idx ON usage_metrics (worker_id, bucket_start)`
    );

    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS cron_jobs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        worker_id UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        schedule TEXT NOT NULL,
        handler TEXT NOT NULL DEFAULT 'scheduled',
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        enabled INTEGER NOT NULL DEFAULT 1,
        next_run_at TIMESTAMPTZ,
        last_run_at TIMESTAMPTZ,
        last_run_status TEXT,
        last_run_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await tx.execute(
      sql`CREATE UNIQUE INDEX IF NOT EXISTS cron_jobs_worker_name_uq ON cron_jobs (worker_id, name)`
    );
    await tx.execute(
      sql`CREATE INDEX IF NOT EXISTS cron_jobs_worker_idx ON cron_jobs (worker_id)`
    );
    await tx.execute(
      sql`CREATE INDEX IF NOT EXISTS cron_jobs_next_run_idx ON cron_jobs (next_run_at)`
    );

      await tx.execute(sql`
        INSERT INTO schema_migrations (version, name, checksum)
        VALUES (${BASELINE_VERSION}, ${BASELINE_NAME}, ${BASELINE_CHECKSUM})
        ON CONFLICT (version) DO NOTHING
      `);
    });
    console.log("Catalog schema is up to date");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});

// re-export for consumers of migrate-cli as a module
export { schema };
