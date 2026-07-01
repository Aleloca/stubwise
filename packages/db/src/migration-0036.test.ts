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
 * Verifica la migrazione 0036 (ricerca globale, cronologia unificata) sul suo
 * caso critico: le righe della vecchia `doc_search_history` devono MIGRARE in
 * `search_history` come `type='doc'`, con entity_id/route derivati, subtitle=kind
 * e repository_id/clicked_at conservati; poi la vecchia tabella è droppata.
 *
 * Strategia (come migration-0035.test): si applica la catena FINO alla 0035
 * (journal temporaneo senza la 0036), si seminano righe in `doc_search_history`
 * e SOLO DOPO si esegue lo SQL reale della 0036, asserendo l'esito.
 */

const DRIZZLE_DIR = path.join(fileURLToPath(new URL("..", import.meta.url)), "drizzle");

async function migrationsFolderUpTo(stopBeforeIdx: number): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sw-mig36-"));
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

async function applyMigration0036(db: Db): Promise<void> {
  const raw = await readFile(path.join(DRIZZLE_DIR, "0036_global_search_history.sql"), "utf8");
  const statements = raw
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    await db.execute(sql.raw(stmt));
  }
}

async function seedGitAccount(db: Db): Promise<string> {
  const rows = await db.execute<{ id: string }>(sql`
    insert into "git_accounts" ("name", "provider", "encrypted_credentials")
    values (${"acct-" + crypto.randomUUID()}, 'github', 'blob')
    returning "id"
  `);
  return rows[0]!.id;
}

async function seedProject(db: Db): Promise<string> {
  const rows = await db.execute<{ id: string }>(sql`
    insert into "projects" ("name", "slug", "ingestion_key")
    values ('P', ${"proj-" + crypto.randomUUID()}, ${crypto.randomUUID()})
    returning "id"
  `);
  return rows[0]!.id;
}

async function seedRepository(db: Db, projectId: string, gitAccountId: string): Promise<string> {
  const rows = await db.execute<{ id: string }>(sql`
    insert into "repositories" (
      "project_id", "name", "slug", "provider", "git_account_id", "repo_url", "default_branch"
    ) values (
      ${projectId}, 'R', ${"repo-" + crypto.randomUUID()}, 'github', ${gitAccountId},
      'https://example.com/r.git', 'main'
    ) returning "id"
  `);
  return rows[0]!.id;
}

async function seedUser(db: Db): Promise<string> {
  const rows = await db.execute<{ id: string }>(sql`
    insert into "users" ("email", "password_hash", "role")
    values (${"u-" + crypto.randomUUID() + "@example.com"}, 'x', 'member')
    returning "id"
  `);
  return rows[0]!.id;
}

describe("migrazione 0036: cronologia Docs → search_history unificata", () => {
  let container: StartedPostgreSqlContainer;
  let db: Db;
  let client: { end: () => Promise<unknown> };

  let userId: string;
  let repositoryId: string;
  const clickedAt = "2024-03-14T10:00:00.000Z";

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg17")
      .withEnvironment({ POSTGRES_INITDB_ARGS: "--locale=C" })
      .start();
    const handle = createDb(container.getConnectionUri());
    db = handle.db;
    client = handle.client;

    // 1) Catena fino alla 0035 (doc_search_history ancora presente).
    const folder = await migrationsFolderUpTo(36);
    await migrate(db, { migrationsFolder: folder });

    // 2) Semina due righe di cronologia Docs (stato pre-0036).
    const gitAccountId = await seedGitAccount(db);
    const projectId = await seedProject(db);
    repositoryId = await seedRepository(db, projectId, gitAccountId);
    userId = await seedUser(db);
    await db.execute(sql`
      insert into "doc_search_history" ("repository_id", "user_id", "slug", "title", "kind", "snippet", "clicked_at")
      values
        (${repositoryId}, ${userId}, 'panoramica', 'Panoramica', 'technical', 'estratto', ${clickedAt}::timestamptz),
        (${repositoryId}, ${userId}, 'onboarding', 'Onboarding', 'manual', null, ${clickedAt}::timestamptz)
    `);

    // 3) Applica la 0036 sopra i dati seminati.
    await applyMigration0036(db);
  }, 120_000);

  afterAll(async () => {
    await client.end();
    await container.stop();
  });

  it("le righe Docs migrano in search_history come type='doc' con i campi derivati", async () => {
    const rows = await db.execute<{
      type: string;
      entity_id: string;
      title: string;
      subtitle: string | null;
      route: string;
      repository_id: string | null;
      clicked_at: Date;
    }>(sql`
      select "type", "entity_id", "title", "subtitle", "route", "repository_id", "clicked_at"
      from "search_history" where "user_id" = ${userId} order by "entity_id"
    `);
    expect(rows).toHaveLength(2);

    const onboarding = rows.find((r) => r.entity_id === `${repositoryId}:onboarding`)!;
    expect(onboarding).toBeDefined();
    expect(onboarding.type).toBe("doc");
    expect(onboarding.title).toBe("Onboarding");
    expect(onboarding.subtitle).toBe("manual");
    expect(onboarding.route).toBe(`/docs/${repositoryId}/onboarding`);
    expect(onboarding.repository_id).toBe(repositoryId);
    expect(new Date(onboarding.clicked_at).toISOString()).toBe(clickedAt);

    const panoramica = rows.find((r) => r.entity_id === `${repositoryId}:panoramica`)!;
    expect(panoramica.subtitle).toBe("technical");
    expect(panoramica.route).toBe(`/docs/${repositoryId}/panoramica`);
  });

  it("la vecchia tabella doc_search_history è stata droppata", async () => {
    const rows = await db.execute<{ exists: boolean }>(sql`
      select exists (
        select 1 from information_schema.tables
        where table_schema = 'public' and table_name = 'doc_search_history'
      ) as exists
    `);
    expect(rows[0]!.exists).toBe(false);
  });

  it("l'unique (user_id, type, entity_id) è attiva su search_history", async () => {
    await expect(
      db.execute(sql`
        insert into "search_history" ("user_id", "type", "entity_id", "title", "route")
        values (${userId}, 'doc', ${`${repositoryId}:panoramica`}, 'Dup', '/x')
      `),
    ).rejects.toThrow();
  });

  it("l'enum search_entity accetta i quattro tipi", async () => {
    const rows = await db.execute<{ labels: string[] }>(sql`
      select array_agg(e.enumlabel order by e.enumsortorder) as labels
      from pg_type t join pg_enum e on e.enumtypid = t.oid
      where t.typname = 'search_entity'
    `);
    expect(rows[0]!.labels).toEqual(["ticket", "project", "repository", "doc"]);
  });
});
