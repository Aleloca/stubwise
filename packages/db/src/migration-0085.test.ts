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
import { expectSqlState } from "./testing.js";

/**
 * Verifica la migrazione 0085 (adozione delle PR aperte da altri, piano
 * `docs/plans/2026-10-06-adopt-external-pr.md`): quattro colonne nullable
 * sull'adozione in `ticket_repositories` (due FK `users` `ON DELETE SET
 * NULL`), il CHECK «rilasciata solo se adottata», e `from_fork` nullable su
 * `pr_review_jobs`/`pr_reviews`. Additiva, nessun backfill: le righe di
 * prima restano mai adottate e senza verdetto sul fork.
 *
 * Strategia (come migration-0084.test): catena FINO alla 0084, semina, poi lo
 * SQL reale della 0085 in una transazione sola, come il migratore.
 */

const DRIZZLE_DIR = path.join(fileURLToPath(new URL("..", import.meta.url)), "drizzle");

async function migrationsFolderUpTo(stopBeforeIdx: number): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sw-mig85-"));
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

async function applyMigration0085(db: Db): Promise<void> {
  const raw = await readFile(path.join(DRIZZLE_DIR, "0085_pr_adoption.sql"), "utf8");
  const statements = raw
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  await db.transaction(async (tx) => {
    for (const stmt of statements) {
      await tx.execute(sql.raw(stmt));
    }
  });
}

describe("migrazione 0085: adozione delle PR aperte da altri", () => {
  let container: StartedPostgreSqlContainer;
  let db: Db;
  let client: { end: () => Promise<unknown> };
  let projectId: string;
  let repositoryId: string;
  /** Riga seminata PRIMA della 0085. */
  let preexisting: string;
  let ticketCounter = 10;

  async function insertUser(): Promise<string> {
    const rows = await db.execute<{ id: string }>(sql`
      insert into "users" ("email", "password_hash", "role")
      values (${crypto.randomUUID() + "@test.local"}, 'x', 'admin') returning "id"
    `);
    return rows[0]!.id;
  }

  async function insertRow(branch: string): Promise<string> {
    ticketCounter += 1;
    const tickets = await db.execute<{ id: string }>(sql`
      insert into "tickets" ("project_id", "number", "title", "type", "priority", "source")
      values (${projectId}, ${ticketCounter}, 'T', 'review', 'medium', 'webhook') returning "id"
    `);
    const rows = await db.execute<{ id: string }>(sql`
      insert into "ticket_repositories" ("ticket_id", "repository_id", "branch", "pr_url", "pr_number")
      values (${tickets[0]!.id}, ${repositoryId}, ${branch}, 'https://github.com/acme/r/pull/9', 9)
      returning "id"
    `);
    return rows[0]!.id;
  }

  async function rowOf(id: string): Promise<Record<string, unknown> | undefined> {
    const rows = await db.execute<{ j: Record<string, unknown> }>(sql`
      select to_jsonb(t) as j from "ticket_repositories" t where t."id" = ${id}
    `);
    return rows[0]?.j;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg17")
      .withEnvironment({ POSTGRES_INITDB_ARGS: "--locale=C" })
      .start();
    const handle = createDb(container.getConnectionUri());
    db = handle.db;
    client = handle.client;

    await migrate(db, { migrationsFolder: await migrationsFolderUpTo(85) });

    const accounts = await db.execute<{ id: string }>(sql`
      insert into "git_accounts" ("name", "provider", "encrypted_credentials")
      values ('acc', 'github', 'enc') returning "id"
    `);
    const projects = await db.execute<{ id: string }>(sql`
      insert into "projects" ("name", "slug", "ingestion_key")
      values ('P', ${"p-" + crypto.randomUUID()}, ${crypto.randomUUID()}) returning "id"
    `);
    projectId = projects[0]!.id;
    const repos = await db.execute<{ id: string }>(sql`
      insert into "repositories"
        ("project_id", "name", "slug", "provider", "git_account_id", "repo_url", "default_branch")
      values (${projectId}, 'r', ${"r-" + crypto.randomUUID()}, 'github', ${accounts[0]!.id},
              'https://github.com/acme/r', 'main')
      returning "id"
    `);
    repositoryId = repos[0]!.id;
    preexisting = await insertRow("stubwise/ticket-11");
    await db.execute(sql`
      insert into "pr_reviews" ("repository_id", "pr_number", "pr_url", "pr_title", "head_sha")
      values (${repositoryId}, 9, 'https://github.com/acme/r/pull/9', 'x', 'abc1234')
    `);

    await applyMigration0085(db);
  }, 120_000);

  afterAll(async () => {
    await client.end();
    await container.stop();
  });

  it("le righe esistenti nascono mai adottate (colonne presenti e NULL)", async () => {
    const row = await rowOf(preexisting);
    expect(row).toMatchObject({
      adopted_at: null,
      adopted_by_user_id: null,
      adoption_released_at: null,
      adoption_released_by_user_id: null,
    });
    expect(Object.keys(row ?? {})).toEqual(
      expect.arrayContaining(["adopted_at", "adopted_by_user_id", "adoption_released_at", "adoption_released_by_user_id"]),
    );
  });

  it("le review esistenti hanno from_fork NULL (non lo sappiamo), non false", async () => {
    const rows = await db.execute<{ j: Record<string, unknown> }>(sql`select to_jsonb(r) as j from "pr_reviews" r`);
    expect(rows[0]!.j).toHaveProperty("from_fork", null);
  });

  it("rilasciata senza essere stata adottata viola il CHECK", async () => {
    const id = await insertRow("feature/a");
    await expectSqlState(
      db.execute(sql`update "ticket_repositories" set "adoption_released_at" = now() where "id" = ${id}`),
      "23514",
    );
  });

  it("adozione e rilascio regolari passano; cancellare l'utente azzera solo il legame", async () => {
    const id = await insertRow("feature/b");
    const user = await insertUser();
    await db.execute(sql`
      update "ticket_repositories"
      set "adopted_at" = now(), "adopted_by_user_id" = ${user},
          "adoption_released_at" = now(), "adoption_released_by_user_id" = ${user}
      where "id" = ${id}
    `);
    await db.execute(sql`delete from "users" where "id" = ${user}`);
    const row = await rowOf(id);
    expect(row?.adopted_by_user_id).toBeNull();
    expect(row?.adoption_released_by_user_id).toBeNull();
    expect(row?.adopted_at).not.toBeNull();
    expect(row?.adoption_released_at).not.toBeNull();
  });
});
