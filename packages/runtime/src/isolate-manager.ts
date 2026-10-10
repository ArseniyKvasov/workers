import { Miniflare, type MiniflareOptions } from "miniflare";
import type { Redis } from "ioredis";
import type { Client as LibSQLClient } from "@libsql/client";
import { bundleWithShim, bundleWorkerSource } from "./bundler.js";
import { createBindingServices, type ServiceHandler } from "./binding-services.js";
import { createOutboundService, type EgressConfig } from "./egress.js";
import { getMetrics } from "@platform/observability";
import { randomUUID } from "node:crypto";
import { loadShimSource } from "./shim-source.js";

export interface IsolateDeployInput {
  workerId: string;
  versionId: string;
  /** Bundled or raw worker source. */
  code: string;
  /** Manifest bindings: which named resources to expose in env. */
  bindings: {
    d1_databases?: string[];
    kv_namespaces?: string[];
    queues?: string[];
  };
  secrets: Record<string, string>;
  limits: { cpu_ms: number; memory_mb: number; concurrency: number };
  egress: EgressConfig;
}

export interface InvokeInput {
  workerId: string;
  method: string;
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: string;
}

export interface InvokeResult {
  status: number;
  body: string;
  headers: Record<string, string>;
  metrics: { cpuMs: number; wallMs: number };
}

export interface IsolateRuntimeDeps {
  redis: Redis;
  libsql: LibSQLClient;
  d1FilePath: (workerId: string, name: string) => string;
  egressDefaults: EgressConfig;
  /** Extra hooks merged into every worker's binding services (usage metering). */
  bindingUsageHooks?: {
    onRowsRead?: (workerId: string, rows: number) => void;
    onRowsWritten?: (workerId: string, rows: number) => void;
    onKvOp?: (workerId: string, op: string) => void;
    onQueueSend?: (workerId: string) => void;
  };
}

interface WorkerIsolate {
  mf: Miniflare;
  versionId: string;
  concurrency: number;
  services: { d1: ServiceHandler; kv: ServiceHandler; queue: ServiceHandler; dispose: () => void };
  inFlight: number;
  draining: boolean;
}

const MAX_CONCURRENCY_FLOOR = 1;

export class IsolateManager {
  private readonly isolates = new Map<string, WorkerIsolate>();
  private readonly metrics = getMetrics();

  constructor(private readonly deps: IsolateRuntimeDeps) {
    this.metrics.isolatesActive.set(0);
  }

  /**
   * Deploy (or hot-reload) a worker isolate from source. A warm reload swaps
   * the running script in place: in-flight requests finish against the old
   * script, new requests hit the new one.
   */
  async deploy(input: IsolateDeployInput): Promise<{ reloaded: boolean }> {
    const existing = this.isolates.get(input.workerId);
    if (existing) {
      await this.applyScript(existing, input);
      return { reloaded: true };
    }
    await this.start(input);
    return { reloaded: false };
  }

  private async start(input: IsolateDeployInput): Promise<void> {
    const services = this.createServices(input);
    const mf = new Miniflare(await this.buildOptions(input, services));
    await mf.ready;

    const isolate: WorkerIsolate = {
      mf,
      versionId: input.versionId,
      concurrency: Math.max(MAX_CONCURRENCY_FLOOR, input.limits.concurrency),
      services,
      inFlight: 0,
      draining: false,
    };
    this.isolates.set(input.workerId, isolate);
    this.metrics.isolatesActive.set(this.isolates.size);
  }

  private async applyScript(isolate: WorkerIsolate, input: IsolateDeployInput): Promise<void> {
    const options = await this.buildOptions(input, isolate.services);
    isolate.versionId = input.versionId;
    isolate.concurrency = Math.max(MAX_CONCURRENCY_FLOOR, input.limits.concurrency);
    await isolate.mf.setOptions(options);
  }

  private createServices(input: IsolateDeployInput) {
    const usage = this.deps.bindingUsageHooks;
    const services = createBindingServices(input.workerId, {
      redis: this.deps.redis,
      libsql: this.deps.libsql,
      d1FilePath: this.deps.d1FilePath,
      hooks: {
        onRowsRead: (wid, rows) => {
          this.metrics.d1RowsRead.inc({ worker_id: wid }, rows);
          usage?.onRowsRead?.(wid, rows);
        },
        onRowsWritten: (wid, rows) => {
          this.metrics.d1RowsWritten.inc({ worker_id: wid }, rows);
          usage?.onRowsWritten?.(wid, rows);
        },
        onKvOp: (wid, op) => {
          this.metrics.kvOpsTotal.inc({ worker_id: wid, type: op });
          usage?.onKvOp?.(wid, op);
        },
        onQueueSend: (wid) => {
          this.metrics.queueMessagesTotal.inc({ worker_id: wid });
          usage?.onQueueSend?.(wid);
        },
      },
    });
    return services;
  }

  private async buildOptions(
    input: IsolateDeployInput,
    services: ReturnType<IsolateManager["createServices"]>
  ): Promise<MiniflareOptions> {
    const shimSource = loadShimSource();
    const userBundle = await bundleWorkerSource(input.code);
    const shimBundle = await bundleWithShim(userBundle.code, shimSource);

    const concurrency = Math.max(MAX_CONCURRENCY_FLOOR, input.limits.concurrency);
    const outbound = createOutboundService(input.workerId, input.egress, {
      onEgressBytes: (wid, bytes) => this.metrics.egressBytesTotal.inc({ worker_id: wid }, bytes),
    });

    return {
      name: `wp-${input.workerId}`,
      workers: [
        {
          name: `wp-${input.workerId}`,
          modules: true,
          script: shimBundle.code,
          bindings: {
            __SECRETS: JSON.stringify(input.secrets),
            __BINDINGS: JSON.stringify(input.bindings),
          },
          serviceBindings: {
            __D1: services.d1,
            __KV: services.kv,
            __QUEUE: services.queue,
          },
          compatibilityFlags: ["nodejs_compat"],
          limits: {
            cpuMs: input.limits.cpu_ms,
          },
          outboundService: outbound,
        },
      ],
      compatibilityDate: "2026-10-10",
    } as unknown as MiniflareOptions;
  }

  /** Synchronously dispatch a request into the worker isolate. */
  async invoke(input: InvokeInput): Promise<InvokeResult> {
    const isolate = this.isolates.get(input.workerId);
    if (!isolate) throw new Error(`worker "${input.workerId}" is not deployed`);
    if (isolate.draining) throw new Error(`worker "${input.workerId}" is draining; not accepting requests`);

    const concurrency = isolate.concurrency;
    if (isolate.inFlight >= concurrency) {
      const err = new Error(`worker "${input.workerId}" concurrency limit reached`);
      err.name = "ConcurrencyLimitError";
      throw err;
    }

    isolate.inFlight++;
    const startedAt = Date.now();
    const requestId = randomUUID();

    try {
      const url = new URL(`http://worker.internal${input.path.startsWith("/") ? input.path : `/${input.path}`}`);
      for (const [key, value] of Object.entries(input.query ?? {})) {
        url.searchParams.set(key, value);
      }

      const response = await isolate.mf.dispatchFetch(url.toString(), {
        method: input.method,
        headers: {
          ...(input.headers ?? {}),
          "x-platform-request-id": requestId,
        },
        body: input.body,
      } as unknown as Parameters<typeof isolate.mf.dispatchFetch>[1]);
      const body = await response.text();

      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });

      const wallMs = Date.now() - startedAt;
      this.metrics.requestsTotal.inc({ worker_id: input.workerId, status: String(response.status) });
      this.metrics.requestDuration.observe({ worker_id: input.workerId }, wallMs / 1000);

      return { status: response.status, body, headers, metrics: { cpuMs: 0, wallMs } };
    } catch (error) {
      const isEgress = error instanceof Error && error.name === "EgressBlockedError";
      const isConcurrency = error instanceof Error && error.name === "ConcurrencyLimitError";
      this.metrics.requestsTotal.inc({
        worker_id: input.workerId,
        status: isEgress ? "403" : isConcurrency ? "429" : "500",
      });
      if (!isEgress && !isConcurrency) {
        this.metrics.errorsTotal.inc({ worker_id: input.workerId, type: "invoke" });
      }
      throw error;
    } finally {
      isolate.inFlight--;
    }
  }

  private getConcurrency(_workerId: string): number {
    // Per-worker concurrency is enforced against inFlight; the configured
    // value lives with the manifest. Platform default applies when unknown.
    return 100;
  }

  /** Gracefully stop one worker: mark draining, wait for in-flight, dispose. */
  async stop(workerId: string, drainTimeoutMs = 30_000): Promise<void> {
    const isolate = this.isolates.get(workerId);
    if (!isolate) return;

    isolate.draining = true;
    const deadline = Date.now() + drainTimeoutMs;
    while (isolate.inFlight > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    isolate.services.dispose();
    await isolate.mf.dispose();
    this.isolates.delete(workerId);
    this.metrics.isolatesActive.set(this.isolates.size);
  }

  /** Stop all isolates (graceful shutdown path). */
  async stopAll(drainTimeoutMs = 30_000): Promise<void> {
    await Promise.all([...this.isolates.keys()].map((id) => this.stop(id, drainTimeoutMs)));
  }

  isDeployed(workerId: string): boolean {
    return this.isolates.has(workerId);
  }

  deployedVersion(workerId: string): string | undefined {
    return this.isolates.get(workerId)?.versionId;
  }
}
