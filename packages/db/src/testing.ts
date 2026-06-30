import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import type { GitProviderKind } from "@stubwise/shared";
import type postgres from "postgres";
import { randomUUID } from "node:crypto";
import { createDb, runMigrations, type Db } from "./client.js";
import { gitAccounts, projects, repositories, tickets } from "./schema.js";

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
  // `--locale=C` forza una collation deterministica byte-per-byte all'initdb:
  // l'immagine pgvector (Debian) di default userebbe una collation locale-aware
  // che ordina le stringhe diversamente dalla precedente immagine alpine (musl/C),
  // rompendo i test che fanno ORDER BY su colonne testo (es. env-files per `path`).
  // Fissare C mantiene l'ordinamento storico e stabile tra ambienti.
  const container = await new PostgreSqlContainer("pgvector/pgvector:pg17")
    .withEnvironment({ POSTGRES_INITDB_ARGS: "--locale=C" })
    .start();
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

/**
 * Crea un progetto (gruppo) + un repository che vi appartiene, e restituisce i
 * due id. Comodo nei test che inseriscono direttamente entità repository-level
 * (docs, error groups, env files) o product-level (ticket/milestone): le prime
 * vogliono un `repositoryId`, le seconde un `projectId`. Lo slug è univoco per
 * chiamata. Il git account è seedato internamente (il repository lo richiede).
 */
export async function seedRepository(
  db: Db,
  opts: { provider?: GitProviderKind } = {},
): Promise<{ projectId: string; repositoryId: string }> {
  const gitAccountId = await seedGitAccount(db, { provider: opts.provider });
  const slug = `repo-${randomUUID()}`;
  const [project] = await db
    .insert(projects)
    .values({ name: "Progetto di test", slug: `progetto-${randomUUID()}` })
    .returning();
  if (!project) throw new Error("insert del progetto di test non ha restituito la riga");
  const [repository] = await db
    .insert(repositories)
    .values({
      projectId: project.id,
      name: "Repository di test",
      slug,
      provider: opts.provider ?? "github",
      gitAccountId,
      repoUrl: "https://example.com/repo.git",
      defaultBranch: "main",
      ingestionKey: randomUUID(),
    })
    .returning();
  if (!repository) throw new Error("insert del repository di test non ha restituito la riga");
  return { projectId: project.id, repositoryId: repository.id };
}

/**
 * Crea un progetto + repository + un ticket che vi appartiene, e restituisce gli
 * id. Il ticket è product-level (`projectId` = gruppo) ma in Fase 1 ha sempre un
 * `repositoryId` bersaglio valorizzato. `number` default 1.
 */
export async function seedTicket(
  db: Db,
  opts: { number?: number; projectId?: string; repositoryId?: string } = {},
): Promise<{ projectId: string; repositoryId: string; ticketId: string }> {
  let { projectId, repositoryId } = opts;
  if (!projectId || !repositoryId) {
    const seeded = await seedRepository(db);
    projectId = projectId ?? seeded.projectId;
    repositoryId = repositoryId ?? seeded.repositoryId;
  }
  const [ticket] = await db
    .insert(tickets)
    .values({
      projectId,
      repositoryId,
      number: opts.number ?? 1,
      title: "Ticket di test",
      type: "bug",
      priority: "medium",
      source: "manual",
    })
    .returning();
  if (!ticket) throw new Error("insert del ticket di test non ha restituito la riga");
  return { projectId, repositoryId, ticketId: ticket.id };
}
