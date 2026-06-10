import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import type postgres from "postgres";
import { createDb, runMigrations, type Db } from "../db/client.js";

export interface TestDb {
  db: Db;
  /** Da chiudere in afterAll (`await client.end()`), altrimenti vitest resta appeso. */
  client: postgres.Sql;
  /** Container Postgres effimero, da fermare in afterAll (`await container.stop()`). */
  container: StartedPostgreSqlContainer;
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
  return { db, client, container };
}
