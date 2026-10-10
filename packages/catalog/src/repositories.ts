import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { CatalogDb } from "./client.js";
import { workers, workerVersions, workerBindings, workerSecrets } from "./schema.js";

export interface WorkerRow {
  id: string;
  name: string;
  runtime: string;
  status: string;
  limits: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface VersionRow {
  id: string;
  workerId: string;
  codeHash: string;
  bundleSize: number;
  code: string;
  manifest: Record<string, unknown>;
  createdAt: Date;
  promotedAt: Date | null;
}

export class WorkersRepository {
  constructor(private readonly db: CatalogDb) {}

  async create(input: {
    name: string;
    runtime: string;
    limits: Record<string, unknown>;
  }): Promise<WorkerRow> {
    const [row] = await this.db.insert(workers).values(input).returning();
    if (!row) throw new Error("failed to insert worker");
    return row as WorkerRow;
  }

  async findActive(id: string): Promise<WorkerRow | undefined> {
    const rows = await this.db
      .select()
      .from(workers)
      .where(and(eq(workers.id, id), sql`${workers.status} <> 'deleted'`))
      .limit(1);
    return rows[0] as WorkerRow | undefined;
  }

  async findActiveByName(name: string): Promise<WorkerRow | undefined> {
    const rows = await this.db
      .select()
      .from(workers)
      .where(and(eq(workers.name, name), sql`${workers.status} <> 'deleted'`))
      .limit(1);
    return rows[0] as WorkerRow | undefined;
  }

  async listActive(limit: number, offset: number): Promise<WorkerRow[]> {
    const rows = await this.db
      .select()
      .from(workers)
      .where(sql`${workers.status} <> 'deleted'`)
      .orderBy(desc(workers.createdAt))
      .limit(limit)
      .offset(offset);
    return rows as WorkerRow[];
  }

  async countActive(): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(workers)
      .where(sql`${workers.status} <> 'deleted'`);
    return rows[0]?.count ?? 0;
  }

  async update(
    id: string,
    patch: { name?: string; status?: string; limits?: Record<string, unknown> }
  ): Promise<WorkerRow | undefined> {
    const [row] = await this.db
      .update(workers)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(workers.id, id), sql`${workers.status} <> 'deleted'`))
      .returning();
    return row as WorkerRow | undefined;
  }

  /** Soft delete: mark deleted, cascades clean up via FK. */
  async softDelete(id: string): Promise<boolean> {
    const rows = await this.db
      .update(workers)
      .set({ status: "deleted", updatedAt: new Date() })
      .where(and(eq(workers.id, id), sql`${workers.status} <> 'deleted'`))
      .returning({ id: workers.id });
    return rows.length > 0;
  }
}

export class VersionsRepository {
  constructor(private readonly db: CatalogDb) {}

  async create(input: {
    workerId: string;
    codeHash: string;
    bundleSize: number;
    code: string;
    manifest: Record<string, unknown>;
  }): Promise<VersionRow> {
    const [row] = await this.db.insert(workerVersions).values(input).returning();
    if (!row) throw new Error("failed to insert version");
    return row as VersionRow;
  }

  async find(id: string): Promise<VersionRow | undefined> {
    const rows = await this.db.select().from(workerVersions).where(eq(workerVersions.id, id)).limit(1);
    return rows[0] as VersionRow | undefined;
  }

  async listByWorker(workerId: string, limit: number, offset: number): Promise<VersionRow[]> {
    const rows = await this.db
      .select()
      .from(workerVersions)
      .where(eq(workerVersions.workerId, workerId))
      .orderBy(desc(workerVersions.createdAt))
      .limit(limit)
      .offset(offset);
    return rows as VersionRow[];
  }

  /** The currently promoted (production) version of a worker. */
  async findPromoted(workerId: string): Promise<VersionRow | undefined> {
    const rows = await this.db
      .select()
      .from(workerVersions)
      .where(and(eq(workerVersions.workerId, workerId), isNotNull(workerVersions.promotedAt)))
      .orderBy(desc(workerVersions.promotedAt))
      .limit(1);
    return rows[0] as VersionRow | undefined;
  }

  /**
   * Atomically promote a version: un-promote any current production version
   * and stamp the target. Executed in a single transaction.
   */
  async promote(workerId: string, versionId: string): Promise<VersionRow | undefined> {
    return this.db.transaction(async (tx) => {
      await tx
        .update(workerVersions)
        .set({ promotedAt: null })
        .where(and(eq(workerVersions.workerId, workerId), isNotNull(workerVersions.promotedAt)));

      const [row] = await tx
        .update(workerVersions)
        .set({ promotedAt: new Date() })
        .where(and(eq(workerVersions.id, versionId), eq(workerVersions.workerId, workerId)))
        .returning();
      return row as VersionRow | undefined;
    });
  }

  /** Roll back to the newest version created before the current production one. */
  async rollback(workerId: string): Promise<VersionRow | undefined> {
    const current = await this.findPromoted(workerId);
    if (!current) return undefined;

    const rows = await this.db
      .select()
      .from(workerVersions)
      .where(
        and(
          eq(workerVersions.workerId, workerId),
          sql`${workerVersions.createdAt} < ${current.createdAt}`
        )
      )
      .orderBy(desc(workerVersions.createdAt))
      .limit(1);
    const previous = rows[0] as VersionRow | undefined;
    if (!previous) return undefined;

    return this.promote(workerId, previous.id);
  }

  async deleteNonPromoted(workerId: string, versionId: string): Promise<boolean> {
    const rows = await this.db
      .delete(workerVersions)
      .where(
        and(
          eq(workerVersions.id, versionId),
          eq(workerVersions.workerId, workerId),
          isNull(workerVersions.promotedAt)
        )
      )
      .returning({ id: workerVersions.id });
    return rows.length > 0;
  }
}

export class BindingsRepository {
  constructor(private readonly db: CatalogDb) {}

  async syncForWorker(
    workerId: string,
    bindings: Array<{ bindingType: string; bindingName: string; configJson?: Record<string, unknown> }>
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(workerBindings).where(eq(workerBindings.workerId, workerId));
      if (bindings.length > 0) {
        await tx.insert(workerBindings).values(
          bindings.map((b) => ({
            workerId,
            bindingType: b.bindingType,
            bindingName: b.bindingName,
            configJson: b.configJson ?? {},
          }))
        );
      }
    });
  }

  async listForWorker(
    workerId: string
  ): Promise<Array<{ bindingType: string; bindingName: string; configJson: Record<string, unknown> }>> {
    const rows = await this.db.select().from(workerBindings).where(eq(workerBindings.workerId, workerId));
    return rows.map((r) => ({
      bindingType: r.bindingType,
      bindingName: r.bindingName,
      configJson: (r.configJson ?? {}) as Record<string, unknown>,
    }));
  }
}

export class SecretsRepository {
  constructor(private readonly db: CatalogDb) {}

  async upsertMany(
    workerId: string,
    values: Array<{ name: string; encryptedValue: string }>
  ): Promise<string[]> {
    if (values.length === 0) return [];
    const rows = await this.db
      .insert(workerSecrets)
      .values(values.map((v) => ({ workerId, name: v.name, encryptedValue: v.encryptedValue })))
      .onConflictDoUpdate({
        target: [workerSecrets.workerId, workerSecrets.name],
        set: { encryptedValue: sql`excluded.encrypted_value`, rotatedAt: new Date() },
      })
      .returning({ name: workerSecrets.name });
    return rows.map((r) => r.name);
  }

  async listNames(workerId: string): Promise<string[]> {
    const rows = await this.db
      .select({ name: workerSecrets.name })
      .from(workerSecrets)
      .where(eq(workerSecrets.workerId, workerId));
    return rows.map((r) => r.name);
  }

  async getDecryptedSource(workerId: string, name: string): Promise<string | undefined> {
    const rows = await this.db
      .select({ encryptedValue: workerSecrets.encryptedValue })
      .from(workerSecrets)
      .where(and(eq(workerSecrets.workerId, workerId), eq(workerSecrets.name, name)))
      .limit(1);
    return rows[0]?.encryptedValue;
  }

  async delete(workerId: string, name: string): Promise<boolean> {
    const rows = await this.db
      .delete(workerSecrets)
      .where(and(eq(workerSecrets.workerId, workerId), eq(workerSecrets.name, name)))
      .returning({ name: workerSecrets.name });
    return rows.length > 0;
  }

  async deleteAll(workerId: string): Promise<void> {
    await this.db.delete(workerSecrets).where(eq(workerSecrets.workerId, workerId));
  }
}
