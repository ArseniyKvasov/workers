import { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

export type CatalogDb = NodePgDatabase<typeof schema>;
export { schema };

export interface CatalogConfig {
  databaseUrl: string;
  maxConnections?: number;
}

export function createCatalogDb(config: CatalogConfig): { db: CatalogDb; pool: Pool } {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.maxConnections ?? 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  const db = drizzle(pool, { schema });
  return { db, pool };
}
