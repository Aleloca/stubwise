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
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client.js";
import { expectSqlState } from "./testing.js";

/**
 * Verifica la migrazione 0082 (revisore predefinito, D1 del piano
 * `docs/plans/2026-10-01-default-reviewer-and-scopes.md`): la colonna
 * `git_accounts.is_default_reviewer` nasce `false` sulle righe esistenti, e
 * l'indice unico parziale ammette al più UN predefinito per AMBITO, dove
 * l'ambito è `(provider, workspace se Bitbucket altrimenti '')`. È la stessa
 * regola di `reviewScopeKey` (`@stubwise/notifications`): i casi qui sotto
 * sono quelli in cui le due devono dire la stessa cosa — in particolare su
 * GitHub il workspace NON conta (5) e su Bitbucket un workspace NULL vale
 * come '' (4).
 *
 * Strategia (come migration-0081.test): catena FINO alla 0081, semina di
 * account senza la colonna, poi lo SQL reale della 0082 in una transazione
 * sola, come il migratore.
 */

const DRIZZLE_DIR = path.join(fileURLToPath(new URL("..", import.meta.url)), "drizzle");

async function migrationsFolderUpTo(stopBeforeIdx: number): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sw-mig82-"));
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

async function applyMigration0082(db: Db): Promise<void> {
  const raw = await readFile(path.join(DRIZZLE_DIR, "0082_default_reviewer.sql"), "utf8");
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

describe("migrazione 0082: revisore predefinito", () => {
  let container: StartedPostgreSqlContainer;
  let db: Db;
  let client: { end: () => Promise<unknown> };
  /** Account seminati PRIMA della 0082 (la colonna non esiste ancora). */
  const preexisting: string[] = [];

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg17")
      .withEnvironment({ POSTGRES_INITDB_ARGS: "--locale=C" })
      .start();
    const handle = createDb(container.getConnectionUri());
    db = handle.db;
    client = handle.client;

    // 1) Catena fino alla 0081.
    await migrate(db, { migrationsFolder: await migrationsFolderUpTo(82) });

    // 2) Stato pre-0082: un account per provider.
    for (const [provider, workspace] of [
      ["github", null],
      ["bitbucket", "acme"],
    ] as const) {
      const rows = await db.execute<{ id: string }>(sql`
        insert into "git_accounts" ("name", "provider", "encrypted_credentials", "workspace")
        values (${"pre-" + provider}, ${provider}, 'enc', ${workspace}) returning "id"
      `);
      preexisting.push(rows[0]!.id);
    }

    // 3) La 0082 sopra i dati seminati.
    await applyMigration0082(db);
  }, 120_000);

  afterEach(async () => {
    // Ogni caso semina i suoi account: si tolgono, e restano quelli pre-0082.
    await db.execute(sql`delete from "git_accounts" where "name" like 't-%'`);
  });

  afterAll(async () => {
    await client.end();
    await container.stop();
  });

  function insertAccount(
    name: string,
    provider: "github" | "bitbucket",
    workspace: string | null,
    isDefault: boolean,
  ) {
    return db.execute(sql`
      insert into "git_accounts" ("name", "provider", "encrypted_credentials", "workspace", "is_default_reviewer")
      values (${"t-" + name}, ${provider}, 'enc', ${workspace}, ${isDefault})
    `);
  }

  it("le righe esistenti nascono con is_default_reviewer = false", async () => {
    // `to_jsonb` e non la colonna nuda: senza la 0082 la chiave manca (null)
    // e il caso fallisce sull'asserzione, non su un errore SQL.
    const rows = await db.execute<{ id: string; flag: unknown }>(sql`
      select g."id", to_jsonb(g) -> 'is_default_reviewer' as "flag"
      from "git_accounts" g where g."id" in (${preexisting[0]!}, ${preexisting[1]!})
    `);
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.flag).toBe(false);
  });

  it("due Bitbucket predefiniti nello STESSO workspace → 23505", async () => {
    await insertAccount("bb1", "bitbucket", "ws1", true);
    await expectSqlState(insertAccount("bb2", "bitbucket", "ws1", true), "23505");
  });

  it("due Bitbucket predefiniti in workspace DIVERSI → ok", async () => {
    await insertAccount("bb1", "bitbucket", "ws1", true);
    await insertAccount("bb2", "bitbucket", "ws2", true);
  });

  it("due Bitbucket predefiniti con workspace entrambi NULL → 23505 (COALESCE)", async () => {
    await insertAccount("bb1", "bitbucket", null, true);
    await expectSqlState(insertAccount("bb2", "bitbucket", null, true), "23505");
  });

  it("due GitHub predefiniti, workspace NULL e 'acme' → 23505: su GitHub il workspace non conta (D1)", async () => {
    await insertAccount("gh1", "github", null, true);
    await expectSqlState(insertAccount("gh2", "github", "acme", true), "23505");
  });

  it("un GitHub e un Bitbucket predefiniti → ok (provider diversi, ambiti diversi)", async () => {
    await insertAccount("gh1", "github", null, true);
    await insertAccount("bb1", "bitbucket", null, true);
  });

  it("due account NON predefiniti nello stesso ambito → ok (indice parziale)", async () => {
    await insertAccount("bb1", "bitbucket", "ws1", false);
    await insertAccount("bb2", "bitbucket", "ws1", false);
    await insertAccount("bb3", "bitbucket", "ws1", true);
    await insertAccount("gh1", "github", null, false);
    await insertAccount("gh2", "github", null, false);
  });
});
