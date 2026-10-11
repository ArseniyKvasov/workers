import { createCatalogDb, schema } from "./client.js";
import { sql } from "drizzle-orm";

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
    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

    // Legacy schema convergence: drop the removed worker name column/index.
    await db.execute(sql`ALTER TABLE workers DROP COLUMN IF EXISTS name`);
    await db.execute(sql`DROP INDEX IF EXISTS workers_name_uq`);

    
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS workers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        runtime TEXT NOT NULL DEFAULT 'workerd@v1',
        status TEXT NOT NULL DEFAULT 'active',
        limits JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS workers_status_idx ON workers (status)`);

    await db.execute(sql`
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
    await db.execute(
      sql`CREATE INDEX IF NOT EXISTS worker_versions_worker_idx ON worker_versions (worker_id)`
    );
    await db.execute(
      sql`CREATE INDEX IF NOT EXISTS worker_versions_promoted_idx ON worker_versions (worker_id, promoted_at)`
    );

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS worker_bindings (
        worker_id UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
        binding_type TEXT NOT NULL,
        binding_name TEXT NOT NULL,
        config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await db.execute(
      sql`CREATE UNIQUE INDEX IF NOT EXISTS worker_bindings_uq ON worker_bindings (worker_id, binding_type, binding_name)`
    );

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS worker_secrets (
        worker_id UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        encrypted_value TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        rotated_at TIMESTAMPTZ
      )
    `);
    await db.execute(
      sql`CREATE UNIQUE INDEX IF NOT EXISTS worker_secrets_uq ON worker_secrets (worker_id, name)`
    );

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS d1_databases (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        worker_id UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        size_bytes BIGINT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await db.execute(
      sql`CREATE UNIQUE INDEX IF NOT EXISTS d1_databases_uq ON d1_databases (worker_id, name)`
    );
    await db.execute(
      sql`CREATE INDEX IF NOT EXISTS d1_databases_worker_idx ON d1_databases (worker_id)`
    );

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS d1_migrations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        d1_database_id UUID NOT NULL REFERENCES d1_databases(id) ON DELETE CASCADE,
        statements JSONB NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await db.execute(
      sql`CREATE INDEX IF NOT EXISTS d1_migrations_db_idx ON d1_migrations (d1_database_id)`
    );

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS kv_namespaces (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        worker_id UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await db.execute(
      sql`CREATE UNIQUE INDEX IF NOT EXISTS kv_namespaces_uq ON kv_namespaces (worker_id, name)`
    );

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS queues (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        worker_id UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        max_retries INTEGER NOT NULL DEFAULT 3,
        retention_seconds INTEGER NOT NULL DEFAULT 86400,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS queues_uq ON queues (worker_id, name)`);

    await db.execute(sql`
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
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS api_keys_prefix_uq ON api_keys (prefix)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS api_keys_hash_idx ON api_keys (hash)`);

    await db.execute(sql`
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
    await db.execute(
      sql`CREATE INDEX IF NOT EXISTS audit_logs_resource_idx ON audit_logs (resource_type, resource_id)`
    );
    await db.execute(sql`CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs (created_at)`);

    await db.execute(sql`
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
    await db.execute(
      sql`CREATE UNIQUE INDEX IF NOT EXISTS usage_metrics_worker_bucket_idx ON usage_metrics (worker_id, bucket_start)`
    );

    await db.execute(sql`
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
    await db.execute(
      sql`CREATE UNIQUE INDEX IF NOT EXISTS cron_jobs_worker_name_uq ON cron_jobs (worker_id, name)`
    );
    await db.execute(
      sql`CREATE INDEX IF NOT EXISTS cron_jobs_worker_idx ON cron_jobs (worker_id)`
    );
    await db.execute(
      sql`CREATE INDEX IF NOT EXISTS cron_jobs_next_run_idx ON cron_jobs (next_run_at)`
    );

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
