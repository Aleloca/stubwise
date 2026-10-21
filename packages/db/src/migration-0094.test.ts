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
 * Verifica la migrazione 0094 (reset e cambio della password, 21 ott 2026):
 * la tabella `password_reset_tokens` — hash unique, cascade dall'utente,
 * autore `ON DELETE SET NULL`.
 *
 * Strategia (come migration-0092.test): catena FINO alla 0093, poi lo SQL
 * reale della 0094 in una transazione sola, come fa il migratore.
 */

const DRIZZLE_DIR = path.join(fileURLToPath(new URL("..", import.meta.url)), "drizzle");

async function migrationsFolderUpTo(stopBeforeIdx: number): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sw-mig94-"));
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

async function applyMigration0094(db: Db): Promise<void> {
  const raw = await readFile(path.join(DRIZZLE_DIR, "0094_password_reset_tokens.sql"), "utf8");
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

describe("migrazione 0094: link di reset della password", () => {
  let container: StartedPostgreSqlContainer;
  let db: Db;
  let client: { end: () => Promise<unknown> };

  async function insertUser(): Promise<string> {
    const rows = await db.execute<{ id: string }>(sql`
      insert into "users" ("email", "password_hash", "role")
      values (${crypto.randomUUID() + "@x.it"}, 'h', 'member') returning "id"
    `);
    return rows[0]!.id;
  }
  async function insertToken(userId: string, createdBy: string | null, hash: string) {
    await db.execute(sql`
      insert into "password_reset_tokens" ("user_id", "token_hash", "expires_at", "created_by_user_id")
      values (${userId}, ${hash}, now() + interval '1 day', ${createdBy})
    `);
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg17")
      .withEnvironment({ POSTGRES_INITDB_ARGS: "--locale=C" })
      .start();
    const handle = createDb(container.getConnectionUri());
    db = handle.db;
    client = handle.client;
    await migrate(db, { migrationsFolder: await migrationsFolderUpTo(94) });
    await applyMigration0094(db);
  }, 180_000);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it("una riga nuova nasce senza used_at e con created_at valorizzato", async () => {
    const u = await insertUser();
    await insertToken(u, null, "hash-a");
    const rows = await db.execute<{ used_at: Date | null; created_at: Date | null }>(sql`
      select "used_at", "created_at" from "password_reset_tokens" where "token_hash" = 'hash-a'
    `);
    expect(rows[0]!.used_at).toBeNull();
    expect(rows[0]!.created_at).not.toBeNull();
  });

  it("lo stesso hash due volte viola il vincolo unique", async () => {
    const u = await insertUser();
    await insertToken(u, null, "hash-dup");
    await expect(insertToken(u, null, "hash-dup")).rejects.toThrow();
  });

  it("cancellare l'utente toglie i suoi link", async () => {
    const u = await insertUser();
    await insertToken(u, null, "hash-cascade");
    await db.execute(sql`delete from "users" where "id" = ${u}`);
    const rows = await db.execute(sql`
      select 1 from "password_reset_tokens" where "token_hash" = 'hash-cascade'
    `);
    expect(rows).toHaveLength(0);
  });

  it("cancellare l'admin che l'ha emesso azzera l'autore e lascia il link", async () => {
    const admin = await insertUser();
    const u = await insertUser();
    await insertToken(u, admin, "hash-author");
    await db.execute(sql`delete from "users" where "id" = ${admin}`);
    const rows = await db.execute<{ created_by_user_id: string | null }>(sql`
      select "created_by_user_id" from "password_reset_tokens" where "token_hash" = 'hash-author'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.created_by_user_id).toBeNull();
  });
});
