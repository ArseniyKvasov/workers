import { desc, eq, and, gte, lte, sql } from "drizzle-orm";
import type { CatalogDb } from "./client.js";
import { auditLogs, d1Databases, d1Migrations, kvNamespaces, queues, usageMetrics, apiKeys } from "./schema.js";

export class AuditRepository {
  constructor(private readonly db: CatalogDb) {}

  async record(entry: {
    actorType?: string;
    actorId: string;
    action: string;
    resourceType: string;
    resourceId: string;
    changes?: unknown;
    ip?: string | null;
    userAgent?: string | null;
  }): Promise<void> {
    await this.db.insert(auditLogs).values({
      actorType: entry.actorType ?? "api_key",
      actorId: entry.actorId,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      changes: entry.changes ?? null,
      ip: entry.ip ?? null,
      userAgent: entry.userAgent ?? null,
    });
  }

  async list(limit: number, offset: number): Promise<unknown[]> {
    return this.db.select().from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(limit).offset(offset);
  }
}

export class D1CatalogRepository {
  constructor(private readonly db: CatalogDb) {}

  async create(input: { workerId: string; name: string; filePath: string }): Promise<unknown> {
    const [row] = await this.db.insert(d1Databases).values(input).returning();
    return row;
  }

  async findByWorkerAndName(workerId: string, name: string) {
    const rows = await this.db
      .select()
      .from(d1Databases)
      .where(and(eq(d1Databases.workerId, workerId), eq(d1Databases.name, name)))
      .limit(1);
    return rows[0];
  }

  async listByWorker(workerId: string) {
    return this.db.select().from(d1Databases).where(eq(d1Databases.workerId, workerId));
  }

  async delete(workerId: string, name: string): Promise<boolean> {
    const rows = await this.db
      .delete(d1Databases)
      .where(and(eq(d1Databases.workerId, workerId), eq(d1Databases.name, name)))
      .returning({ id: d1Databases.id });
    return rows.length > 0;
  }

  async updateSize(id: string, sizeBytes: number): Promise<void> {
    await this.db.update(d1Databases).set({ sizeBytes }).where(eq(d1Databases.id, id));
  }

  async recordMigration(d1DatabaseId: string, statements: string[]): Promise<void> {
    await this.db.insert(d1Migrations).values({ d1DatabaseId, statements });
  }

  async listMigrations(d1DatabaseId: string) {
    return this.db
      .select()
      .from(d1Migrations)
      .where(eq(d1Migrations.d1DatabaseId, d1DatabaseId))
      .orderBy(desc(d1Migrations.appliedAt));
  }
}

export class KVCatalogRepository {
  constructor(private readonly db: CatalogDb) {}

  async create(input: { workerId: string; name: string }): Promise<unknown> {
    const [row] = await this.db.insert(kvNamespaces).values(input).returning();
    return row;
  }

  async findByWorkerAndName(workerId: string, name: string) {
    const rows = await this.db
      .select()
      .from(kvNamespaces)
      .where(and(eq(kvNamespaces.workerId, workerId), eq(kvNamespaces.name, name)))
      .limit(1);
    return rows[0];
  }

  async listByWorker(workerId: string) {
    return this.db.select().from(kvNamespaces).where(eq(kvNamespaces.workerId, workerId));
  }

  async delete(workerId: string, name: string): Promise<boolean> {
    const rows = await this.db
      .delete(kvNamespaces)
      .where(and(eq(kvNamespaces.workerId, workerId), eq(kvNamespaces.name, name)))
      .returning({ id: kvNamespaces.id });
    return rows.length > 0;
  }
}

export class QueuesCatalogRepository {
  constructor(private readonly db: CatalogDb) {}

  async create(input: { workerId: string; name: string; maxRetries: number; retentionSeconds: number }) {
    const [row] = await this.db.insert(queues).values(input).returning();
    return row;
  }

  async findByWorkerAndName(workerId: string, name: string) {
    const rows = await this.db
      .select()
      .from(queues)
      .where(and(eq(queues.workerId, workerId), eq(queues.name, name)))
      .limit(1);
    return rows[0];
  }

  async listByWorker(workerId: string) {
    return this.db.select().from(queues).where(eq(queues.workerId, workerId));
  }

  async delete(workerId: string, name: string): Promise<boolean> {
    const rows = await this.db
      .delete(queues)
      .where(and(eq(queues.workerId, workerId), eq(queues.name, name)))
      .returning({ id: queues.id });
    return rows.length > 0;
  }
}

export class UsageRepository {
  constructor(private readonly db: CatalogDb) {}

  /** Increment usage counters for the given minute bucket (upsert). */
  async recordSample(workerId: string, sample: {
    requestsCount?: number;
    errorsCount?: number;
    cpuMsTotal?: number;
    memoryPeakBytes?: number;
    egressBytes?: number;
    d1RowsRead?: number;
    d1RowsWritten?: number;
    kvOps?: number;
    queueMessages?: number;
  }): Promise<void> {
    const bucketStart = new Date(Math.floor(Date.now() / 60_000) * 60_000);

    await this.db
      .insert(usageMetrics)
      .values({
        workerId,
        bucketStart,
        requestsCount: sample.requestsCount ?? 0,
        errorsCount: sample.errorsCount ?? 0,
        cpuMsTotal: sample.cpuMsTotal ?? 0,
        memoryPeakBytes: sample.memoryPeakBytes ?? 0,
        egressBytes: sample.egressBytes ?? 0,
        d1RowsRead: sample.d1RowsRead ?? 0,
        d1RowsWritten: sample.d1RowsWritten ?? 0,
        kvOps: sample.kvOps ?? 0,
        queueMessages: sample.queueMessages ?? 0,
      })
      .onConflictDoUpdate({
        target: [usageMetrics.workerId, usageMetrics.bucketStart],
        set: {
          requestsCount: sql`${usageMetrics.requestsCount} + excluded.requests_count`,
          errorsCount: sql`${usageMetrics.errorsCount} + excluded.errors_count`,
          cpuMsTotal: sql`${usageMetrics.cpuMsTotal} + excluded.cpu_ms_total`,
          egressBytes: sql`${usageMetrics.egressBytes} + excluded.egress_bytes`,
          d1RowsRead: sql`${usageMetrics.d1RowsRead} + excluded.d1_rows_read`,
          d1RowsWritten: sql`${usageMetrics.d1RowsWritten} + excluded.d1_rows_written`,
          kvOps: sql`${usageMetrics.kvOps} + excluded.kv_ops`,
          queueMessages: sql`${usageMetrics.queueMessages} + excluded.queue_messages`,
          memoryPeakBytes: sql`greatest(${usageMetrics.memoryPeakBytes}, excluded.memory_peak_bytes)`,
        },
      });
  }

  async summary(workerId: string, from: Date, to: Date) {
    const rows = await this.db
      .select({
        requests: sql<number>`coalesce(sum(${usageMetrics.requestsCount}), 0)::int`,
        errors: sql<number>`coalesce(sum(${usageMetrics.errorsCount}), 0)::int`,
        cpuMs: sql<number>`coalesce(sum(${usageMetrics.cpuMsTotal}), 0)::bigint`,
        egressBytes: sql<number>`coalesce(sum(${usageMetrics.egressBytes}), 0)::bigint`,
        d1RowsRead: sql<number>`coalesce(sum(${usageMetrics.d1RowsRead}), 0)::bigint`,
        d1RowsWritten: sql<number>`coalesce(sum(${usageMetrics.d1RowsWritten}), 0)::bigint`,
        kvOps: sql<number>`coalesce(sum(${usageMetrics.kvOps}), 0)::bigint`,
        queueMessages: sql<number>`coalesce(sum(${usageMetrics.queueMessages}), 0)::bigint`,
        memoryPeak: sql<number>`coalesce(max(${usageMetrics.memoryPeakBytes}), 0)::bigint`,
      })
      .from(usageMetrics)
      .where(and(eq(usageMetrics.workerId, workerId), gte(usageMetrics.bucketStart, from), lte(usageMetrics.bucketStart, to)));
    return rows[0];
  }
}

export class ApiKeysRepository {
  constructor(private readonly db: CatalogDb) {}

  async create(input: { name: string; prefix: string; hash: string }) {
    const [row] = await this.db.insert(apiKeys).values(input).returning();
    return row;
  }

  async findByPrefix(prefix: string) {
    const rows = await this.db.select().from(apiKeys).where(eq(apiKeys.prefix, prefix)).limit(1);
    return rows[0];
  }

  async touch(id: string): Promise<void> {
    await this.db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, id));
  }

  async revoke(id: string): Promise<boolean> {
    const rows = await this.db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.id, id), sql`${apiKeys.revokedAt} IS NULL`))
      .returning({ id: apiKeys.id });
    return rows.length > 0;
  }

  async list() {
    return this.db.select().from(apiKeys).orderBy(desc(apiKeys.createdAt));
  }
}
