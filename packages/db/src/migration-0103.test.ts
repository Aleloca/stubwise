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
 * Migrazione 0103 (23 ott 2026): i tre permessi `credentials.*` entrano nel
 * preset `project_lead` e in nessun altro ruolo. Catena fino alla 0102, poi
 * lo SQL reale della 0103 (come roles-migration.test).
 */

const DRIZZLE_DIR = path.join(fileURLToPath(new URL("..", import.meta.url)), "drizzle");
const CREDENTIALS = ["credentials.create", "credentials.edit", "credentials.share"];

async function migrationsFolderUpTo(stopBeforeIdx: number): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sw-mig103-"));
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

async function permsByPreset(db: Db): Promise<Map<string, string[]>> {
  const rows = await db.execute<{ preset_key: string; permissions: string[] }>(sql`
    select "preset_key", "permissions" from "roles" where "preset_key" is not null
  `);
  return new Map(rows.map((r) => [r.preset_key, [...r.permissions]]));
}

describe("migrazione 0103: permessi delle credenziali", () => {
  let container: StartedPostgreSqlContainer;
  let db: Db;
  let client: { end: () => Promise<unknown> };
  let before: Map<string, string[]>;
  let after: Map<string, string[]>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg17")
      .withEnvironment({ POSTGRES_INITDB_ARGS: "--locale=C" })
      .start();
    const handle = createDb(container.getConnectionUri());
    db = handle.db;
    client = handle.client;
    await migrate(db, { migrationsFolder: await migrationsFolderUpTo(103) });
    // Il maintainer aveva già modificato il preset: ne toglie un permesso e ne
    // aggiunge uno dei nuovi, per provare che non restino duplicati.
    await db.execute(sql`
      update "roles"
      set "permissions" = array_remove("permissions", 'docs.generate') || ARRAY['credentials.share']
      where "preset_key" = 'project_lead'
    `);
    before = await permsByPreset(db);
    const raw = await readFile(path.join(DRIZZLE_DIR, "0103_credentials_permissions.sql"), "utf8");
    const statements = raw
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    await db.transaction(async (tx) => {
      for (const stmt of statements) await tx.execute(sql.raw(stmt));
    });
    after = await permsByPreset(db);
  }, 180_000);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it("project_lead ha i tre permessi, senza duplicati, e conserva la modifica del maintainer", () => {
    const perms = after.get("project_lead")!;
    for (const p of CREDENTIALS) expect(perms.filter((x) => x === p)).toHaveLength(1);
    expect(new Set(perms).size).toBe(perms.length);
    expect(perms).not.toContain("docs.generate");
    expect(perms).toContain("plans.approve");
  });

  it("nessun altro ruolo cambia", () => {
    for (const [key, perms] of before) {
      if (key === "project_lead") continue;
      expect([...after.get(key)!].sort(), key).toEqual([...perms].sort());
    }
    for (const key of ["developer", "legacy_member", "viewer", "contributor"])
      for (const p of CREDENTIALS) expect(after.get(key)!, key).not.toContain(p);
  });
});
