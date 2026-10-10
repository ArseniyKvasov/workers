import type { UsageRepository } from "@platform/catalog";

/**
 * Buffers per-worker binding usage deltas and flushes them to the usage
 * table on an interval. Keeps the hot path (per-row/per-op hooks) in memory.
 */
export class UsageBuffer {
  private buffers = new Map<
    string,
    {
      d1RowsRead: number;
      d1RowsWritten: number;
      kvOps: number;
      queueMessages: number;
    }
  >();

  private timer: NodeJS.Timeout | undefined;
  private flushing = false;

  constructor(private readonly usage: UsageRepository, private readonly intervalMs = 30_000) {}

  onRowsRead(workerId: string, rows: number): void {
    this.add(workerId, { d1RowsRead: rows, d1RowsWritten: 0, kvOps: 0, queueMessages: 0 });
  }

  onRowsWritten(workerId: string, rows: number): void {
    this.add(workerId, { d1RowsRead: 0, d1RowsWritten: rows, kvOps: 0, queueMessages: 0 });
  }

  onKvOp(workerId: string, _op: string): void {
    this.add(workerId, { d1RowsRead: 0, d1RowsWritten: 0, kvOps: 1, queueMessages: 0 });
  }

  onQueueSend(workerId: string): void {
    this.add(workerId, { d1RowsRead: 0, d1RowsWritten: 0, kvOps: 0, queueMessages: 1 });
  }

  private add(
    workerId: string,
    delta: { d1RowsRead: number; d1RowsWritten: number; kvOps: number; queueMessages: number }
  ): void {
    const current =
      this.buffers.get(workerId) ?? { d1RowsRead: 0, d1RowsWritten: 0, kvOps: 0, queueMessages: 0 };
    this.buffers.set(workerId, {
      d1RowsRead: current.d1RowsRead + delta.d1RowsRead,
      d1RowsWritten: current.d1RowsWritten + delta.d1RowsWritten,
      kvOps: current.kvOps + delta.kvOps,
      queueMessages: current.queueMessages + delta.queueMessages,
    });
  }

  start(): void {
    this.timer ??= setInterval(() => void this.flush(), this.intervalMs);
    this.timer.unref?.();
  }

  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      const snapshot = [...this.buffers.entries()];
      this.buffers.clear();
      for (const [workerId, delta] of snapshot) {
        if (
          delta.d1RowsRead === 0 &&
          delta.d1RowsWritten === 0 &&
          delta.kvOps === 0 &&
          delta.queueMessages === 0
        ) {
          continue;
        }
        try {
          await this.usage.recordSample(workerId, delta);
        } catch {
          // Re-accumulate on transient failure so counters are not lost.
          this.add(workerId, delta);
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.flush();
  }
}
