import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Db = PostgresJsDatabase<typeof schema>;

/**
 * Crea il client Drizzle a partire dall'URL di connessione.
 * Factory pura: nessuna lettura di process.env, così i test possono
 * puntare a un Postgres effimero.
 */
export function createDb(databaseUrl: string): Db {
  const client = postgres(databaseUrl);
  return drizzle(client, { schema });
}

// Le migrazioni vivono in `<package root>/drizzle`. Questo modulo è in
// `src/db/` durante lo sviluppo e in `dist/db/` a runtime: in entrambi i
// casi la radice del package è due livelli sopra, quindi il percorso si
// risolve rispetto a import.meta.url e non dipende dalla cwd del processo.
const MIGRATIONS_FOLDER = path.join(fileURLToPath(new URL("../..", import.meta.url)), "drizzle");

/**
 * Applica le migrazioni pendenti. Chiamata all'avvio del server:
 * il self-hoster non lancia migrazioni a mano.
 */
export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}
