import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
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
 * Migrazione 0107 (9 nov 2026, integrazione area 2): codici di progetto,
 * reparti con il ripiego «General» e nome visualizzato. Catena fino alla 0106, dati «di prima», poi lo SQL reale
 * della 0107 (come migration-0103.test).
 */

const DRIZZLE_DIR = path.join(fileURLToPath(new URL("..", import.meta.url)), "drizzle");

async function migrationsFolderUpTo(stopBeforeIdx: number): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sw-mig107-"));
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

async function insertOldProject(db: Db, slug: string, createdAt: string): Promise<void> {
  await db.execute(sql`
    insert into "projects" ("name", "slug", "ingestion_key", "created_at")
    values (${slug}, ${slug}, ${randomUUID()}, ${createdAt}::timestamptz)
  `);
}

describe("migrazione 0107: codici di progetto e reparti", () => {
  let container: StartedPostgreSqlContainer;
  let db: Db;
  let client: { end: () => Promise<unknown> };

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg17")
      .withEnvironment({ POSTGRES_INITDB_ARGS: "--locale=C" })
      .start();
    const handle = createDb(container.getConnectionUri());
    db = handle.db;
    client = handle.client;
    await migrate(db, { migrationsFolder: await migrationsFolderUpTo(107) });
    // Dati «di prima»: quattro progetti in ordine di creazione, due persone.
    await insertOldProject(db, "audin-ai", "2026-01-01T00:00:00Z");
    await insertOldProject(db, "stubwise", "2026-01-02T00:00:00Z");
    await insertOldProject(db, "stubwise-2", "2026-01-03T00:00:00Z");
    await insertOldProject(db, "x", "2026-01-04T00:00:00Z");
    await db.execute(sql`
      insert into "users" ("email", "password_hash", "role")
      values ('a@example.com', 'h', 'admin'), ('b@example.com', 'h', 'member')
    `);
    const raw = await readFile(
      path.join(DRIZZLE_DIR, "0107_project_codes_departments.sql"),
      "utf8",
    );
    const statements = raw
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    await db.transaction(async (tx) => {
      for (const stmt of statements) await tx.execute(sql.raw(stmt));
    });
  }, 180_000);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it("dà un codice unico a ogni progetto esistente, ricavato dallo slug", async () => {
    // La funzione di backfill è idempotente: rilanciarla non cambia nulla.
    await db.execute(sql`select stubwise_assign_project_codes()`);
    const rows = await db.execute<{ slug: string; code: string }>(sql`
      select "slug", "code" from "projects" order by "created_at"
    `);
    expect(rows.map((r) => [r.slug, r.code])).toEqual([
      ["audin-ai", "AUD"],
      ["stubwise", "STU"],
      ["stubwise-2", "STU2"],
      ["x", "XXX"],
    ]);
  });

  it("un progetto nuovo senza codice ne riceve uno disambiguato", async () => {
    // SQL grezzo: il DB è fermo alla 0107, uno schema Drizzle più nuovo
    // nominerebbe colonne che qui non esistono ancora.
    const [row] = await db.execute<{ code: string }>(sql`
      insert into "projects" ("name", "slug", "ingestion_key")
      values ('Altro', 'stubwise-3', ${randomUUID()}) returning "code"
    `);
    expect(row!.code).toBe("STU3");
  });

  it("crea il reparto General di ripiego con tutte le persone", async () => {
    const depts = await db.execute<{ id: string; name: string; color_token: string }>(sql`
      select "id", "name", "color_token" from "departments" where "is_default"
    `);
    expect(depts).toHaveLength(1);
    expect(depts[0]!.name).toBe("General");
    expect(depts[0]!.color_token).toBe("--dept-1");
    const members = await db.execute<{ email: string; position: number }>(sql`
      select u."email", m."position" from "department_members" m
      join "users" u on u."id" = m."user_id"
      where m."department_id" = ${depts[0]!.id}
      order by u."email"
    `);
    expect(members.map((m) => [m.email, m.position])).toEqual([
      ["a@example.com", 0],
      ["b@example.com", 0],
    ]);
  });

  it("rifiuta un secondo reparto di ripiego", async () => {
    await expectSqlState(
      db.execute(sql`
        insert into "departments" ("name", "color_token", "is_default")
        values ('Altro', '--dept-2', true)
      `),
      "23505",
    );
  });

  it("rifiuta un codice fuori formato", async () => {
    await expectSqlState(
      db.execute(sql`update "projects" set "code" = 'stw' where "slug" = 'x'`),
      "23514",
    );
  });

  it("rifiuta un codice già usato", async () => {
    await expectSqlState(
      db.execute(sql`update "projects" set "code" = 'AUD' where "slug" = 'x'`),
      "23505",
    );
  });

  it("users.display_name esiste ed è facoltativo", async () => {
    const rows = await db.execute<{ display_name: string | null }>(sql`
      select "display_name" from "users" where "email" = 'a@example.com'
    `);
    expect(rows[0]!.display_name).toBeNull();
  });
});
