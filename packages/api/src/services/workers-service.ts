import { createHash } from "node:crypto";
import { join } from "node:path";
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
import { DEFAULT_LIMITS, PLATFORM_LIMITS, type Manifest } from "@platform/types";
import { notFound, payloadTooLarge, limitExceeded, conflict, HttpError } from "../errors.js";
import { DEPLOY_CODE_MAX_BYTES } from "@platform/types";

export interface WorkersServiceDeps {
  workers: WorkersRepository;
  versions: VersionsRepository;
  bindingsRepo: BindingsRepository;
  secretsRepo: SecretsRepository;
  d1Catalog: D1CatalogRepository;
  kvCatalog: KVCatalogRepository;
  queuesCatalog: QueuesCatalogRepository;
  usage: UsageRepository;
  isolates: IsolateManager;
  secretCrypto: SecretCrypto;
  dataDir: string;
}

export class WorkersService {
  constructor(private readonly deps: WorkersServiceDeps) {}

  async createWorker(input: {
    name: string;
    runtime: string;
    limits?: Partial<{ cpu_ms: number; memory_mb: number; concurrency: number }>;
  }) {
    const existing = await this.deps.workers.listActive(1000, 0);
    if (existing.some((w) => w.name === input.name)) {
      throw conflict(`worker "${input.name}" already exists`);
    }
    if (existing.length >= PLATFORM_LIMITS.max_workers) {
      throw limitExceeded(`platform worker limit (${PLATFORM_LIMITS.max_workers}) reached`);
    }

    const worker = await this.deps.workers.create({
      name: input.name,
      runtime: input.runtime,
      limits: { ...DEFAULT_LIMITS, ...(input.limits ?? {}) } as Record<string, unknown>,
    });
    return worker;
  }

  async getWorker(id: string) {
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

  async updateWorker(id: string, patch: { name?: string; status?: string; limits?: Record<string, unknown> }) {
    await this.getWorker(id);
    const updated = await this.deps.workers.update(id, patch);
    return updated;
  }

  async deleteWorker(id: string) {
    await this.getWorker(id);
    await this.deps.isolates.stop(id);
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
    void versions; // history retained; ceiling enforced by retention job

    const code = input.code.toString("utf8");
    const codeHash = createHash("sha256").update(code).digest("hex");

    const manifest = {
      entrypoint: input.manifest?.entrypoint ?? "src/index.ts",
      bindings: input.manifest?.bindings ?? { d1_databases: [], kv_namespaces: [], queues: [], secrets: [] },
      limits: input.manifest?.limits ?? {},
      compatibility_date: input.manifest?.compatibility_date ?? "2026-10-10",
      node_compat: input.manifest?.node_compat ?? true,
    };

    const version = await this.deps.versions.create({
      workerId: worker.id,
      codeHash,
      bundleSize: input.code.byteLength,
      code,
      manifest: manifest as unknown as Record<string, unknown>,
    });

    // Sync effective bindings for the runtime env
    const bindingRows: Array<{ bindingType: string; bindingName: string; configJson?: Record<string, unknown> }> = [];
    for (const name of manifest.bindings.d1_databases ?? []) {
      const db = await this.deps.d1Catalog.findByWorkerAndName(worker.id, name);
      if (!db) throw notFound(`D1 database "${name}" is not created for this worker`);
      bindingRows.push({ bindingType: "d1", bindingName: name, configJson: { filePath: db.filePath } });
    }
    for (const name of manifest.bindings.kv_namespaces ?? []) {
      const ns = await this.deps.kvCatalog.findByWorkerAndName(worker.id, name);
      if (!ns) throw notFound(`KV namespace "${name}" is not created for this worker`);
      bindingRows.push({ bindingType: "kv", bindingName: name });
    }
    for (const name of manifest.bindings.queues ?? []) {
      const q = await this.deps.queuesCatalog.findByWorkerAndName(worker.id, name);
      if (!q) throw notFound(`queue "${name}" is not created for this worker`);
      bindingRows.push({ bindingType: "queue", bindingName: name });
    }
    await this.deps.bindingsRepo.syncForWorker(worker.id, bindingRows);

    // Promote atomically
    const promoted = await this.deps.versions.promote(worker.id, version.id);
    if (!promoted) throw notFound("version", version.id);

    // Decrypt all secrets for injection into the isolate
    const secretNames = await this.deps.secretsRepo.listNames(worker.id);
    const secrets: Record<string, string> = {};
    for (const name of secretNames) {
      const envelope = await this.deps.secretsRepo.getDecryptedSource(worker.id, name);
      if (envelope) {
        secrets[name] = this.deps.secretCrypto.decrypt(worker.id, envelope);
      }
    }

    // Hot reload or cold start the isolate
    await this.deps.isolates.deploy({
      workerId: worker.id,
      versionId: version.id,
      code,
      bindings: {
        d1_databases: manifest.bindings.d1_databases ?? [],
        kv_namespaces: manifest.bindings.kv_namespaces ?? [],
        queues: manifest.bindings.queues ?? [],
      },
      secrets,
      limits: {
        cpu_ms: (worker.limits.cpu_ms as number) ?? DEFAULT_LIMITS.cpu_ms,
        memory_mb: (worker.limits.memory_mb as number) ?? DEFAULT_LIMITS.memory_mb,
        concurrency: (worker.limits.concurrency as number) ?? DEFAULT_LIMITS.concurrency,
      },
      egress: { allowedDomains: [] },
    });

    return { version, promoted };
  }

  async listVersions(workerId: string, limit: number, offset: number) {
    await this.getWorker(workerId);
    return this.deps.versions.listByWorker(workerId, limit, offset);
  }

  async promoteVersion(workerId: string, versionId: string) {
    await this.getWorker(workerId);
    const version = await this.deps.versions.find(versionId);
    if (!version || version.workerId !== workerId) throw notFound("version", versionId);

    const promoted = await this.deps.versions.promote(workerId, versionId);
    if (!promoted) throw notFound("version", versionId);

    // Re-deploy from stored code (hot reload)
    await this.deployStored(workerId, promoted);
    return promoted;
  }

  async rollback(workerId: string) {
    await this.getWorker(workerId);
    const previous = await this.deps.versions.rollback(workerId);
    if (!previous) throw notFound("previous version to roll back to");
    await this.deployStored(workerId, previous);
    return previous;
  }

  async deleteVersion(workerId: string, versionId: string) {
    await this.getWorker(workerId);
    const deleted = await this.deps.versions.deleteNonPromoted(workerId, versionId);
    if (!deleted) throw notFound("non-promoted version", versionId);
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

    const bindingRows = await this.deps.bindingsRepo.listForWorker(workerId);
    const d1Names = bindingRows.filter((b) => b.bindingType === "d1").map((b) => b.bindingName);
    const kvNames = bindingRows.filter((b) => b.bindingType === "kv").map((b) => b.bindingName);
    const queueNames = bindingRows.filter((b) => b.bindingType === "queue").map((b) => b.bindingName);

    await this.deps.isolates.deploy({
      workerId,
      versionId: version.id,
      code: version.code,
      bindings: { d1_databases: d1Names, kv_namespaces: kvNames, queues: queueNames },
      secrets,
      limits: {
        cpu_ms: (worker.limits.cpu_ms as number) ?? DEFAULT_LIMITS.cpu_ms,
        memory_mb: (worker.limits.memory_mb as number) ?? DEFAULT_LIMITS.memory_mb,
        concurrency: (worker.limits.concurrency as number) ?? DEFAULT_LIMITS.concurrency,
      },
      egress: { allowedDomains: [] },
    });
  }

  async invoke(workerId: string, input: { method: string; path: string; query?: Record<string, string>; headers?: Record<string, string>; body?: string }) {
    await this.getWorker(workerId);
    if (!this.deps.isolates.isDeployed(workerId)) {
      throw notFound(`deployed worker "${workerId}" — promote a version first`);
    }
    const result = await this.deps.isolates.invoke({
      workerId,
      method: input.method,
      path: input.path,
      query: input.query,
      headers: input.headers,
      body: input.body,
    });

    await this.deps.usage.recordSample(workerId, {
      requestsCount: 1,
      errorsCount: result.status >= 500 ? 1 : 0,
      cpuMsTotal: result.metrics.cpuMs,
    });

    return result;
  }

  /**
   * Public ingress: anyone can call a worker by name. Resolves the worker
   * name to its isolate and forwards the raw request.
   */
  async invokeByName(workerName: string, input: {
    method: string;
    path: string;
    query?: Record<string, string>;
    headers?: Record<string, string>;
    body?: string;
  }) {
    const worker = await this.deps.workers.findActiveByName(workerName);
    if (!worker) throw notFound("worker", workerName);
    if (worker.status !== "active") {
      throw new HttpError(503, "WORKER_PAUSED", `worker "${workerName}" is paused`);
    }
    if (!this.deps.isolates.isDeployed(worker.id)) {
      throw notFound(`deployed worker "${workerName}" — promote a version first`);
    }

    const result = await this.deps.isolates.invoke({
      workerId: worker.id,
      method: input.method,
      path: input.path,
      query: input.query,
      headers: input.headers,
      body: input.body,
    });

    await this.deps.usage.recordSample(worker.id, {
      requestsCount: 1,
      errorsCount: result.status >= 500 ? 1 : 0,
      cpuMsTotal: result.metrics.cpuMs,
    });

    return { workerId: worker.id, ...result };
  }

  d1FilePath(workerId: string, name: string): string {
    return join(this.deps.dataDir, "d1", workerId, `${name}.sqlite`);
  }

  async usageSummary(workerId: string, from: Date, to: Date) {
    await this.getWorker(workerId);
    return this.deps.usage.summary(workerId, from, to);
  }
}
