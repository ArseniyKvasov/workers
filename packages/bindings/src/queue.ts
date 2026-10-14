import type { Redis } from "ioredis";

/**
 * Implements a Queue surface (send/batch/receive/ack) backed by Redis Streams.
 * Each queue is one stream; delivery uses consumer groups so retries and
 * acknowledgement are explicit.
 *
 * Stream key:  wp:{workerId}:queue:{name}
 * DLQ key:     wp:{workerId}:queue:{name}:dlq
 */
const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;
const DEFAULT_MAX_BATCH_SIZE = 100;
const DEFAULT_MAX_MESSAGES = 100_000;

export class QueueBinding {
  constructor(
    private readonly workerId: string,
    private readonly name: string,
    private readonly redis: Redis,
    private readonly options: { maxRetries?: number; retentionSeconds?: number; maxMessageBytes?: number; maxBatchSize?: number; maxMessages?: number } = {},
    private readonly hooks: { onSend?: (workerId: string) => void } = {}
  ) {}

  private streamKey(): string {
    return `wp:${this.workerId}:queue:${this.name}`;
  }

  private dlqKey(): string {
    return `${this.streamKey()}:dlq`;
  }

  private groupName(): string {
    return `workers`;
  }

  async send(body: string): Promise<{ messageId: string }> {
    const maxMessageBytes = this.options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    if (Buffer.byteLength(body) > maxMessageBytes) throw new Error(`queue message exceeds ${maxMessageBytes} bytes`);
    const maxMessages = this.options.maxMessages ?? DEFAULT_MAX_MESSAGES;
    if (await this.redis.xlen(this.streamKey()) >= maxMessages) throw new Error(`queue exceeds ${maxMessages} messages`);
    this.hooks.onSend?.(this.workerId);
    const id = await this.redis.xadd(
      this.streamKey(),
      "*",
      "body",
      body,
      "attempts",
      "0"
    );
    if (this.options.retentionSeconds) {
      await this.redis.xtrim(this.streamKey(), "MINID", `${Date.now() - this.options.retentionSeconds * 1000}-0`);
    }
    return { messageId: id ?? "" };
  }

  async batchSend(bodies: string[]): Promise<{ messageIds: string[] }> {
    const maxBatchSize = this.options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    if (bodies.length > maxBatchSize) throw new Error(`queue batch exceeds ${maxBatchSize} messages`);
    const ids: string[] = [];
    for (const body of bodies) {
      ids.push((await this.send(body)).messageId);
    }
    return { messageIds: ids };
  }

  /** Ensure the consumer group exists (called lazily before receive). */
  async ensureGroup(): Promise<void> {
    try {
      // Group starts at 0 so messages sent before group creation are delivered.
      await this.redis.xgroup("CREATE", this.streamKey(), this.groupName(), "0", "MKSTREAM");
    } catch {
      // BUSYGROUP: group already exists — expected on warm path
    }
  }

  /** Receive pending/new messages for a consumer. */
  async receive(consumer: string, count = 10): Promise<Array<{ id: string; body: string; attempts: number }>> {
    await this.ensureGroup();
    const results = await this.redis.xreadgroup(
      "GROUP",
      this.groupName(),
      consumer,
      "COUNT",
      count,
      "STREAMS",
      this.streamKey(),
      ">"
    );
    return this.parseRead(results as unknown as Array<[string, Array<[string, string[]]>]> | null);
  }

  /** Acknowledge successful processing. */
  async ack(messageId: string): Promise<void> {
    await this.redis.xack(this.streamKey(), this.groupName(), messageId);
  }

  /**
   * Negative acknowledgement: increment attempts; move to DLQ once
   * maxRetries is exceeded, otherwise leave pending for redelivery.
   */
  async nack(messageId: string, consumer: string): Promise<{ deadLettered: boolean; attempts: number }> {
    const entries = await this.redis.xrange(this.streamKey(), messageId, messageId);
    const first = entries[0];
    if (!first) return { deadLettered: false, attempts: 0 };

    const fields = first[1];
    const idx = fields.indexOf("attempts");
    const attempts = idx >= 0 ? Number.parseInt(fields[idx + 1] ?? "0", 10) + 1 : 1;
    const maxRetries = this.options.maxRetries ?? 3;

    if (attempts > maxRetries) {
      await this.redis.xadd(this.dlqKey(), "*", "body", fields[fields.indexOf("body") + 1] ?? "", "attempts", String(attempts));
      await this.redis.xack(this.streamKey(), this.groupName(), messageId);
      await this.redis.xdel(this.streamKey(), messageId);
      return { deadLettered: true, attempts };
    }

    await this.redis.xack(this.streamKey(), this.groupName(), messageId);
    await this.redis.xadd(this.streamKey(), "*", "body", fields[fields.indexOf("body") + 1] ?? "", "attempts", String(attempts));
    await this.redis.xdel(this.streamKey(), messageId);
    return { deadLettered: false, attempts };
  }

  /** Queue depth: total messages not yet acknowledged. */
  async depth(): Promise<{ pending: number; deadLettered: number }> {
    const pending = await this.redis.xpending(this.streamKey(), this.groupName());
    const dlqLen = await this.redis.xlen(this.dlqKey());
    return { pending: typeof pending === "object" && pending !== null && "pending" in pending ? Number((pending as { pending: string }).pending) : 0, deadLettered: dlqLen };
  }

  private parseRead(
    results: Array<[string, Array<[string, string[]]>]> | null
  ): Array<{ id: string; body: string; attempts: number }> {
    if (!results) return [];
    const messages: Array<{ id: string; body: string; attempts: number }> = [];
    for (const [, streamEntries] of results) {
      for (const [id, fields] of streamEntries ?? []) {
        const bodyIdx = fields.indexOf("body");
        const attemptsIdx = fields.indexOf("attempts");
        messages.push({
          id,
          body: bodyIdx >= 0 ? (fields[bodyIdx + 1] ?? "") : "",
          attempts: attemptsIdx >= 0 ? Number.parseInt(fields[attemptsIdx + 1] ?? "0", 10) : 0,
        });
      }
    }
    return messages;
  }
}
