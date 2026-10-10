import { describe, expect, it, vi } from "vitest";
import { Redis } from "ioredis";
import { KVBinding } from "./kv.js";
import { QueueBinding } from "./queue.js";

/**
 * Integration tests: require a Redis-compatible server (Dragonfly/Redis) on
 * REDIS_TEST_URL. Skipped automatically when unavailable.
 */
const url = process.env.REDIS_TEST_URL ?? "redis://localhost:6379/15";

async function pingRedis(): Promise<boolean> {
  const probe = new Redis(url, { lazyConnect: true, connectTimeout: 2000 });
  try {
    await probe.connect();
    return true;
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

const hasRedis = await pingRedis();

vi.setConfig({ testTimeout: 15000 });

describe.skipIf(!hasRedis)("KVBinding", () => {
  it("put/get/delete round-trips", async () => {
    const redis = new Redis(url);
    const kv = new KVBinding("wkr_kvtest", "cache", redis);
    const cleanup = async () => {
      await kv.delete("k1");
      redis.disconnect();
    };

    await kv.put("k1", "v1");
    expect(await kv.get("k1")).toBe("v1");
    await kv.delete("k1");
    expect(await kv.get("k1")).toBeNull();
    await cleanup();
  });

  it("put with TTL expires", async () => {
    const redis = new Redis(url);
    const kv = new KVBinding("wkr_kvtest", "cache", redis);
    await kv.put("ttlkey", "soon", { expirationTtl: 60 });
    const meta = await kv.getWithMetadata("ttlkey");
    expect(meta.value).toBe("soon");
    expect(meta.metadata.expiresAt).not.toBeNull();
    await kv.delete("ttlkey");
    redis.disconnect();
  });

  it("bulk put and list with prefix", async () => {
    const redis = new Redis(url);
    const kv = new KVBinding("wkr_kvtest", "cache", redis);
    await kv.bulkPut([
      { key: "user:1", value: "a" },
      { key: "user:2", value: "b" },
      { key: "other:1", value: "c" },
    ]);

    const listed = await kv.list({ prefix: "user:" });
    expect(listed.keys.map((k) => k.name).sort()).toEqual(["user:1", "user:2"]);
    expect(listed.list_complete).toBe(true);

    await kv.bulkDelete(["user:1", "user:2", "other:1"]);
    redis.disconnect();
  });
});

describe.skipIf(!hasRedis)("QueueBinding", () => {
  it("send/receive/ack round-trips", async () => {
    const redis = new Redis(url);
    const queue = new QueueBinding("wkr_qtest", "jobs", redis);
    await queue.send("hello");
    const messages = await queue.receive("consumer-1");
    expect(messages.length).toBe(1);
    expect(messages[0]!.body).toBe("hello");
    await queue.ack(messages[0]!.id);
    const depth = await queue.depth();
    expect(depth.pending).toBe(0);
    redis.disconnect();
  });

  it("moves messages to DLQ after max retries", async () => {
    const redis = new Redis(url);
    const queue = new QueueBinding("wkr_qtest", "dlq-jobs", redis, { maxRetries: 1 });
    await redis.del("wp:wkr_qtest:queue:dlq-jobs", "wp:wkr_qtest:queue:dlq-jobs:dlq");
    const { messageId } = await queue.send("poison");

    const first = await queue.receive("consumer-dlq");
    expect(first.length).toBe(1);
    await queue.nack(first[0]!.id, "consumer-dlq"); // attempts -> 1, requeued

    const second = await queue.receive("consumer-dlq");
    expect(second.length).toBe(1);
    const result = await queue.nack(second[0]!.id, "consumer-dlq"); // attempts -> 2 > 1 => DLQ
    expect(result.deadLettered).toBe(true);

    const depth = await queue.depth();
    expect(depth.deadLettered).toBe(1);
    void messageId;
    redis.disconnect();
  });
});
