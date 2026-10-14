import { D1Binding, KVBinding, QueueBinding, LogBinding } from "@platform/bindings";
import type { Redis } from "ioredis";
import type { Client as LibSQLClient } from "@libsql/client";

/**
 * Fetch-based services wired into worker isolates via Miniflare function
 * service bindings. Each handler receives the shim's JSON-RPC envelope and
 * dispatches to the corresponding binding implementation.
 */
export type ServiceHandler = (request: Request) => Promise<Response>;

export interface BindingServiceOptions {
  redis: Redis;
  libsql: LibSQLClient;
  /** Resolves the SQLite file path for a worker's D1 database (sync). */
  d1FilePath: (workerId: string, name: string) => string;
  hooks?: {
    onRowsRead?: (workerId: string, rows: number) => void;
    onRowsWritten?: (workerId: string, rows: number) => void;
    onKvOp?: (workerId: string, op: string) => void;
    onQueueSend?: (workerId: string) => void;
  };
}

interface Envelope {
  op: string;
  payload: unknown;
}

const d1Bindings = new Map<string, D1Binding>();
const kvBindings = new Map<string, KVBinding>();
const queueBindings = new Map<string, QueueBinding>();
const logBindings = new Map<string, LogBinding>();

function ok(result: unknown): Response {
  return Response.json({ ok: true, result });
}

function fail(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  return Response.json({ ok: false, error: message }, { status: 400 });
}

export function createBindingServices(workerId: string, options: BindingServiceOptions): {
  d1: ServiceHandler;
  kv: ServiceHandler;
  queue: ServiceHandler;
  logs: ServiceHandler;
  /** Drop cached binding instances for this worker (on reload). */
  dispose: () => Promise<void>;
} {
  const hooks = options.hooks ?? {};

  function d1For(name: string): D1Binding {
    const cacheKey = `${workerId}:${name}`;
    let binding = d1Bindings.get(cacheKey);
    if (!binding) {
      binding = new D1Binding(workerId, name, options.d1FilePath(workerId, name), {
        onRowsRead: hooks.onRowsRead,
        onRowsWritten: hooks.onRowsWritten,
      });
      d1Bindings.set(cacheKey, binding);
    }
    return binding;
  }

  function kvFor(name: string): KVBinding {
    const cacheKey = `${workerId}:${name}`;
    let binding = kvBindings.get(cacheKey);
    if (!binding) {
      binding = new KVBinding(workerId, name, options.redis, { onOp: hooks.onKvOp });
      kvBindings.set(cacheKey, binding);
    }
    return binding;
  }

  function queueFor(name: string): QueueBinding {
    const cacheKey = `${workerId}:${name}`;
    let binding = queueBindings.get(cacheKey);
    if (!binding) {
      binding = new QueueBinding(workerId, name, options.redis, {}, { onSend: hooks.onQueueSend });
      queueBindings.set(cacheKey, binding);
    }
    return binding;
  }

  function logsFor(): LogBinding {
    const cacheKey = `${workerId}:logs`;
    let binding = logBindings.get(cacheKey);
    if (!binding) {
      binding = new LogBinding(workerId, options.redis, { maxLen: 100_000 });
      logBindings.set(cacheKey, binding);
    }
    return binding;
  }

  async function d1Handler(request: Request): Promise<Response> {
    try {
      const { op, payload } = (await request.json()) as Envelope;
      const p = payload as { name?: string; sql?: string; params?: unknown[]; statements?: unknown[] };
      const binding = d1For(p.name ?? "default");

      switch (op) {
        case "d1.run":
          return ok(await binding.prepare(p.sql ?? "").bind(...(p.params ?? [])).run());
        case "d1.all":
          return ok(await binding.prepare(p.sql ?? "").bind(...(p.params ?? [])).all());
        case "d1.first": {
          const row = await binding.prepare(p.sql ?? "").bind(...(p.params ?? [])).first();
          return ok(row);
        }
        case "d1.raw":
          return ok(await binding.prepare(p.sql ?? "").bind(...(p.params ?? [])).raw());
        case "d1.batch":
          return ok(
            await binding.batch(
              (p.statements ?? []).map((s) => {
                const stmt = s as { sql: string; params?: unknown[] };
                return binding.prepare(stmt.sql).bind(...(stmt.params ?? []));
              })
            )
          );
        case "d1.exec":
          return ok(await binding.exec(p.sql ?? ""));
        default:
          return fail(new Error(`unknown D1 op "${op}"`));
      }
    } catch (error) {
      return fail(error);
    }
  }

  async function kvHandler(request: Request): Promise<Response> {
    try {
      const { op, payload } = (await request.json()) as Envelope;
      const p = payload as {
        name?: string;
        key?: string;
        value?: string;
        options?: { expirationTtl?: number };
        bodies?: unknown[];
        body?: unknown;
      };
      const binding = kvFor(p.name ?? "default");

      switch (op) {
        case "kv.get":
          return ok(await binding.get(p.key ?? ""));
        case "kv.getWithMetadata":
          return ok(await binding.getWithMetadata(p.key ?? ""));
        case "kv.put":
          return ok(await binding.put(p.key ?? "", p.value ?? "", p.options));
        case "kv.delete":
          return ok(await binding.delete(p.key ?? ""));
        case "kv.list":
          return ok(await binding.list(p.options as { prefix?: string; cursor?: string; limit?: number }));
        default:
          return fail(new Error(`unknown KV op "${op}"`));
      }
    } catch (error) {
      return fail(error);
    }
  }

  async function queueHandler(request: Request): Promise<Response> {
    try {
      const { op, payload } = (await request.json()) as Envelope;
      const p = payload as { name?: string; body?: unknown; bodies?: unknown[] };
      const binding = queueFor(p.name ?? "default");

      switch (op) {
        case "queue.send":
          return ok(await binding.send(JSON.stringify(p.body ?? null)));
        case "queue.batchSend":
          return ok(
            await binding.batchSend((p.bodies ?? []).map((b) => JSON.stringify(b ?? null)))
          );
        default:
          return fail(new Error(`unknown Queue op "${op}"`));
      }
    } catch (error) {
      return fail(error);
    }
  }

  async function logsHandler(request: Request): Promise<Response> {
    try {
      const { op, payload } = (await request.json()) as Envelope;
      const binding = logsFor();

      switch (op) {
        case "logs.write": {
          const p = payload as Record<string, unknown>;
          const entry = {
            timestamp: (p.timestamp as string) ?? new Date().toISOString(),
            level: (p.level as "info" | "warn" | "error") ?? "info",
            method: (p.method as string) ?? "LOG",
            path: (p.path as string) ?? "/",
            status: (p.status as number) ?? 0,
            latencyMs: (p.latencyMs as number) ?? 0,
            requestSize: (p.requestSize as number) ?? 0,
            responseSize: (p.responseSize as number) ?? 0,
            clientIp: (p.clientIp as string) ?? "worker",
            workerId,
            error: p.error as string | undefined,
            traceId: p.traceId as string | undefined,
          };
          await binding.write(entry);
          return ok({ written: true });
        }
        default:
          return fail(new Error(`unknown Logs op "${op}"`));
      }
    } catch (error) {
      return fail(error);
    }
  }

  return {
    d1: d1Handler,
    kv: kvHandler,
    queue: queueHandler,
    logs: logsHandler,
    dispose: async () => {
      const closing: Promise<void>[] = [];
      for (const [key, binding] of [...d1Bindings.entries()]) {
        if (key.startsWith(`${workerId}:`)) {
          closing.push(binding.close().catch(() => {}));
          d1Bindings.delete(key);
        }
      }
      for (const key of [...kvBindings.keys()]) if (key.startsWith(`${workerId}:`)) kvBindings.delete(key);
      for (const key of [...queueBindings.keys()]) if (key.startsWith(`${workerId}:`)) queueBindings.delete(key);
      for (const key of [...logBindings.keys()]) if (key.startsWith(`${workerId}:`)) logBindings.delete(key);
      await Promise.all(closing);
    },
  };
}
