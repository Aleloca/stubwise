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
 * Verifica la migrazione 0084 (modificare e cancellare i commenti, piano
 * `docs/plans/2026-10-05-comment-edit-delete.md`, task A1): tre colonne
 * nullable (`edited_at`, `deleted_at`, `deleted_by_user_id` con FK `users`
 * `ON DELETE SET NULL`) e due CHECK che fanno del segnaposto una garanzia del
 * DATABASE: un commento eliminato ha `body = ''`, e `deleted_by_user_id` non
 * esiste senza `deleted_at`.
 *
 * Strategia (come migration-0083.test): catena FINO alla 0083, semina di un
 * commento senza le colonne, poi lo SQL reale della 0084 in una transazione
 * sola, come il migratore.
 */

const DRIZZLE_DIR = path.join(fileURLToPath(new URL("..", import.meta.url)), "drizzle");

async function migrationsFolderUpTo(stopBeforeIdx: number): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sw-mig84-"));
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

async function applyMigration0084(db: Db): Promise<void> {
  const raw = await readFile(path.join(DRIZZLE_DIR, "0084_comment_edit_delete.sql"), "utf8");
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

describe("migrazione 0084: modificare e cancellare i commenti", () => {
  let container: StartedPostgreSqlContainer;
  let db: Db;
  let client: { end: () => Promise<unknown> };
  let ticketId: string;
  /** Commento seminato PRIMA della 0084 (le colonne non esistono ancora). */
  let preexisting: string;

  async function insertUser(): Promise<string> {
    const rows = await db.execute<{ id: string }>(sql`
      insert into "users" ("email", "password_hash", "role")
      values (${crypto.randomUUID() + "@test.local"}, 'x', 'admin') returning "id"
    `);
    return rows[0]!.id;
  }

  async function insertComment(body = "corpo"): Promise<string> {
    const rows = await db.execute<{ id: string }>(sql`
      insert into "comments" ("ticket_id", "author_type", "body")
      values (${ticketId}, 'user', ${body}) returning "id"
    `);
    return rows[0]!.id;
  }

  /** La riga come jsonb: una colonna che la 0084 non ha creato è `undefined`, non NULL. */
  async function rowOf(commentId: string): Promise<Record<string, unknown> | undefined> {
    const rows = await db.execute<{ j: Record<string, unknown> }>(sql`
      select to_jsonb(c) as j from "comments" c where c."id" = ${commentId}
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

    // 1) Catena fino alla 0083.
    await migrate(db, { migrationsFolder: await migrationsFolderUpTo(84) });

    // 2) Stato pre-0084: un ticket con un commento.
    const projects = await db.execute<{ id: string }>(sql`
      insert into "projects" ("name", "slug", "ingestion_key")
      values ('P', ${"p-" + crypto.randomUUID()}, ${crypto.randomUUID()}) returning "id"
    `);
    const tickets = await db.execute<{ id: string }>(sql`
      insert into "tickets" ("project_id", "number", "title", "type", "priority", "source")
      values (${projects[0]!.id}, 1, 'T', 'bug', 'medium', 'manual') returning "id"
    `);
    ticketId = tickets[0]!.id;
    preexisting = await insertComment("vecchio");

    // 3) La 0084 sopra i dati seminati.
    await applyMigration0084(db);
  }, 120_000);

  afterAll(async () => {
    await client.end();
    await container.stop();
  });

  it("le righe esistenti nascono con le tre colonne NULL e il corpo intatto", async () => {
    const row = await rowOf(preexisting);
    expect(row).toMatchObject({
      body: "vecchio",
      edited_at: null,
      deleted_at: null,
      deleted_by_user_id: null,
    });
    // `toMatchObject` accetterebbe chiavi mancanti come `undefined`? No: ma lo
    // si dice esplicito, perché il difetto da escludere è la colonna assente.
    expect(Object.keys(row ?? {})).toEqual(
      expect.arrayContaining(["edited_at", "deleted_at", "deleted_by_user_id"]),
    );
  });

  it("un eliminato con un corpo non vuoto viola il CHECK", async () => {
    const id = await insertComment("testo che deve sparire");
    await expectSqlState(
      db.execute(sql`update "comments" set "deleted_at" = now() where "id" = ${id}`),
      "23514",
    );
    expect((await rowOf(id))?.deleted_at).toBeNull();
  });

  it("deleted_by_user_id senza deleted_at viola il CHECK", async () => {
    const id = await insertComment();
    const user = await insertUser();
    await expectSqlState(
      db.execute(sql`update "comments" set "body" = '', "deleted_by_user_id" = ${user} where "id" = ${id}`),
      "23514",
    );
  });

  it("un'eliminazione regolare (corpo vuoto, data e autore) passa", async () => {
    const id = await insertComment();
    const user = await insertUser();
    await db.execute(sql`
      update "comments" set "body" = '', "deleted_at" = now(), "deleted_by_user_id" = ${user}
      where "id" = ${id}
    `);
    const row = await rowOf(id);
    expect(row?.body).toBe("");
    expect(row?.deleted_at).not.toBeNull();
    expect(row?.deleted_by_user_id).toBe(user);
  });

  it("cancellando l'utente che ha eliminato, il legame diventa NULL e la riga resta", async () => {
    const id = await insertComment();
    const user = await insertUser();
    await db.execute(sql`
      update "comments" set "body" = '', "deleted_at" = now(), "deleted_by_user_id" = ${user}
      where "id" = ${id}
    `);
    await db.execute(sql`delete from "users" where "id" = ${user}`);
    const row = await rowOf(id);
    expect(row).toBeDefined();
    expect(row?.deleted_by_user_id).toBeNull();
    expect(row?.deleted_at).not.toBeNull();
  });

  it("edited_at si scrive su un commento vivo", async () => {
    const id = await insertComment();
    await db.execute(sql`update "comments" set "body" = 'nuovo', "edited_at" = now() where "id" = ${id}`);
    const row = await rowOf(id);
    expect(row?.body).toBe("nuovo");
    expect(row?.edited_at).not.toBeNull();
  });
});
