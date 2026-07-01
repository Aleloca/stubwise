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
 * Verifica la migrazione 0035 (fix multi-repo) su stati di dati NON 1:1 che il
 * codice di Fase 1 già permette e che il resto della suite non esercita (la
 * suite normale applica l'INTERA catena su un DB vuoto, senza dati pre-0035).
 *
 * Strategia: si applica la catena FINO alla 0034 (cartella migrazioni temporanea
 * con la voce 0035 rimossa dal journal), si seminano righe nello stato pre-0035
 * (progetto multi-repo, progetto senza repo, progetto 1:1) e SOLO DOPO si applica
 * la 0035 eseguendo il suo SQL reale. Così si prova che la migrazione:
 *  - sceglie in modo DETERMINISTICO la ingestion_key (repo più vecchio) per i
 *    progetti multi-repo, tenendone UNA sola;
 *  - GENERA una ingestion_key non-NULL e unica per i progetti SENZA repo, così
 *    il SET NOT NULL non fallisce (altrimenti il server non partirebbe);
 *  - preserva il caso 1:1 (chiave e numerazione migrate identiche).
 */

const DRIZZLE_DIR = path.join(fileURLToPath(new URL("..", import.meta.url)), "drizzle");

/**
 * Copia la cartella `drizzle/` in una temporanea e ne rimuove la voce di journal
 * (e il file .sql) delle migrazioni con idx >= `stopBeforeIdx`, così `migrate`
 * si ferma appena prima di quella soglia. Restituisce il percorso temporaneo.
 */
async function migrationsFolderUpTo(stopBeforeIdx: number): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sw-mig-"));
  await cp(DRIZZLE_DIR, dir, { recursive: true });
  const journalPath = path.join(dir, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
    entries: { idx: number; tag: string }[];
  };
  const dropped = journal.entries.filter((e) => e.idx >= stopBeforeIdx);
  journal.entries = journal.entries.filter((e) => e.idx < stopBeforeIdx);
  await writeFile(journalPath, JSON.stringify(journal, null, 2));
  await Promise.all(
    dropped.map((e) => rm(path.join(dir, `${e.tag}.sql`), { force: true })),
  );
  return dir;
}

/** Esegue ogni statement del file 0035 (separati da `--> statement-breakpoint`). */
async function applyMigration0035(db: Db): Promise<void> {
  const raw = await readFile(path.join(DRIZZLE_DIR, "0035_multi_repo_fix.sql"), "utf8");
  const statements = raw
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    await db.execute(sql.raw(stmt));
  }
}

async function seedGitAccount(db: Db): Promise<string> {
  const rows = await db.execute<{ id: string }>(sql`
    insert into "git_accounts" ("name", "provider", "encrypted_credentials")
    values (${"acct-" + crypto.randomUUID()}, 'github', 'blob')
    returning "id"
  `);
  return rows[0]!.id;
}

async function seedProject(db: Db): Promise<string> {
  const rows = await db.execute<{ id: string }>(sql`
    insert into "projects" ("name", "slug")
    values ('P', ${"proj-" + crypto.randomUUID()})
    returning "id"
  `);
  return rows[0]!.id;
}

/**
 * Semina un repository pre-0035 (con `ingestion_key`/`next_ticket_number`, colonne
 * che la 0035 rimuove). `createdAt`/`id` sono impostabili per pilotare l'ordine
 * "repo più vecchio" e verificare il tie-breaker deterministico.
 */
async function seedRepo(
  db: Db,
  opts: {
    projectId: string;
    gitAccountId: string;
    ingestionKey: string;
    nextTicketNumber?: number;
    createdAt?: string;
    id?: string;
  },
): Promise<void> {
  await db.execute(sql`
    insert into "repositories" (
      ${sql.raw(opts.id ? '"id",' : "")}
      "project_id", "name", "slug", "provider", "git_account_id",
      "repo_url", "default_branch", "ingestion_key", "next_ticket_number"
      ${sql.raw(opts.createdAt ? ', "created_at"' : "")}
    ) values (
      ${sql.raw(opts.id ? `'${opts.id}',` : "")}
      ${opts.projectId}, 'R', ${"repo-" + crypto.randomUUID()}, 'github', ${opts.gitAccountId},
      'https://example.com/r.git', 'main', ${opts.ingestionKey}, ${opts.nextTicketNumber ?? 1}
      ${sql.raw(opts.createdAt ? `, '${opts.createdAt}'` : "")}
    )
  `);
}

describe("migrazione 0035: cardinalità progetto↔repo non-1:1", () => {
  let container: StartedPostgreSqlContainer;
  let db: Db;
  let client: { end: () => Promise<unknown> };

  // ID e chiavi dei tre scenari, per asserire dopo la migrazione.
  let multiRepoProjectId: string;
  let noRepoProjectId: string;
  let oneToOneProjectId: string;
  const oldestKey = "aaaa0000oldestrepokey00000000hex";
  const newerKey = "bbbb1111newerrepokey000000000hex";
  const oneToOneKey = "cccc2222onetoonekey0000000000hex";

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg17")
      .withEnvironment({ POSTGRES_INITDB_ARGS: "--locale=C" })
      .start();
    const handle = createDb(container.getConnectionUri());
    db = handle.db;
    client = handle.client;

    // 1) Catena fino alla 0034 (stato pre-0035).
    const folder = await migrationsFolderUpTo(35);
    await migrate(db, { migrationsFolder: folder });

    // 2) Semina lo stato non-1:1.
    const gitAccountId = await seedGitAccount(db);

    // Progetto MULTI-repo: due repo, chiavi diverse; il più vecchio ha `oldestKey`.
    // Il tie-breaker temporale (created_at) è esplicito qui; l'id resta il fallback.
    multiRepoProjectId = await seedProject(db);
    await seedRepo(db, {
      projectId: multiRepoProjectId,
      gitAccountId,
      ingestionKey: oldestKey,
      nextTicketNumber: 7,
      createdAt: "2024-01-01T00:00:00Z",
    });
    await seedRepo(db, {
      projectId: multiRepoProjectId,
      gitAccountId,
      ingestionKey: newerKey,
      nextTicketNumber: 3,
      createdAt: "2024-06-01T00:00:00Z",
    });

    // Progetto SENZA repo (POST /api/projects crea progetti vuoti).
    noRepoProjectId = await seedProject(db);

    // Progetto 1:1 (caso odierno): un solo repo.
    oneToOneProjectId = await seedProject(db);
    await seedRepo(db, {
      projectId: oneToOneProjectId,
      gitAccountId,
      ingestionKey: oneToOneKey,
      nextTicketNumber: 5,
    });

    // 3) Applica la 0035 sopra lo stato seminato.
    await applyMigration0035(db);
  }, 120_000);

  afterAll(async () => {
    await client.end();
    await container.stop();
  });

  async function projectRow(id: string) {
    const rows = await db.execute<{ ingestion_key: string; next_ticket_number: number }>(sql`
      select "ingestion_key", "next_ticket_number" from "projects" where "id" = ${id}
    `);
    return rows[0]!;
  }

  it("multi-repo: eredita la ingestion_key del repo più VECCHIO (deterministico)", async () => {
    const row = await projectRow(multiRepoProjectId);
    expect(row.ingestion_key).toBe(oldestKey);
    // Il progetto ha UNA sola chiave (quella del newer repo è stata abbandonata).
    expect(row.ingestion_key).not.toBe(newerKey);
    // next_ticket_number = MAX dei contatori dei repo (7, non 3).
    expect(row.next_ticket_number).toBe(7);
  });

  it("senza repo: genera una ingestion_key non-NULL nel formato dell'app (32 hex)", async () => {
    const row = await projectRow(noRepoProjectId);
    expect(row.ingestion_key).toMatch(/^[0-9a-f]{32}$/);
    // next_ticket_number resta il DEFAULT 1 (nessun ticket ancora).
    expect(row.next_ticket_number).toBe(1);
  });

  it("senza repo: la ingestion_key generata è UNICA (non collide con le migrate)", async () => {
    const row = await projectRow(noRepoProjectId);
    expect(row.ingestion_key).not.toBe(oldestKey);
    expect(row.ingestion_key).not.toBe(oneToOneKey);
    // La constraint unique è attiva: nessuna chiave duplicata su tutta la tabella.
    const dupes = await db.execute<{ ingestion_key: string; c: number }>(sql`
      select "ingestion_key", count(*)::int as c
      from "projects" group by "ingestion_key" having count(*) > 1
    `);
    expect(dupes).toHaveLength(0);
  });

  it("1:1: chiave e numerazione migrate identiche (nessuna regressione)", async () => {
    const row = await projectRow(oneToOneProjectId);
    expect(row.ingestion_key).toBe(oneToOneKey);
    expect(row.next_ticket_number).toBe(5);
  });

  it("dopo la 0035 ogni progetto ha una ingestion_key non-NULL (SET NOT NULL ok)", async () => {
    const nulls = await db.execute<{ c: number }>(sql`
      select count(*)::int as c from "projects" where "ingestion_key" is null
    `);
    expect(nulls[0]!.c).toBe(0);
  });
});
