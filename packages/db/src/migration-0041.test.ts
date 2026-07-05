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
 * Verifica la migrazione 0041 (multi-widget) sul suo caso critico: la vecchia
 * `widget_settings` (1:1 per progetto) migra in una riga della nuova tabella
 * `widgets` (N per progetto, key univoca), con la config copiata fedelmente; le
 * conversazioni esistenti puntano al widget derivato via `widget_id`; infine
 * `widget_settings` è droppata.
 *
 * Strategia (come migration-0036.test): si applica la catena FINO alla 0040
 * (widget_settings ancora presente), si seminano progetto/settings/conversazione
 * e SOLO DOPO si esegue lo SQL reale della 0041, asserendo l'esito.
 */

const DRIZZLE_DIR = path.join(fileURLToPath(new URL("..", import.meta.url)), "drizzle");

async function migrationsFolderUpTo(stopBeforeIdx: number): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sw-mig41-"));
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

async function applyMigration0041(db: Db): Promise<void> {
  const raw = await readFile(path.join(DRIZZLE_DIR, "0041_multi_widget.sql"), "utf8");
  const statements = raw
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    await db.execute(sql.raw(stmt));
  }
}

async function seedProject(db: Db): Promise<string> {
  const rows = await db.execute<{ id: string }>(sql`
    insert into "projects" ("name", "slug", "ingestion_key")
    values ('P', ${"proj-" + crypto.randomUUID()}, ${crypto.randomUUID()})
    returning "id"
  `);
  return rows[0]!.id;
}

describe("migrazione 0041: widget_settings → widgets (multi-widget)", () => {
  let container: StartedPostgreSqlContainer;
  let db: Db;
  let client: { end: () => Promise<unknown> };

  let projectId: string;
  let conversationId: string;
  const enabledRepositoryIds = [crypto.randomUUID(), crypto.randomUUID()];

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg17")
      .withEnvironment({ POSTGRES_INITDB_ARGS: "--locale=C" })
      .start();
    const handle = createDb(container.getConnectionUri());
    db = handle.db;
    client = handle.client;

    // 1) Catena fino alla 0040 (widget_settings ancora presente).
    const folder = await migrationsFolderUpTo(41);
    await migrate(db, { migrationsFolder: folder });

    // 2) Semina un progetto con settings custom e una conversazione (stato pre-0041).
    projectId = await seedProject(db);
    await db.execute(sql`
      insert into "widget_settings"
        ("project_id", "enabled", "enabled_repository_ids", "title", "welcome_message", "accent_color", "language")
      values (
        ${projectId}, true, ${JSON.stringify(enabledRepositoryIds)}::jsonb,
        'Supporto X', 'Benvenuto!', '#ff0000', 'en'
      )
    `);
    const convRows = await db.execute<{ id: string }>(sql`
      insert into "widget_conversations" ("project_id", "external_user_id")
      values (${projectId}, 'u_1')
      returning "id"
    `);
    conversationId = convRows[0]!.id;

    // 3) Applica la 0041 sopra i dati seminati.
    await applyMigration0041(db);
  }, 120_000);

  afterAll(async () => {
    await client.end();
    await container.stop();
  });

  it("la riga widget_settings migra in widgets con config copiata fedelmente", async () => {
    const rows = await db.execute<{
      name: string;
      key: string;
      enabled: boolean;
      enabled_repository_ids: string[];
      title: string;
      welcome_message: string;
      accent_color: string;
      language: string;
    }>(sql`
      select "name", "key", "enabled", "enabled_repository_ids", "title",
             "welcome_message", "accent_color", "language"
      from "widgets" where "project_id" = ${projectId}
    `);
    expect(rows).toHaveLength(1);
    const w = rows[0]!;
    expect(w.name).toBe("Widget");
    expect(w.key).toMatch(/^[0-9a-f]{32}$/);
    expect(w.enabled).toBe(true);
    expect(w.enabled_repository_ids).toEqual(enabledRepositoryIds);
    expect(w.title).toBe("Supporto X");
    expect(w.welcome_message).toBe("Benvenuto!");
    expect(w.accent_color).toBe("#ff0000");
    expect(w.language).toBe("en");
  });

  it("le conversazioni esistenti puntano al widget derivato (widget_id valorizzato)", async () => {
    const widgetRows = await db.execute<{ id: string }>(sql`
      select "id" from "widgets" where "project_id" = ${projectId}
    `);
    const widgetId = widgetRows[0]!.id;

    const convRows = await db.execute<{ widget_id: string | null }>(sql`
      select "widget_id" from "widget_conversations" where "id" = ${conversationId}
    `);
    expect(convRows[0]!.widget_id).toBe(widgetId);
  });

  it("la vecchia tabella widget_settings è stata droppata", async () => {
    const rows = await db.execute<{ exists: boolean }>(sql`
      select exists (
        select 1 from information_schema.tables
        where table_schema = 'public' and table_name = 'widget_settings'
      ) as exists
    `);
    expect(rows[0]!.exists).toBe(false);
  });

  it("la key di widgets è unique", async () => {
    const keyRows = await db.execute<{ key: string }>(sql`
      select "key" from "widgets" where "project_id" = ${projectId}
    `);
    const key = keyRows[0]!.key;
    await expect(
      db.execute(sql`
        insert into "widgets" ("project_id", "name", "key")
        values (${projectId}, 'Dup', ${key})
      `),
    ).rejects.toThrow();
  });
});
