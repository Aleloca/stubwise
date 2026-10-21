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
 * Verifica la migrazione 0095 (21 ott 2026): `personal_access_tokens.kind`,
 * il marcatore STRUTTURALE dei token dell'app mobile (`mobile`) rispetto a
 * quelli creati a mano (`manual`), con il backfill dei token esistenti dal
 * nome `Mobile · <device>` — l'unico segnale che c'era prima.
 *
 * Strategia (come migration-0094.test): catena FINO alla 0094, token seminati,
 * poi lo SQL reale della 0095 in una transazione sola.
 */

const DRIZZLE_DIR = path.join(fileURLToPath(new URL("..", import.meta.url)), "drizzle");

async function migrationsFolderUpTo(stopBeforeIdx: number): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sw-mig95-"));
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

async function applyMigration0095(db: Db): Promise<void> {
  const raw = await readFile(path.join(DRIZZLE_DIR, "0095_pat_kind.sql"), "utf8");
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

describe("migrazione 0095: tipo dei personal access token", () => {
  let container: StartedPostgreSqlContainer;
  let db: Db;
  let client: { end: () => Promise<unknown> };
  let userId: string;

  async function insertPat(name: string): Promise<string> {
    const rows = await db.execute<{ id: string }>(sql`
      insert into "personal_access_tokens" ("user_id", "name", "token_hash")
      values (${userId}, ${name}, ${crypto.randomUUID()}) returning "id"
    `);
    return rows[0]!.id;
  }
  async function kindOf(id: string): Promise<string> {
    const rows = await db.execute<{ kind: string }>(sql`
      select "kind" from "personal_access_tokens" where "id" = ${id}
    `);
    return rows[0]!.kind;
  }

  let mobileId: string;
  let manualId: string;
  let lookalikeId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg17")
      .withEnvironment({ POSTGRES_INITDB_ARGS: "--locale=C" })
      .start();
    const handle = createDb(container.getConnectionUri());
    db = handle.db;
    client = handle.client;
    await migrate(db, { migrationsFolder: await migrationsFolderUpTo(95) });
    const users = await db.execute<{ id: string }>(sql`
      insert into "users" ("email", "password_hash", "role")
      values ('u@x.it', 'h', 'member') returning "id"
    `);
    userId = users[0]!.id;
    mobileId = await insertPat("Mobile · iPhone di Bea");
    manualId = await insertPat("Claude Code");
    lookalikeId = await insertPat("Mobile app notes");
    await applyMigration0095(db);
  }, 180_000);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it("backfill: un token «Mobile · …» esistente diventa mobile", async () => {
    expect(await kindOf(mobileId)).toBe("mobile");
  });

  it("backfill: gli altri restano manual, anche se il nome inizia per «Mobile» senza il separatore", async () => {
    expect(await kindOf(manualId)).toBe("manual");
    expect(await kindOf(lookalikeId)).toBe("manual");
  });

  it("un token nuovo senza kind nasce manual", async () => {
    expect(await kindOf(await insertPat("nuovo"))).toBe("manual");
  });

  it("un kind sconosciuto viola il CHECK", async () => {
    await expect(
      db.execute(sql`
        insert into "personal_access_tokens" ("user_id", "name", "token_hash", "kind")
        values (${userId}, 'x', ${crypto.randomUUID()}, 'altro')
      `),
    ).rejects.toThrow();
  });
});
