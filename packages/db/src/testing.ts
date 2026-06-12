import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import type { GitProviderKind } from "@stubwise/shared";
import type postgres from "postgres";
import { createDb, runMigrations, type Db } from "./client.js";
import { gitAccounts } from "./schema.js";

export interface TestDb {
  db: Db;
  /** Da chiudere in afterAll (`await client.end()`), altrimenti vitest resta appeso. */
  client: postgres.Sql;
  /** Container Postgres effimero, da fermare in afterAll (`await container.stop()`). */
  container: StartedPostgreSqlContainer;
  /** Teardown unificato per afterAll: chiude il client e poi ferma il container. */
  stop(): Promise<void>;
}

/**
 * Avvia un Postgres effimero via testcontainers, ci applica le migrazioni
 * e restituisce il client Drizzle pronto all'uso. Pensato per essere
 * chiamato una volta per file di test (in `beforeAll`): l'avvio del
 * container costa secondi, condividerlo tra i test del file lo ammortizza.
 */
export async function startTestDb(): Promise<TestDb> {
  const container = await new PostgreSqlContainer("postgres:17-alpine").start();
  const { db, client } = createDb(container.getConnectionUri());
  await runMigrations(db);
  return {
    db,
    client,
    container,
    async stop() {
      await client.end();
      await container.stop();
    },
  };
}

let accountSeq = 0;

/**
 * Crea un account git e ne restituisce l'id, comodo nei test che inseriscono
 * progetti direttamente (i progetti richiedono un git_account_id non nullo).
 * Le credenziali sono già cifrate dal chiamante (o un blob placeholder se non
 * rilevanti al test); il nome è univoco per chiamata.
 */
export async function seedGitAccount(
  db: Db,
  opts: { provider?: GitProviderKind; encryptedCredentials?: string } = {},
): Promise<string> {
  accountSeq++;
  const [row] = await db
    .insert(gitAccounts)
    .values({
      name: `Account di test ${accountSeq}`,
      provider: opts.provider ?? "github",
      encryptedCredentials: opts.encryptedCredentials ?? "blob-cifrato-placeholder",
    })
    .returning();
  if (!row) throw new Error("insert dell'account di test non ha restituito la riga");
  return row.id;
}
