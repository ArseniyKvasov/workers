import { createClient, type Client, type InValue, type ResultSet } from "@libsql/client";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Implements the D1Database surface (prepare/bind/run/all/first/dump/exec)
 * backed by a libSQL (SQLite-compatible) database file per worker.
 */
export interface D1BindingOptions {
  maxDbBytes?: number;
  maxResultRows?: number;
  maxResultBytes?: number;
}

const DEFAULT_MAX_DB_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_RESULT_ROWS = 10_000;
const DEFAULT_MAX_RESULT_BYTES = 4 * 1024 * 1024;

export class D1Binding {
  private client: Client | undefined;
  private readonly limits: Required<D1BindingOptions>;

  constructor(
    private readonly workerId: string,
    private readonly name: string,
    private readonly filePath: string,
    private readonly hooks: {
      onRowsRead?: (workerId: string, rows: number) => void;
      onRowsWritten?: (workerId: string, rows: number) => void;
    } = {},
    options: D1BindingOptions = {},
  ) {
    this.limits = {
      maxDbBytes: options.maxDbBytes ?? DEFAULT_MAX_DB_BYTES,
      maxResultRows: options.maxResultRows ?? DEFAULT_MAX_RESULT_ROWS,
      maxResultBytes: options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES,
    };
  }

  private async db(): Promise<Client> {
    this.client ??= await this.open();
    return this.client;
  }

  private async open(): Promise<Client> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const client = createClient({ url: `file:${this.filePath}` });
    const pageSize = await client.execute("PRAGMA page_size");
    const size = Number((pageSize.rows[0] as Record<string, unknown> | undefined)?.page_size ?? 4096);
    const maxPages = Math.max(1, Math.floor(this.limits.maxDbBytes / size));
    await client.execute(`PRAGMA max_page_count=${maxPages}`);
    return client;
  }

  /** Standard Workers D1 prepared-statement API. */
  prepare(sqlText: string): D1PreparedStatement {
    return new D1PreparedStatement(this, sqlText, []);
  }

  /** Execute a prepared statement's SQL and report rows read/written. */
  async executeAndReport(sqlText: string, params: unknown[]): Promise<ResultSet> {
    const client = await this.db();
    const result = await client.execute({ sql: sqlText, args: params as InValue[] });
    this.assertResultLimits(result);
    if (result.columns.length > 0) {
      this.hooks.onRowsRead?.(this.workerId, result.rows.length);
    } else {
      this.hooks.onRowsWritten?.(this.workerId, result.rowsAffected);
    }
    return result;
  }

  /** D1 batch: statements run sequentially within one implicit transaction. */
  async batch(statements: D1PreparedStatement[]): Promise<ResultSet[]> {
    const client = await this.db();
    const results: ResultSet[] = [];
    for (const stmt of statements) {
      const result = await client.execute({ sql: stmt.sqlText, args: stmt.params as InValue[] });
      this.assertResultLimits(result);
      results.push(result);
    }
    this.reportRows(results);
    return results;
  }

  /** D1 exec: multi-statement SQL string, returns no row data. */
  async exec(sqlText: string): Promise<{ count: number }> {
    const client = await this.db();
    const results = await client.executeMultiple(sqlText);
    void results;
    const count = sqlText.split(";").filter((s) => s.trim().length > 0).length;
    this.hooks.onRowsWritten?.(this.workerId, count);
    return { count };
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
  }

  private assertResultLimits(result: ResultSet): void {
    if (result.rows.length > this.limits.maxResultRows) {
      throw new Error(`D1 result exceeds ${this.limits.maxResultRows} rows`);
    }
    const bytes = Buffer.byteLength(JSON.stringify(result.rows));
    if (bytes > this.limits.maxResultBytes) {
      throw new Error(`D1 result exceeds ${this.limits.maxResultBytes} bytes`);
    }
  }

  private reportRows(results: ResultSet[]): void {
    for (const r of results) {
      if (r.columns.length > 0) {
        this.hooks.onRowsRead?.(this.workerId, r.rows.length);
      } else {
        this.hooks.onRowsWritten?.(this.workerId, r.rowsAffected);
      }
    }
  }
}

export class D1PreparedStatement {
  constructor(
    private readonly binding: D1Binding,
    readonly sqlText: string,
    readonly params: unknown[]
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new D1PreparedStatement(this.binding, this.sqlText, values);
  }

  async run(): Promise<ResultSet> {
    return (await this.all()) as ResultSet;
  }

  async all(): Promise<ResultSet> {
    return this.binding.executeAndReport(this.sqlText, this.params);
  }

  async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
    const result = await this.all();
    const row = result.rows[0];
    if (!row) return null;
    if (colName === undefined) return row as unknown as T;
    return (row as Record<string, unknown>)[colName] as T;
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    const result = await this.all();
    return result.rows as unknown as T[];
  }
}

/** Internal accessor used by D1Binding.batch to reuse the shared client. */
export async function d1ClientOf(binding: D1Binding): Promise<Client> {
  return (binding as unknown as { db(): Promise<Client> }).db();
}
