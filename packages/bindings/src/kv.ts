import type { Redis } from "ioredis";

/**
 * Implements the KVNamespace surface (get/put/delete/list/getWithMetadata)
 * backed by Redis. Keys are namespaced per worker:
 *   wp:{workerId}:kv:{namespace}:{key}
 */
export interface KVBindingOptions {
  maxKeyBytes?: number;
  maxValueBytes?: number;
  maxListLimit?: number;
}

const DEFAULT_MAX_KEY_BYTES = 512;
const DEFAULT_MAX_VALUE_BYTES = 1024 * 1024;
const DEFAULT_MAX_LIST_LIMIT = 1000;

export class KVBinding {
  private readonly limits: Required<KVBindingOptions>;

  constructor(
    private readonly workerId: string,
    private readonly namespace: string,
    private readonly redis: Redis,
    private readonly hooks: {
      onOp?: (workerId: string, op: string) => void;
    } = {},
    options: KVBindingOptions = {},
  ) {
    this.limits = {
      maxKeyBytes: options.maxKeyBytes ?? DEFAULT_MAX_KEY_BYTES,
      maxValueBytes: options.maxValueBytes ?? DEFAULT_MAX_VALUE_BYTES,
      maxListLimit: options.maxListLimit ?? DEFAULT_MAX_LIST_LIMIT,
    };
  }

  private key(key: string): string {
    return `wp:${this.workerId}:kv:${this.namespace}:${key}`;
  }

  private validateKeyValue(key: string, value?: string): void {
    if (Buffer.byteLength(key) > this.limits.maxKeyBytes) throw new Error(`KV key exceeds ${this.limits.maxKeyBytes} bytes`);
    if (value !== undefined && Buffer.byteLength(value) > this.limits.maxValueBytes) throw new Error(`KV value exceeds ${this.limits.maxValueBytes} bytes`);
  }

  async get(key: string): Promise<string | null> {
    this.validateKeyValue(key);
    this.hooks.onOp?.(this.workerId, "get");
    return this.redis.get(this.key(key));
  }

  async getWithMetadata(key: string): Promise<{ value: string | null; metadata: { expiresAt: number | null } }> {
    this.validateKeyValue(key);
    this.hooks.onOp?.(this.workerId, "get");
    const pipeline = this.redis.pipeline();
    pipeline.get(this.key(key));
    pipeline.pttl(this.key(key));
    const results = await pipeline.exec();
    const value = (results?.[0]?.[1] as string | null) ?? null;
    const pttl = (results?.[1]?.[1] as number) ?? -2;
    return {
      value,
      metadata: { expiresAt: pttl > 0 ? Date.now() + pttl : null },
    };
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.validateKeyValue(key, value);
    this.hooks.onOp?.(this.workerId, "put");
    const k = this.key(key);
    if (options?.expirationTtl !== undefined) {
      // KV semantics: TTL in seconds, minimum 60s
      await this.redis.set(k, value, "EX", Math.max(60, Math.floor(options.expirationTtl)));
    } else {
      await this.redis.set(k, value);
    }
  }

  async delete(key: string): Promise<void> {
    this.validateKeyValue(key);
    this.hooks.onOp?.(this.workerId, "delete");
    await this.redis.del(this.key(key));
  }

  /** List keys in the namespace, optionally by prefix, with cursor pagination. */
  async list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    keys: Array<{ name: string; expiration?: number | undefined }>;
    cursor: string | undefined;
    list_complete: boolean;
  }> {
    this.hooks.onOp?.(this.workerId, "list");
    const prefix = this.key(options?.prefix ?? "");
    const limit = Math.min(options?.limit ?? 100, this.limits.maxListLimit);
    const cursor = options?.cursor ?? "0";

    const [nextCursorStr, keys] = (await this.redis.scan(
      Number.parseInt(cursor, 10),
      "MATCH",
      `${prefix}*`,
      "COUNT",
      limit
    )) as [string, string[]];

    const strippedPrefix = `wp:${this.workerId}:kv:${this.namespace}:`;
    const names = keys
      .map((k: string) => k.slice(strippedPrefix.length))
      .slice(0, limit);

    const nextCursor = Number.parseInt(nextCursorStr, 10);
    return {
      keys: names.map((name: string) => ({ name, expiration: undefined })),
      cursor: nextCursor === 0 ? undefined : String(nextCursor),
      list_complete: nextCursor === 0,
    };
  }

  /** Bulk put via a single Redis pipeline (used by the API bulk endpoint). */
  async bulkPut(
    entries: Array<{ key: string; value: string; ttlSeconds?: number }>
  ): Promise<void> {
    this.hooks.onOp?.(this.workerId, "bulk_put");
    const pipeline = this.redis.pipeline();
    for (const e of entries) {
      this.validateKeyValue(e.key, e.value);
      const k = this.key(e.key);
      if (e.ttlSeconds !== undefined) {
        pipeline.set(k, e.value, "EX", Math.max(60, Math.floor(e.ttlSeconds)));
      } else {
        pipeline.set(k, e.value);
      }
    }
    await pipeline.exec();
  }

  /** Bulk delete via a single pipeline. */
  async bulkDelete(keys: string[]): Promise<void> {
    for (const key of keys) this.validateKeyValue(key);
    this.hooks.onOp?.(this.workerId, "bulk_delete");
    if (keys.length === 0) return;
    await this.redis.del(...keys.map((k) => this.key(k)));
  }
}
