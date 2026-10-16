import { createHash } from "node:crypto";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import type { Redis } from "ioredis";
import type {
  WorkersRepository,
  VersionsRepository,
  BindingsRepository,
  SecretsRepository,
  D1CatalogRepository,
  UsageRepository,
  QueuesCatalogRepository,
  KVCatalogRepository,
} from "@platform/catalog";
import type { IsolateManager } from "@platform/runtime";
import type { SecretCrypto } from "@platform/bindings";
import { LogBinding, type LogEntry } from "@platform/bindings";
import { DEFAULT_LIMITS, PLATFORM_LIMITS, DEPLOY_CODE_MAX_BYTES, manifestSchema, type Manifest } from "@platform/types";
import { notFound, payloadTooLarge, limitExceeded, HttpError } from "../errors.js";

export interface WorkersServiceDeps {
  workers: WorkersRepository;
  versions: VersionsRepository;
  bindingsRepo: BindingsRepository;
  secretsRepo: SecretsRepository;
  d1Catalog: D1CatalogRepository;
  kvCatalog: KVCatalogRepository,
  queuesCatalog: QueuesCatalogRepository,
  usage: UsageRepository;
  isolates: IsolateManager;
  secretCrypto: SecretCrypto;
  dataDir: string;
  /** Egress allowlist; ["*"] allows all public domains. */
  egressAllowedDomains: string[];
  egressTimeoutMs: number;
  maxResponseBytes: number;
  redis: Redis;
  /** Log binding for writing request logs */
  logs: LogBinding;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class WorkersService {
  constructor(private readonly deps: WorkersServiceDeps) {}

  async createWorker(input: {
    runtime: string;
    limits?: Partial<{ cpu_ms: number; memory_mb: number; concurrency: number }>;
  }) {
    const existing = await this.deps.workers.countActive();
    if (existing >= PLATFORM_LIMITS.max_workers) {
      throw limitExceeded(`platform worker limit (${PLATFORM_LIMITS.max_workers}) reached`);
    }

    const worker = await this.deps.workers.create({
      runtime: input.runtime,
      limits: { ...DEFAULT_LIMITS, ...(input.limits ?? {}) } as Record<string, unknown>,
    });
    return worker;
  }

  async getWorker(id: string) {
    if (!UUID_RE.test(id)) throw notFound("worker", id);
    const worker = await this.deps.workers.findActive(id);
    if (!worker) throw notFound("worker", id);
    return worker;
  }

  async listWorkers(limit: number, offset: number) {
    const [items, total] = await Promise.all([
      this.deps.workers.listActive(limit, offset),
      this.deps.workers.countActive(),
    ]);
    return { items, total };
  }

  async updateWorker(id: string, patch: { status?: string; limits?: Record<string, unknown> }) {
    await this.getWorker(id);
    const updated = await this.deps.workers.update(id, patch);
    return updated;
  }

  async deleteWorker(id: string) {
    await this.getWorker(id);
    await this.deps.isolates.stop(id);
    let cursor = "0";
    do {
      const [next, keys] = (await this.deps.redis.scan(cursor, "MATCH", `wp:${id}:*`, "COUNT", 500)) as [string, string[]];
      cursor = next;
      if (keys.length > 0) await this.deps.redis.del(...keys);
    } while (cursor !== "0");
    await rm(join(this.deps.dataDir, "d1", id), { recursive: true, force: true });
    await this.deps.workers.softDelete(id);
  }

  /**
   * Deploy a new version: persist, promote atomically, sync bindings,
   * decrypt secrets and hot-reload (or start) the isolate.
   */
  async deploy(input: {
    workerId: string;
    code: Buffer;
    filename?: string;
    manifest?: Partial<Manifest>;
  }) {
    const worker = await this.getWorker(input.workerId);

    if (input.code.byteLength > DEPLOY_CODE_MAX_BYTES) {
      throw payloadTooLarge(
        `deploy payload exceeds ${DEPLOY_CODE_MAX_BYTES} bytes (got ${input.code.byteLength})`
      );
    }

    const versions = await this.deps.versions.listByWorker(worker.id, PLATFORM_LIMITS.max_deploy_versions_per_worker, 0);
    if (versions.length >= PLATFORM_LIMITS.max_deploy_versions_per_worker) {
      throw limitExceeded(`maximum of ${PLATFORM_LIMITS.max_deploy_versions_per_worker} versions per worker reached`);
    }

    const code = input.code.toString("utf8");
    const codeHash = createHash("sha256").update(code).digest("hex");

    const parsedManifest = manifestSchema.safeParse(input.manifest ?? {});
    if (!parsedManifest.success) throw new HttpError(400, "VALIDATION_ERROR", "invalid worker manifest", parsedManifest.error.issues);
    const manifest = parsedManifest.data;
    const declaredBindings = input.manifest?.bindings;
    const existingD1 = declaredBindings?.d1_databases === undefined
      ? (await this.deps.d1Catalog.listByWorker(worker.id)).map((db) => db.name)
      : [];
    const existingKv = declaredBindings?.kv_namespaces === undefined
      ? (await this.deps.kvCatalog.listByWorker(worker.id)).map((namespace) => namespace.name)
      : [];
    const existingQueues = declaredBindings?.queues === undefined
      ? (await this.deps.queuesCatalog.listByWorker(worker.id)).map((queue) => queue.name)
      : [];
    const effectiveBindings = {
      d1_databases: declaredBindings?.d1_databases ?? existingD1,
      kv_namespaces: declaredBindings?.kv_namespaces ?? existingKv,
      queues: declaredBindings?.queues ?? existingQueues,
      secrets: manifest.bindings.secrets,
    };
    const effectiveManifest = { ...manifest, bindings: effectiveBindings };
    const allBindingNames = [
      ...effectiveBindings.d1_databases,
      ...effectiveBindings.kv_namespaces,
      ...effectiveBindings.queues,
    ];
    if (new Set(allBindingNames).size !== allBindingNames.length) {
      throw new HttpError(400, "VALIDATION_ERROR", "binding names must be unique across types");
    }

    // Resolve effective bindings before persisting the version so invalid
    // manifests do not leave orphaned versions in the catalog.
    // Sync effective bindings for the runtime env
    const bindingRows: Array<{ bindingType: string; bindingName: string; configJson?: Record<string, unknown> }> = [];
    const queueOptions: Record<string, { maxRetries: number; retentionSeconds: number }> = {};
    for (const name of effectiveBindings.d1_databases) {
      const db = await this.deps.d1Catalog.findByWorkerAndName(worker.id, name);
      if (!db) throw notFound(`D1 database "${name}" is not created for this worker`);
      bindingRows.push({ bindingType: "d1", bindingName: name, configJson: { filePath: db.filePath } });
    }
    for (const name of effectiveBindings.kv_namespaces) {
      const ns = await this.deps.kvCatalog.findByWorkerAndName(worker.id, name);
      if (!ns) throw notFound(`KV namespace "${name}" is not created for this worker`);
      bindingRows.push({ bindingType: "kv", bindingName: name });
    }
    for (const name of effectiveBindings.queues) {
      const q = await this.deps.queuesCatalog.findByWorkerAndName(worker.id, name);
      if (!q) throw notFound(`queue "${name}" is not created for this worker`);
      queueOptions[name] = { maxRetries: q.maxRetries, retentionSeconds: q.retentionSeconds };
      bindingRows.push({ bindingType: "queue", bindingName: name, configJson: { maxRetries: q.maxRetries, retentionSeconds: q.retentionSeconds } });
    }
    const version = await this.deps.versions.create({
      workerId: worker.id,
      codeHash,
      bundleSize: input.code.byteLength,
      code,
      manifest: effectiveManifest as unknown as Record<string, unknown>,
    });
    const previousPromoted = await this.deps.versions.findPromoted(worker.id);
    const previousBindings = await this.deps.bindingsRepo.listForWorker(worker.id);
    await this.deps.bindingsRepo.syncForWorker(worker.id, bindingRows);

    // Decrypt all secrets before changing the production pointer. A malformed
    // envelope must not leave the catalog promoted to a version that cannot run.
    const secretNames = await this.deps.secretsRepo.listNames(worker.id);
    const secrets: Record<string, string> = {};
    for (const name of secretNames) {
      const envelope = await this.deps.secretsRepo.getDecryptedSource(worker.id, name);
      if (envelope) secrets[name] = this.deps.secretCrypto.decrypt(worker.id, envelope);
    }

    // Promote atomically
    const promoted = await this.deps.versions.promote(worker.id, version.id);
    if (!promoted) throw notFound("version", version.id);

    // Hot reload or cold start the isolate
    try {
      await this.deps.isolates.deploy({
      workerId: worker.id,
      versionId: version.id,
      code,
      bindings: {
        d1_databases: effectiveBindings.d1_databases,
        kv_namespaces: effectiveBindings.kv_namespaces,
        queues: effectiveBindings.queues,
        secrets: manifest.bindings.secrets ?? [],
      },
      queueOptions,
      secrets,
      limits: {
        cpu_ms: (worker.limits.cpu_ms as number) ?? DEFAULT_LIMITS.cpu_ms,
        memory_mb: (worker.limits.memory_mb as number) ?? DEFAULT_LIMITS.memory_mb,
        concurrency: (worker.limits.concurrency as number) ?? DEFAULT_LIMITS.concurrency,
      },
        egress: { allowedDomains: this.deps.egressAllowedDomains, timeoutMs: this.deps.egressTimeoutMs },
      });
    } catch (error) {
      await this.deps.bindingsRepo.syncForWorker(worker.id, previousBindings);
      if (previousPromoted) await this.deps.versions.promote(worker.id, previousPromoted.id);
      else await this.deps.versions.clearPromotion(worker.id);
      try {
        if (previousPromoted) await this.deployStored(worker.id, previousPromoted);
        else await this.deps.isolates.stop(worker.id);
      } catch {
        // Preserve the original deploy error; recovery is retried on restart.
      }
      throw error;
    }

    return { version, promoted };
  }

  async reloadPromoted(workerId: string): Promise<void> {
    const promoted = await this.deps.versions.findPromoted(workerId);
    if (!promoted) return;
    await this.deployStored(workerId, promoted);
  }

  async listVersions(workerId: string, limit: number, offset: number) {
    await this.getWorker(workerId);
    return this.deps.versions.listByWorker(workerId, limit, offset);
  }

  async promoteVersion(workerId: string, versionId: string) {
    await this.getWorker(workerId);
    const version = await this.deps.versions.find(versionId);
    if (!version || version.workerId !== workerId) throw notFound("version", versionId);
    const previous = await this.deps.versions.findPromoted(workerId);

    const promoted = await this.deps.versions.promote(workerId, versionId);
    if (!promoted) throw notFound("version", versionId);

    try {
      await this.deployStored(workerId, promoted);
      return promoted;
    } catch (error) {
      if (previous) {
        await this.deps.versions.promote(workerId, previous.id);
        await this.deployStored(workerId, previous).catch(() => {});
      } else {
        await this.deps.versions.clearPromotion(workerId);
        await this.deps.isolates.stop(workerId).catch(() => {});
      }
      throw error;
    }
  }

  async rollback(workerId: string) {
    await this.getWorker(workerId);
    const current = await this.deps.versions.findPromoted(workerId);
    const previous = await this.deps.versions.rollback(workerId);
    if (!previous) throw notFound("previous version to roll back to");
    try {
      await this.deployStored(workerId, previous);
      return previous;
    } catch (error) {
      if (current) {
        await this.deps.versions.promote(workerId, current.id);
        await this.deployStored(workerId, current).catch(() => {});
      }
      throw error;
    }
  }

  async deleteD1(workerId: string, name: string): Promise<void> {
    await this.getWorker(workerId);
    const db = await this.deps.d1Catalog.findByWorkerAndName(workerId, name);
    if (!db) throw notFound("D1 database", `${workerId}/${name}`);
    await this.deps.isolates.stop(workerId);
    await this.deps.d1Catalog.delete(workerId, name);
    await this.deps.bindingsRepo.remove(workerId, "d1", name);
    await rm(db.filePath, { force: true }).catch(() => {});
    await this.reloadPromoted(workerId);
  }

  async deleteKv(workerId: string, name: string): Promise<void> {
    await this.getWorker(workerId);
    const namespace = await this.deps.kvCatalog.findByWorkerAndName(workerId, name);
    if (!namespace) throw notFound("KV namespace", `${workerId}/${name}`);
    await this.deps.isolates.stop(workerId);
    let cursor = "0";
    const pattern = `wp:${workerId}:kv:${name}:*`;
    do {
      const [next, keys] = (await this.deps.redis.scan(cursor, "MATCH", pattern, "COUNT", 500)) as [string, string[]];
      cursor = next;
      if (keys.length > 0) await this.deps.redis.del(...keys);
    } while (cursor !== "0");
    await this.deps.kvCatalog.delete(workerId, name);
    await this.deps.bindingsRepo.remove(workerId, "kv", name);
    await this.reloadPromoted(workerId);
  }

  async deleteQueue(workerId: string, name: string): Promise<void> {
    await this.getWorker(workerId);
    const queue = await this.deps.queuesCatalog.findByWorkerAndName(workerId, name);
    if (!queue) throw notFound("queue", `${workerId}/${name}`);
    await this.deps.isolates.stop(workerId);
    await this.deps.redis.del(`wp:${workerId}:queue:${name}`, `wp:${workerId}:queue:${name}:dlq`);
    await this.deps.queuesCatalog.delete(workerId, name);
    await this.deps.bindingsRepo.remove(workerId, "queue", name);
    await this.reloadPromoted(workerId);
  }

  async deleteVersion(workerId: string, versionId: string) {
    await this.getWorker(workerId);
    const deleted = await this.deps.versions.deleteNonPromoted(workerId, versionId);
    if (!deleted) throw notFound("non-promoted version", versionId);
  }

  /** Get source code of a specific version. */
  async getVersionCode(workerId: string, versionId: string): Promise<{ code: string; manifest: Manifest }> {
    await this.getWorker(workerId);
    const version = await this.deps.versions.find(versionId);
    if (!version || version.workerId !== workerId) throw notFound("version", versionId);
    return { code: version.code, manifest: version.manifest as Manifest };
  }

  /** Get source code of the currently promoted (production) version. */
  async getCurrentCode(workerId: string): Promise<{ code: string; manifest: Manifest } | null> {
    await this.getWorker(workerId);
    const promoted = await this.deps.versions.findPromoted(workerId);
    if (!promoted) return null;
    return { code: promoted.code, manifest: promoted.manifest as Manifest };
  }

  private async deployStored(workerId: string, version: { id: string; code: string; manifest: unknown }) {
    const worker = await this.getWorker(workerId);
    const manifest = version.manifest as Manifest;

    const secretNames = await this.deps.secretsRepo.listNames(workerId);
    const secrets: Record<string, string> = {};
    for (const name of secretNames) {
      const envelope = await this.deps.secretsRepo.getDecryptedSource(workerId, name);
      if (envelope) secrets[name] = this.deps.secretCrypto.decrypt(workerId, envelope);
    }

    const queueRows = await this.deps.bindingsRepo.listForWorker(workerId);
    const manifestBindings = manifest.bindings ?? {};
    const d1Names = manifestBindings.d1_databases === undefined
      ? queueRows.filter((b) => b.bindingType === "d1").map((b) => b.bindingName)
      : manifestBindings.d1_databases;
    const kvNames = manifestBindings.kv_namespaces === undefined
      ? queueRows.filter((b) => b.bindingType === "kv").map((b) => b.bindingName)
      : manifestBindings.kv_namespaces;
    const queueNames = manifestBindings.queues === undefined
      ? queueRows.filter((b) => b.bindingType === "queue").map((b) => b.bindingName)
      : manifestBindings.queues;
    const queueOptions = Object.fromEntries(queueRows
      .filter((b) => b.bindingType === "queue" && queueNames.includes(b.bindingName))
      .map((b) => [b.bindingName, {
        maxRetries: Number(b.configJson.maxRetries ?? 3),
        retentionSeconds: Number(b.configJson.retentionSeconds ?? 86400),
      }]));

    await this.deps.isolates.deploy({
      workerId,
      versionId: version.id,
      code: version.code,
      bindings: {
        d1_databases: d1Names,
        kv_namespaces: kvNames,
        queues: queueNames,
        secrets: manifestBindings.secrets ?? [],
      },
      queueOptions,
      secrets,
      limits: {
        cpu_ms: (worker.limits.cpu_ms as number) ?? DEFAULT_LIMITS.cpu_ms,
        memory_mb: (worker.limits.memory_mb as number) ?? DEFAULT_LIMITS.memory_mb,
        concurrency: (worker.limits.concurrency as number) ?? DEFAULT_LIMITS.concurrency,
      },
      egress: { allowedDomains: this.deps.egressAllowedDomains, timeoutMs: this.deps.egressTimeoutMs },
    });
  }

  async invoke(workerId: string, input: { method: string; path: string; query?: Record<string, string>; headers?: Record<string, string>; body?: string }) {
    const worker = await this.getWorker(workerId);
    if (worker.status !== "active") throw new HttpError(503, "WORKER_PAUSED", `worker "${workerId}" is paused`);
    if (!this.deps.isolates.isDeployed(workerId)) {
      throw notFound(`deployed worker "${workerId}" — promote a version first`);
    }
    const startedAt = Date.now();
    let result;
    try {
      result = await this.deps.isolates.invoke({
        workerId,
        method: input.method,
        path: input.path,
        query: input.query,
        headers: input.headers,
        body: input.body,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "ResponseTooLargeError") {
        throw new HttpError(502, "WORKER_RESPONSE_TOO_LARGE", `worker response exceeds ${this.deps.maxResponseBytes} bytes`);
      }
      if (error instanceof Error && error.name === "WorkerMemoryLimitError") {
        throw new HttpError(429, "WORKER_MEMORY_LIMIT", "worker memory budget is exhausted");
      }
      throw error;
    }
    const latencyMs = Date.now() - startedAt;

    // Write request log before usage accounting so a database outage cannot hide access logs.
    await this.writeLog({
      timestamp: new Date().toISOString(),
      level: result.status >= 500 ? "error" : result.status >= 400 ? "warn" : "info",
      method: input.method,
      path: input.path,
      status: result.status,
      latencyMs,
      requestSize: input.body?.length ?? 0,
      responseSize: result.bodyText?.length ?? 0,
      clientIp: "api-invoke",
      workerId,
      message: `${input.method} ${input.path} ${result.status} ${result.status < 400 ? "OK" : "ERROR"}`,
      error: result.status >= 500 ? `HTTP ${result.status}` : undefined,
    });

    await this.deps.usage.recordSample(workerId, {
      requestsCount: 1,
      errorsCount: result.status >= 500 ? 1 : 0,
      cpuMsTotal: result.metrics.cpuMs,
    }).catch((error) => console.error("[usage] record failed:", error));

    // JSON API returns UTF-8 text (binary responses are not representable here).
    return { ...result, body: result.bodyText };
  }

  /**
   * Public ingress: invoke a worker by id (rate-limited by IP).
   */
  async invokeById(workerId: string, input: {
    method: string;
    path: string;
    query?: Record<string, string>;
    headers?: Record<string, string>;
    body?: string | Uint8Array;
  }) {
    const worker = await this.deps.workers.findActive(workerId);
    if (!worker) throw notFound("worker", workerId);
    if (worker.status !== "active") {
      throw new HttpError(503, "WORKER_PAUSED", `worker "${workerId}" is paused`);
    }

    if (!this.deps.isolates.isDeployed(workerId)) {
      throw notFound(`deployed worker "${workerId}" — promote a version first`);
    }

    const startedAt = Date.now();
    let result;
    try {
      result = await this.deps.isolates.invoke({
        workerId,
        method: input.method,
        path: input.path,
        query: input.query,
        headers: input.headers,
        body: input.body,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "ResponseTooLargeError") {
        throw new HttpError(502, "WORKER_RESPONSE_TOO_LARGE", `worker response exceeds ${this.deps.maxResponseBytes} bytes`);
      }
      if (error instanceof Error && error.name === "WorkerMemoryLimitError") {
        throw new HttpError(429, "WORKER_MEMORY_LIMIT", "worker memory budget is exhausted");
      }
      throw error;
    }
    const latencyMs = Date.now() - startedAt;

    // Write request log before usage accounting so a database outage cannot hide access logs.
    await this.writeLog({
      timestamp: new Date().toISOString(),
      level: result.status >= 500 ? "error" : result.status >= 400 ? "warn" : "info",
      method: input.method,
      path: input.path,
      status: result.status,
      latencyMs,
      requestSize: input.body instanceof Uint8Array ? input.body.byteLength : (input.body?.length ?? 0),
      responseSize: result.body instanceof Uint8Array ? result.body.byteLength : (result.bodyText?.length ?? 0),
      clientIp: "ingress",
      workerId,
      message: `${input.method} ${input.path} ${result.status} ${result.status < 400 ? "OK" : "ERROR"}`,
      error: result.status >= 500 ? `HTTP ${result.status}` : undefined,
    });

    await this.deps.usage.recordSample(workerId, {
      requestsCount: 1,
      errorsCount: result.status >= 500 ? 1 : 0,
      cpuMsTotal: result.metrics.cpuMs,
    }).catch((error) => console.error("[usage] record failed:", error));

    return { workerId, status: result.status, body: result.body, headers: result.headers };
  }

  private async writeLog(entry: LogEntry): Promise<void> {
    try {
      await new LogBinding(entry.workerId, this.deps.redis, { maxLen: 100_000 }).write(entry);
    } catch (err) {
      // Log write failures must not break the request
      console.error("[log] write failed:", err);
    }
  }

  d1FilePath(workerId: string, name: string): string {
    return join(this.deps.dataDir, "d1", workerId, `${name}.sqlite`);
  }

  async usageSummary(workerId: string, from: Date, to: Date) {
    await this.getWorker(workerId);
    return this.deps.usage.summary(workerId, from, to);
  }
}
