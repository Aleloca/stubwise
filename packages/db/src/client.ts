import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Db = PostgresJsDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  /** Client postgres-js sottostante: serve per chiudere la connessione (`client.end()`). */
  client: postgres.Sql;
}

/**
 * Crea il client Drizzle a partire dall'URL di connessione.
 * Factory pura: nessuna lettura di process.env, così i test possono
 * puntare a un Postgres effimero. Restituisce anche il client postgres-js
 * perché i chiamanti (test su testcontainers in primis) devono poter
 * chiudere la connessione, altrimenti il processo resta appeso.
 */
export function createDb(databaseUrl: string): DbHandle {
  const client = postgres(databaseUrl, {
    // Dimensione del pool scelta deliberatamente: 10 connessioni bastano per
    // un'istanza self-hosted e non esauriscono il max_connections di Postgres.
    max: 10,
    // Silenzia i NOTICE di Postgres (es. "relation already exists" durante
    // le migrazioni) che altrimenti finirebbero su stderr.
    onnotice: () => {},
  });
  return { db: drizzle(client, { schema }), client };
}

// Le migrazioni vivono in `<package root>/drizzle`. Questo modulo è in
// `src/` durante lo sviluppo e in `dist/` a runtime: in entrambi i casi la
// radice del package è un livello sopra, quindi il percorso si risolve
// rispetto a import.meta.url e non dipende dalla cwd del processo.
const MIGRATIONS_FOLDER = path.join(fileURLToPath(new URL("..", import.meta.url)), "drizzle");

/**
 * Applica le migrazioni pendenti. Le lancia solo il server all'avvio
 * (il self-hoster non lancia migrazioni a mano); il worker assume che lo
 * schema esista già.
 */
export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}
