import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
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
export function createDb(databaseUrl: string, opts?: { poolMax?: number }): DbHandle {
  const client = postgres(databaseUrl, {
    // Dimensione del pool: il default di 10 connessioni basta per un'istanza
    // self-hosted a bassa concorrenza. Va alzato (via DATABASE_POOL_MAX) quando
    // si aumenta WORKER_CONCURRENCY, altrimenti i worker concorrenti si
    // contendono le connessioni. Non superare il max_connections di Postgres.
    max: opts?.poolMax ?? 10,
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

  // Seed POST-migrazione, per forza fuori dal migratore: drizzle esegue TUTTE
  // le migrazioni pendenti in un'UNICA transazione, quindi un valore enum
  // aggiunto con ALTER TYPE ADD VALUE (0037) non è usabile da una migrazione
  // successiva dello stesso batch quando l'enum pre-esiste ("unsafe use of new
  // value of enum type", 55P04). Sui DB nuovi il CREATE TYPE avviene nello
  // stesso batch e Postgres lo permette: per questo i test su container
  // freschi non vedevano il problema (emerso al primo deploy su un DB vivo).
  // La regola di automazione del tipo `review` nasce quindi qui, in una query
  // separata e idempotente: auto_fix SPENTO è l'anti-loop (il ticket creato
  // dall'automazione PR Review non deve innescare la pipeline di fix).
  await db.execute(sql`
    INSERT INTO "automation_rules" ("type", "auto_fix", "max_effort")
    VALUES ('review', false, 3)
    ON CONFLICT ("type") DO NOTHING
  `);
}
