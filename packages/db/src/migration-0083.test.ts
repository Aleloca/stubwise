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
 * Verifica la migrazione 0083 (risposte ai commenti, piano
 * `docs/plans/2026-10-05-ticket-history-and-replies.md`, task A1): la colonna
 * `comments.reply_to_comment_id` nasce NULL sulle righe esistenti, è una FK
 * self-reference `ON DELETE SET NULL` (cancellare l'originale lascia la
 * risposta, senza legame), e la cascata dal ticket porta via entrambi.
 *
 * Strategia (come migration-0082.test): catena FINO alla 0082, semina di
 * commenti senza la colonna, poi lo SQL reale della 0083 in una transazione
 * sola, come il migratore.
 */

const DRIZZLE_DIR = path.join(fileURLToPath(new URL("..", import.meta.url)), "drizzle");

async function migrationsFolderUpTo(stopBeforeIdx: number): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sw-mig83-"));
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

async function applyMigration0083(db: Db): Promise<void> {
  const raw = await readFile(path.join(DRIZZLE_DIR, "0083_comment_replies.sql"), "utf8");
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

describe("migrazione 0083: risposte ai commenti", () => {
  let container: StartedPostgreSqlContainer;
  let db: Db;
  let client: { end: () => Promise<unknown> };
  let projectId: string;
  /** Commento seminato PRIMA della 0083 (la colonna non esiste ancora). */
  let preexisting: string;

  async function insertTicket(n: number): Promise<string> {
    const rows = await db.execute<{ id: string }>(sql`
      insert into "tickets" ("project_id", "number", "title", "type", "priority", "source")
      values (${projectId}, ${n}, ${"T" + n}, 'bug', 'medium', 'manual')
      returning "id"
    `);
    return rows[0]!.id;
  }

  async function insertComment(ticketId: string, replyTo: string | null = null): Promise<string> {
    const rows = await db.execute<{ id: string }>(sql`
      insert into "comments" ("ticket_id", "author_type", "body", "reply_to_comment_id")
      values (${ticketId}, 'user', 'corpo', ${replyTo}) returning "id"
    `);
    return rows[0]!.id;
  }

  /**
   * `replyTo` = il valore della colonna; `"<colonna assente>"` se la 0083 non
   * l'ha creata (così un NULL vero e una colonna mancante non si confondono).
   */
  async function replyToOf(commentId: string): Promise<{ exists: boolean; replyTo: unknown }> {
    const rows = await db.execute<{ has_col: boolean; reply_to: string | null }>(sql`
      select to_jsonb(c) ? 'reply_to_comment_id' as has_col,
             to_jsonb(c) ->> 'reply_to_comment_id' as reply_to
      from "comments" c where c."id" = ${commentId}
    `);
    const row = rows[0];
    if (!row) return { exists: false, replyTo: undefined };
    return { exists: true, replyTo: row.has_col ? row.reply_to : "<colonna assente>" };
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg17")
      .withEnvironment({ POSTGRES_INITDB_ARGS: "--locale=C" })
      .start();
    const handle = createDb(container.getConnectionUri());
    db = handle.db;
    client = handle.client;

    // 1) Catena fino alla 0082.
    await migrate(db, { migrationsFolder: await migrationsFolderUpTo(83) });

    // 2) Stato pre-0083: un ticket con un commento.
    const projects = await db.execute<{ id: string }>(sql`
      insert into "projects" ("name", "slug", "ingestion_key")
      values ('P', ${"p-" + crypto.randomUUID()}, ${crypto.randomUUID()}) returning "id"
    `);
    projectId = projects[0]!.id;
    const ticketId = await insertTicket(1);
    const rows = await db.execute<{ id: string }>(sql`
      insert into "comments" ("ticket_id", "author_type", "body")
      values (${ticketId}, 'user', 'vecchio') returning "id"
    `);
    preexisting = rows[0]!.id;

    // 3) La 0083 sopra i dati seminati.
    await applyMigration0083(db);
  }, 120_000);

  afterAll(async () => {
    await client.end();
    await container.stop();
  });

  it("le righe esistenti nascono con reply_to_comment_id NULL", async () => {
    // `to_jsonb`: senza la 0083 la chiave manca (undefined), e il caso fallisce
    // sull'asserzione, non su un errore SQL.
    expect(await replyToOf(preexisting)).toEqual({ exists: true, replyTo: null });
  });

  it("una risposta a un commento esistente si inserisce col legame", async () => {
    const ticketId = await insertTicket(2);
    const original = await insertComment(ticketId);
    const reply = await insertComment(ticketId, original);
    expect(await replyToOf(reply)).toEqual({ exists: true, replyTo: original });
  });

  it("un id inesistente viola la FK", async () => {
    const ticketId = await insertTicket(3);
    await expectSqlState(insertComment(ticketId, crypto.randomUUID()), "23503");
  });

  it("cancellando l'originale la risposta resta, senza legame", async () => {
    const ticketId = await insertTicket(4);
    const original = await insertComment(ticketId);
    const reply = await insertComment(ticketId, original);
    await db.execute(sql`delete from "comments" where "id" = ${original}`);
    expect(await replyToOf(reply)).toEqual({ exists: true, replyTo: null });
  });

  it("cancellando il ticket spariscono originale e risposta", async () => {
    const ticketId = await insertTicket(5);
    const original = await insertComment(ticketId);
    const reply = await insertComment(ticketId, original);
    await db.execute(sql`delete from "tickets" where "id" = ${ticketId}`);
    expect((await replyToOf(original)).exists).toBe(false);
    expect((await replyToOf(reply)).exists).toBe(false);
  });

  it("l'indice sulla colonna esiste", async () => {
    const rows = await db.execute<{ indexname: string }>(sql`
      select indexname from pg_indexes
      where tablename = 'comments' and indexname = 'comments_reply_to_comment_id_idx'
    `);
    expect(rows.map((r) => r.indexname)).toEqual(["comments_reply_to_comment_id_idx"]);
  });
});
