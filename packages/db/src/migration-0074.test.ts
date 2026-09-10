import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client.js";

/**
 * Verifica la migrazione 0074 (fase 8 — ambienti di progetto) sul suo caso
 * critico, il BACKFILL: non è cosmetico. In produzione ci sono repository con
 * `.env` già popolati che la pipeline di fix legge a ogni run
 * (`loadProjectEnvFiles`) — se restassero senza ambiente dopo la migrazione,
 * il fix smetterebbe di trovarli.
 *
 * Strategia (come migration-0041.test): si applica la catena FINO alla 0073
 * (project_env_files ancora senza environment_id), si seminano due progetti —
 * ciascuno con più repository, ciascuno con file d'ambiente esistenti — e SOLO
 * DOPO si esegue lo SQL reale della 0074, asserendo l'esito.
 */

const DRIZZLE_DIR = path.join(fileURLToPath(new URL("..", import.meta.url)), "drizzle");

async function migrationsFolderUpTo(stopBeforeIdx: number): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sw-mig74-"));
  await cp(DRIZZLE_DIR, dir, { recursive: true });
  const journalPath = path.join(dir, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
    entries: { idx: number; tag: string }[];
  };
  const dropped = journal.entries.filter((e) => e.idx >= stopBeforeIdx);
  journal.entries = journal.entries.filter((e) => e.idx < stopBeforeIdx);
  await writeFile(journalPath, JSON.stringify(journal, null, 2));
  await Promise.all(dropped.map((e) => rm(path.join(dir, `${e.tag}.sql`), { force: true })));
  return dir;
}

async function applyMigration0074(db: Db): Promise<void> {
  const raw = await readFile(path.join(DRIZZLE_DIR, "0074_project_environments.sql"), "utf8");
  const statements = raw
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  // Come il migratore reale: tutti gli statement in UNA transazione.
  await db.transaction(async (tx) => {
    for (const stmt of statements) {
      await tx.execute(sql.raw(stmt));
    }
  });
}

async function seedProject(db: Db, name: string): Promise<string> {
  const rows = await db.execute<{ id: string }>(sql`
    insert into "projects" ("name", "slug", "ingestion_key")
    values (${name}, ${"proj-" + crypto.randomUUID()}, ${crypto.randomUUID()})
    returning "id"
  `);
  return rows[0]!.id;
}

async function seedGitAccount(db: Db): Promise<string> {
  const rows = await db.execute<{ id: string }>(sql`
    insert into "git_accounts" ("name", "provider", "encrypted_credentials")
    values ('acc', 'github', 'enc')
    returning "id"
  `);
  return rows[0]!.id;
}

async function seedRepository(
  db: Db,
  projectId: string,
  gitAccountId: string,
  name: string,
): Promise<string> {
  const rows = await db.execute<{ id: string }>(sql`
    insert into "repositories"
      ("project_id", "name", "slug", "provider", "git_account_id", "repo_url", "default_branch")
    values (
      ${projectId}, ${name}, ${"repo-" + crypto.randomUUID()}, 'github', ${gitAccountId},
      'https://github.com/acme/x', 'main'
    )
    returning "id"
  `);
  return rows[0]!.id;
}

async function seedEnvFile(db: Db, repositoryId: string, filePath: string): Promise<string> {
  const rows = await db.execute<{ id: string }>(sql`
    insert into "project_env_files" ("repository_id", "path")
    values (${repositoryId}, ${filePath})
    returning "id"
  `);
  return rows[0]!.id;
}

describe("migrazione 0074: ambienti di progetto (fase 8)", () => {
  let container: StartedPostgreSqlContainer;
  let db: Db;
  let client: { end: () => Promise<unknown> };

  // Progetto 1: DUE repository, ciascuno con un file d'ambiente esistente —
  // il caso reale di produzione (20 repository con .env popolati).
  let project1Id: string;
  let repo1aId: string;
  let repo1bId: string;
  let envFile1aId: string;
  let envFile1bId: string;

  // Progetto 2: UN repository senza NESSUN file d'ambiente — deve comunque
  // ricevere il proprio ambiente `test` (il backfill 1/2 non dipende
  // dall'esistenza di file).
  let project2Id: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg17")
      .withEnvironment({ POSTGRES_INITDB_ARGS: "--locale=C" })
      .start();
    const handle = createDb(container.getConnectionUri());
    db = handle.db;
    client = handle.client;

    // 1) Catena fino alla 0073 (project_env_files ancora senza environment_id).
    const folder = await migrationsFolderUpTo(74);
    await migrate(db, { migrationsFolder: folder });

    // 2) Semina lo stato pre-0074.
    const gitAccountId = await seedGitAccount(db);

    project1Id = await seedProject(db, "P1");
    repo1aId = await seedRepository(db, project1Id, gitAccountId, "repo-a");
    repo1bId = await seedRepository(db, project1Id, gitAccountId, "repo-b");
    envFile1aId = await seedEnvFile(db, repo1aId, ".env");
    envFile1bId = await seedEnvFile(db, repo1bId, ".env.local");

    project2Id = await seedProject(db, "P2");
    await seedRepository(db, project2Id, gitAccountId, "repo-c"); // nessun file d'ambiente

    // 3) Applica la 0074 sopra i dati seminati.
    await applyMigration0074(db);
  }, 120_000);

  afterAll(async () => {
    await client.end();
    await container.stop();
  });

  it("ogni progetto riceve un ambiente `test`, anche quello senza file d'ambiente", async () => {
    const rows = await db.execute<{ project_id: string; name: string; kind: string }>(sql`
      select "project_id", "name", "kind" from "project_environments"
      where "project_id" in (${project1Id}, ${project2Id})
      order by "project_id"
    `);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.name).toBe("test");
      expect(row.kind).toBe("test");
    }
  });

  it("le righe esistenti di project_env_files si collegano all'ambiente test DEL LORO progetto", async () => {
    const envRows = await db.execute<{ id: string }>(sql`
      select "id" from "project_environments" where "project_id" = ${project1Id}
    `);
    const testEnvId = envRows[0]!.id;

    const fileRows = await db.execute<{ id: string; environment_id: string }>(sql`
      select "id", "environment_id" from "project_env_files"
      where "id" in (${envFile1aId}, ${envFile1bId})
    `);
    expect(fileRows).toHaveLength(2);
    for (const row of fileRows) {
      expect(row.environment_id).toBe(testEnvId);
    }
  });

  it("nessuna riga di project_env_files resta con environment_id NULL (NOT NULL applicato con successo)", async () => {
    const rows = await db.execute<{ count: string }>(sql`
      select count(*)::text as count from "project_env_files" where "environment_id" is null
    `);
    expect(rows[0]!.count).toBe("0");
  });

  it("due progetti → due ambienti `test` DISTINTI (nessun cross-link)", async () => {
    const rows = await db.execute<{ project_id: string; id: string }>(sql`
      select "project_id", "id" from "project_environments"
      where "project_id" in (${project1Id}, ${project2Id})
    `);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.id).not.toBe(rows[1]!.id);
  });

  it("l'unique (project_id, name) su project_environments impedisce un secondo `test` sullo stesso progetto", async () => {
    await expect(
      db.execute(sql`
        insert into "project_environments" ("project_id", "name", "kind")
        values (${project1Id}, 'test', 'test')
      `),
    ).rejects.toThrow();
  });

  it("l'unique (repository, environment, path) su project_env_files ammette lo stesso path in ambienti diversi", async () => {
    const envRows = await db.execute<{ id: string }>(sql`
      select "id" from "project_environments" where "project_id" = ${project1Id}
    `);
    const testEnvId = envRows[0]!.id;
    const stagingRows = await db.execute<{ id: string }>(sql`
      insert into "project_environments" ("project_id", "name", "kind")
      values (${project1Id}, 'staging', 'staging')
      returning "id"
    `);
    const stagingEnvId = stagingRows[0]!.id;

    // Stesso path (".env"), stesso repository, ambiente DIVERSO: deve passare.
    await expect(
      db.execute(sql`
        insert into "project_env_files" ("repository_id", "environment_id", "path")
        values (${repo1aId}, ${stagingEnvId}, '.env')
      `),
    ).resolves.not.toThrow();

    // Stesso path, stesso repository, STESSO ambiente (test): deve fallire.
    await expect(
      db.execute(sql`
        insert into "project_env_files" ("repository_id", "environment_id", "path")
        values (${repo1aId}, ${testEnvId}, '.env')
      `),
    ).rejects.toThrow();
  });

  it("il CHECK su kind rifiuta un valore fuori da test|staging|production", async () => {
    await expect(
      db.execute(sql`
        insert into "project_environments" ("project_id", "name", "kind")
        values (${project2Id}, 'canary', 'canary')
      `),
    ).rejects.toThrow();
  });
});
