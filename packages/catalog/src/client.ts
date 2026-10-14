import { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

export type CatalogDb = NodePgDatabase<typeof schema>;
export { schema };

export interface CatalogConfig {
  databaseUrl: string;
  maxConnections?: number;
  /** Fail if a connection cannot be established within this time (default 10s). */
  connectionTimeoutMillis?: number;
  /** Close idle clients after this time (default 30s). */
  idleTimeoutMillis?: number;
  /** Called on background pool errors (idle client disconnects, network blips).
   *  Default: log to stderr. The pool recovers by itself; never throw here. */
  onPoolError?: (error: Error) => void;
}

export function createCatalogDb(config: CatalogConfig): { db: CatalogDb; pool: Pool } {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.maxConnections ?? 20,
    idleTimeoutMillis: config.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: config.connectionTimeoutMillis ?? 10_000,
    // Drop dead connections faster; avoids serving auth from a half-open socket.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  });

  // Without this listener a single idle-client error (e.g. "Connection
  // terminated unexpectedly" after a postgres restart) becomes an
  // uncaught 'error' event and crashes the whole process — this was the
  // "auth stops working after a few minutes + restart" symptom.
  // The pool itself discards the broken client and recovers.
  const onError = config.onPoolError ?? ((error: Error) => {
    console.error(`[catalog] pg pool background error (recovering): ${error.message}`);
  });
  pool.on("error", (error) => {
    try {
      onError(error as Error);
    } catch {
      // never let the error handler itself crash the process
    }
  });

  const db = drizzle(pool, { schema });
  return { db, pool };
}

/** Verify the database is reachable; throws with a clear message otherwise. */
export async function verifyCatalogConnectivity(
  db: CatalogDb,
  timeoutMs = 10_000
): Promise<void> {
  const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
    throw new Error(`catalog connectivity check timed out after ${timeoutMs}ms`);
  }, timeoutMs);
  timer.unref?.();
  try {
    await db.execute("SELECT 1");
  } finally {
    clearTimeout(timer);
  }
}
