/**
 * Platform shim: injected into every worker bundle. Receives workerd's env
 * (raw service bindings + injected JSON) and constructs the Workers env for
 * user code, using the binding names declared in the worker's manifest.
 *
 * Injected bindings (wired by the control plane):
 *   env.__D1         -> D1 service (libSQL-backed)
 *   env.__KV         -> KV service (Redis-backed)
 *   env.__QUEUE      -> Queue service (Redis Streams-backed)
 *   env.__SECRETS    -> JSON string of decrypted secret values
 *   env.__BINDINGS   -> JSON string of the manifest bindings config:
 *                       { d1_databases: [], kv_namespaces: [], queues: [] }
 *
 * After the shim runs, user code sees e.g. env.LMS_DB.prepare(...),
 * env.CACHE.get(...), env.JOBS.send(...), env.SECRETS.get(...).
 */
import user from "__user_code__.ts";

interface ServiceLike {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface BindingsJson {
  d1_databases?: string[];
  kv_namespaces?: string[];
  queues?: string[];
}

/** Log entry structure for forwarding console logs */
interface LogEntry {
  timestamp: string;
  message?: string;
  level: "info" | "warn" | "error";
  method: string;
  path: string;
  status: number;
  latencyMs: number;
  requestSize: number;
  responseSize: number;
  clientIp: string;
  workerId: string;
  error?: string;
  traceId?: string;
}

async function callService(
  service: ServiceLike | undefined,
  name: string,
  op: string,
  payload: unknown
): Promise<unknown> {
  if (!service) {
    throw new Error(`binding service unavailable for op "${op}"`);
  }
  const res = await service.fetch("http://platform.internal/binding", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op, payload: { name, ...((payload as object) ?? {}) } }),
  });
  const json = (await res.json()) as { ok: boolean; result?: unknown; error?: string };
  if (!json.ok) {
    throw new Error(json.error ?? `binding op "${op}" failed`);
  }
  return json.result;
}

interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  run(): Promise<unknown>;
  all(): Promise<unknown>;
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
  raw<T = unknown[]>(): Promise<T[]>;
}

function createD1Client(service: ServiceLike | undefined, name: string) {
  function makeStatement(sqlText: string, params: unknown[]): D1Statement {
    return {
      bind(...values: unknown[]) {
        return makeStatement(sqlText, values);
      },
      async run() {
        return callService(service, name, "d1.run", { sql: sqlText, params });
      },
      async all() {
        return callService(service, name, "d1.all", { sql: sqlText, params });
      },
      async first<T>(colName?: string): Promise<T | null> {
        const row = (await callService(service, name, "d1.first", { sql: sqlText, params })) as
          | Record<string, unknown>
          | null;
        if (row === null) return null;
        if (colName === undefined) return row as unknown as T;
        return (row[colName] ?? null) as T;
      },
      async raw<T>(): Promise<T[]> {
        return (await callService(service, name, "d1.raw", { sql: sqlText, params })) as T[];
      },
    };
  }

  return {
    prepare(sqlText: string): D1Statement {
      return makeStatement(sqlText, []);
    },
    async batch(statements: Array<{ sqlText?: string; sql?: string; params?: unknown[] }>) {
      return callService(service, name, "d1.batch", {
        statements: statements.map((s) => ({ sql: s.sqlText ?? s.sql ?? "", params: s.params ?? [] })),
      });
    },
    async exec(sqlText: string) {
      return callService(service, name, "d1.exec", { sql: sqlText });
    },
  };
}

function createKVClient(service: ServiceLike | undefined, name: string) {
  return {
    async get(key: string): Promise<string | null> {
      return (await callService(service, name, "kv.get", { key })) as string | null;
    },
    async getWithMetadata(key: string) {
      return (await callService(service, name, "kv.getWithMetadata", { key })) as {
        value: string | null;
        metadata: { expiresAt: number | null };
      };
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }) {
      return callService(service, name, "kv.put", { key, value, options });
    },
    async delete(key: string) {
      return callService(service, name, "kv.delete", { key });
    },
    async list(options?: { prefix?: string; cursor?: string; limit?: number }) {
      return callService(service, name, "kv.list", { options }) as Promise<{
        keys: Array<{ name: string }>;
        cursor: string | undefined;
        list_complete: boolean;
      }>;
    },
  };
}

function createQueueClient(service: ServiceLike | undefined, name: string) {
  return {
    async send(body: unknown): Promise<{ messageId: string }> {
      return (await callService(service, name, "queue.send", { body })) as { messageId: string };
    },
    async batchSend(bodies: unknown[]): Promise<{ messageIds: string[] }> {
      return (await callService(service, name, "queue.batchSend", { bodies })) as { messageIds: string[] };
    },
  };
}

function parseJson(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

let globalConsoleInstalled = false;
let activeConsoleSink: ((level: "info" | "warn" | "error", args: unknown[]) => void) | undefined;

function installGlobalConsole(logsService: ServiceLike | undefined, workerId: string, waitUntil: (promise: Promise<unknown>) => void): void {
  if (!logsService) return;
  const nativeConsole = globalThis.console;
  activeConsoleSink = (level, args) => {
    const message = args.map(String).join(" ");
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      message,
      level,
      method: "LOG",
      path: "/",
      status: 0,
      latencyMs: 0,
      requestSize: 0,
      responseSize: 0,
      clientIp: "worker",
      workerId,
      error: level === "error" ? message : undefined,
    };
    waitUntil(callService(logsService, "logs", "logs.write", entry).catch(() => {}));
  };
  if (globalConsoleInstalled) return;
  globalConsoleInstalled = true;
  globalThis.console = {
    ...nativeConsole,
    log: (...args: unknown[]) => { nativeConsole.log(...args); activeConsoleSink?.("info", args); },
    info: (...args: unknown[]) => { nativeConsole.info(...args); activeConsoleSink?.("info", args); },
    warn: (...args: unknown[]) => { nativeConsole.warn(...args); activeConsoleSink?.("warn", args); },
    error: (...args: unknown[]) => { nativeConsole.error(...args); activeConsoleSink?.("error", args); },
  } as Console;
}

function buildUserEnv(rawEnv: Record<string, unknown>, waitUntil: (promise: Promise<unknown>) => void): Record<string, unknown> {
  const env: Record<string, unknown> = {};
  const bindings = parseJson(rawEnv["__BINDINGS"]) as BindingsJson;

  for (const name of bindings.d1_databases ?? []) {
    env[name] = createD1Client(rawEnv["__D1"] as ServiceLike, name);
  }
  for (const name of bindings.kv_namespaces ?? []) {
    env[name] = createKVClient(rawEnv["__KV"] as ServiceLike, name);
  }
  for (const name of bindings.queues ?? []) {
    env[name] = createQueueClient(rawEnv["__QUEUE"] as ServiceLike, name);
  }

  const secretValues = parseJson(rawEnv["__SECRETS"]) as Record<string, string>;
  env["SECRETS"] = {
    get: (name: string): string | null => secretValues[name] ?? null,
  };

  // Inject LOGS binding for console forwarding
  const logsService = rawEnv["__LOGS"] as ServiceLike | undefined;
  if (logsService) {
    env["LOGS"] = {
      async write(entry: LogEntry): Promise<void> {
        await callService(logsService, "logs", "logs.write", { ...entry, workerId: entry.workerId ?? rawEnv["__WORKER_ID"] as string });
      },
    };
  }

  const workerId = rawEnv["__WORKER_ID"] as string | undefined ?? "unknown";
  installGlobalConsole(logsService, workerId, waitUntil);
  env["console"] = {
    log: (...args: unknown[]) => activeConsoleSink?.("info", args),
    info: (...args: unknown[]) => activeConsoleSink?.("info", args),
    warn: (...args: unknown[]) => activeConsoleSink?.("warn", args),
    error: (...args: unknown[]) => activeConsoleSink?.("error", args),
  };

  return env;
}

export default {
  async fetch(
    request: Request,
    rawEnv: Record<string, unknown>,
    ctx: { waitUntil(promise: Promise<unknown>): void }
  ): Promise<Response> {
    const userEnv = buildUserEnv(rawEnv, (promise) => ctx.waitUntil(promise));
    return user.fetch(request, userEnv, ctx);
  },
};
