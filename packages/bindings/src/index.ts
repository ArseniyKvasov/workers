import type { Client as LibSQLClient } from "@libsql/client";
import type { Redis } from "ioredis";
import { D1Binding } from "./d1.js";
import { KVBinding } from "./kv.js";
import { QueueBinding } from "./queue.js";
import { SecretCrypto, SecretsBinding } from "./secrets.js";

/** All resource hooks shared by bindings for metering/observability. */
export interface BindingHooks {
  onRowsRead?: (workerId: string, rows: number) => void;
  onRowsWritten?: (workerId: string, rows: number) => void;
  onKvOp?: (workerId: string, op: string) => void;
  onQueueSend?: (workerId: string) => void;
  onSecretOp?: (workerId: string, op: string) => void;
}

export interface BindingDependencies {
  redis: Redis;
  libsql: LibSQLClient;
  secretCrypto: SecretCrypto;
  /** Resolves the file path of a per-worker D1 database (synchronous). */
  d1FilePath: (workerId: string, name: string) => string;
  /** Loads an encrypted secret envelope from the catalog. */
  secretLoader: (workerId: string, name: string) => Promise<string | undefined>;
  hooks?: BindingHooks;
}

export interface WorkerBindings {
  d1: (name: string) => D1Binding;
  kv: (name: string) => KVBinding;
  queue: (name: string) => QueueBinding;
  secrets: () => SecretsBinding;
}

export function createBindings(workerId: string, deps: BindingDependencies): WorkerBindings {
  const hooks = deps.hooks ?? {};
  return {
    d1: (name) =>
      new D1Binding(workerId, name, deps.d1FilePath(workerId, name), {
        onRowsRead: hooks.onRowsRead,
        onRowsWritten: hooks.onRowsWritten,
      }),
    kv: (name) => new KVBinding(workerId, name, deps.redis, { onOp: hooks.onKvOp }),
    queue: (name) =>
      new QueueBinding(workerId, name, deps.redis, {}, { onSend: hooks.onQueueSend }),
    secrets: () =>
      new SecretsBinding(workerId, deps.secretCrypto, deps.secretLoader, {
        onOp: hooks.onSecretOp,
      }),
  };
}

export { D1Binding, KVBinding, QueueBinding, SecretCrypto, SecretsBinding };
