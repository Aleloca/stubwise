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
 * Verifica la migrazione 0092 (piano `docs/plans/2026-10-19-mcp-collaboratori*`):
 * `tickets.requested_by_user_id` (nullable, ON DELETE SET NULL) e la tabella
 * `backlog_item_requesters` (PK (voce, utente), cascade da voce e da utente).
 *
 * Strategia (come migration-0091.test): catena FINO alla 0091, un ticket
 * seminato, poi lo SQL reale della 0092 in una transazione sola.
 */

const DRIZZLE_DIR = path.join(fileURLToPath(new URL("..", import.meta.url)), "drizzle");

async function migrationsFolderUpTo(stopBeforeIdx: number): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sw-mig92-"));
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

async function applyMigration0092(db: Db): Promise<void> {
  const raw = await readFile(path.join(DRIZZLE_DIR, "0092_requesters.sql"), "utf8");
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

describe("migrazione 0092: autore dei ticket e richiedenti delle voci", () => {
  let container: StartedPostgreSqlContainer;
  let db: Db;
  let client: { end: () => Promise<unknown> };
  let projectId: string;
  let oldTicketId: string;

  async function insertUser(): Promise<string> {
    const rows = await db.execute<{ id: string }>(sql`
      insert into "users" ("email", "password_hash", "role")
      values (${crypto.randomUUID() + "@x.it"}, 'h', 'member') returning "id"
    `);
    return rows[0]!.id;
  }
  async function insertItem(): Promise<string> {
    const rows = await db.execute<{ id: string }>(sql`
      insert into "backlog_items" ("project_id", "title", "source")
      values (${projectId}, 'Voce', 'manual') returning "id"
    `);
    return rows[0]!.id;
  }
  async function insertTicket(requestedBy: string): Promise<string> {
    const rows = await db.execute<{ id: string }>(sql`
      insert into "tickets" ("project_id", "number", "title", "type", "priority", "source", "requested_by_user_id")
      values (${projectId}, 2, 'T2', 'bug', 'low', 'manual', ${requestedBy}) returning "id"
    `);
    return rows[0]!.id;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg17")
      .withEnvironment({ POSTGRES_INITDB_ARGS: "--locale=C" })
      .start();
    const handle = createDb(container.getConnectionUri());
    db = handle.db;
    client = handle.client;

    await migrate(db, { migrationsFolder: await migrationsFolderUpTo(92) });

    const projects = await db.execute<{ id: string }>(sql`
      insert into "projects" ("name", "slug", "ingestion_key")
      values ('P', ${"p-" + crypto.randomUUID()}, ${crypto.randomUUID()}) returning "id"
    `);
    projectId = projects[0]!.id;
    const t = await db.execute<{ id: string }>(sql`
      insert into "tickets" ("project_id", "number", "title", "type", "priority", "source")
      values (${projectId}, 1, 'Vecchio', 'bug', 'low', 'manual') returning "id"
    `);
    oldTicketId = t[0]!.id;

    await applyMigration0092(db);
  }, 180_000);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it("un ticket esistente ha requested_by_user_id NULL", async () => {
    const rows = await db.execute<{ requested_by_user_id: string | null }>(sql`
      select "requested_by_user_id" from "tickets" where "id" = ${oldTicketId}
    `);
    expect(rows[0]!.requested_by_user_id).toBeNull();
  });

  it("due richiedenti sulla stessa voce funzionano, lo stesso utente due volte viola la PK", async () => {
    const item = await insertItem();
    const a = await insertUser();
    const b = await insertUser();
    await db.execute(sql`insert into "backlog_item_requesters" ("item_id", "user_id") values (${item}, ${a}), (${item}, ${b})`);
    await expect(
      db.execute(sql`insert into "backlog_item_requesters" ("item_id", "user_id") values (${item}, ${a})`),
    ).rejects.toThrow();
    const rows = await db.execute(sql`select 1 from "backlog_item_requesters" where "item_id" = ${item}`);
    expect(rows).toHaveLength(2);
  });

  it("cancellare l'utente azzera l'autore del ticket e toglie le sue righe di richiedente", async () => {
    const u = await insertUser();
    const item = await insertItem();
    const ticket = await insertTicket(u);
    await db.execute(sql`insert into "backlog_item_requesters" ("item_id", "user_id") values (${item}, ${u})`);

    await db.execute(sql`delete from "users" where "id" = ${u}`);

    const t = await db.execute<{ requested_by_user_id: string | null }>(sql`
      select "requested_by_user_id" from "tickets" where "id" = ${ticket}
    `);
    expect(t).toHaveLength(1);
    expect(t[0]!.requested_by_user_id).toBeNull();
    const r = await db.execute(sql`select 1 from "backlog_item_requesters" where "user_id" = ${u}`);
    expect(r).toHaveLength(0);
  });

  it("cancellare la voce toglie i suoi richiedenti (e non l'utente)", async () => {
    const u = await insertUser();
    const item = await insertItem();
    await db.execute(sql`insert into "backlog_item_requesters" ("item_id", "user_id") values (${item}, ${u})`);
    await db.execute(sql`delete from "backlog_items" where "id" = ${item}`);
    const r = await db.execute(sql`select 1 from "backlog_item_requesters" where "item_id" = ${item}`);
    expect(r).toHaveLength(0);
    const users = await db.execute(sql`select 1 from "users" where "id" = ${u}`);
    expect(users).toHaveLength(1);
  });
});
