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
 * Verifica la migrazione 0081 (ciclo di correzione post-PR) sui suoi due
 * pezzi NON cosmetici. Il BACKFILL di `ticket_repositories.pr_number`: la
 * derivazione dello stato del ciclo (`derivePrCycle`) e la coda delle
 * correzioni cercano la PR per `(repository_id, pr_number)`, e una riga
 * storica rimasta NULL sarebbe una PR di Stubwise che non mostra mai il suo
 * ciclo. E il BACKFILL di `pr_reviews.started_at`: ogni review storica deve
 * risultare PARTITA, o il recovery (solo sulle partite) e il riaccodamento
 * all'avvio (solo sulle in attesa) la tratterebbero come una review mai
 * cominciata.
 *
 * Strategia (come migration-0074.test): catena FINO alla 0080, semina delle
 * righe con URL dei due provider (più un NULL e un formato sconosciuto), poi
 * lo SQL reale della 0081 in una transazione sola, come il migratore.
 */

const DRIZZLE_DIR = path.join(fileURLToPath(new URL("..", import.meta.url)), "drizzle");

async function migrationsFolderUpTo(stopBeforeIdx: number): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sw-mig81-"));
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

async function applyMigration0081(db: Db): Promise<void> {
  const raw = await readFile(path.join(DRIZZLE_DIR, "0081_pr_corrections.sql"), "utf8");
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

describe("migrazione 0081: correzioni post-PR", () => {
  let container: StartedPostgreSqlContainer;
  let db: Db;
  let client: { end: () => Promise<unknown> };

  let projectId: string;
  let repositoryId: string;
  /** ticket_repositories.id per URL seminato. */
  const rowIds: Record<
    "github" | "bitbucket" | "senzaPr" | "sconosciuto" | "githubFrammento" | "bitbucketQuery" | "nonNumerico",
    string
  > = {
    github: "",
    bitbucket: "",
    senzaPr: "",
    sconosciuto: "",
    githubFrammento: "",
    bitbucketQuery: "",
    nonNumerico: "",
  };
  /** pr_reviews storiche, una per stato, seminate PRIMA della 0081. */
  const reviewIds: Record<"running" | "completed" | "failed", string> = {
    running: "",
    completed: "",
    failed: "",
  };

  async function seedTicketRepo(n: number, prUrl: string | null): Promise<string> {
    const tickets = await db.execute<{ id: string }>(sql`
      insert into "tickets" ("project_id", "number", "title", "type", "priority", "source")
      values (${projectId}, ${n}, ${"T" + n}, 'bug', 'medium', 'manual')
      returning "id"
    `);
    const rows = await db.execute<{ id: string }>(sql`
      insert into "ticket_repositories" ("ticket_id", "repository_id", "branch", "pr_url")
      values (${tickets[0]!.id}, ${repositoryId}, ${"stubwise/ticket-" + n}, ${prUrl})
      returning "id"
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

    // 1) Catena fino alla 0080 (ticket_repositories ancora senza pr_number).
    await migrate(db, { migrationsFolder: await migrationsFolderUpTo(81) });

    // 2) Stato pre-0081.
    const accounts = await db.execute<{ id: string }>(sql`
      insert into "git_accounts" ("name", "provider", "encrypted_credentials")
      values ('acc', 'github', 'enc') returning "id"
    `);
    const projects = await db.execute<{ id: string }>(sql`
      insert into "projects" ("name", "slug", "ingestion_key")
      values ('P', ${"p-" + crypto.randomUUID()}, ${crypto.randomUUID()}) returning "id"
    `);
    projectId = projects[0]!.id;
    const repos = await db.execute<{ id: string }>(sql`
      insert into "repositories"
        ("project_id", "name", "slug", "provider", "git_account_id", "repo_url", "default_branch")
      values (${projectId}, 'r', ${"r-" + crypto.randomUUID()}, 'github', ${accounts[0]!.id},
              'https://github.com/acme/r', 'main')
      returning "id"
    `);
    repositoryId = repos[0]!.id;

    rowIds.github = await seedTicketRepo(1, "https://github.com/acme/r/pull/10");
    rowIds.bitbucket = await seedTicketRepo(
      2,
      "https://bitbucket.org/thecove/trion-webapp/pull-requests/7",
    );
    rowIds.senzaPr = await seedTicketRepo(3, null);
    rowIds.sconosciuto = await seedTicketRepo(4, "https://example.com/qualcosa/42");
    rowIds.githubFrammento = await seedTicketRepo(
      5,
      "https://github.com/acme/r/pull/42#issuecomment-1",
    );
    rowIds.bitbucketQuery = await seedTicketRepo(
      6,
      "https://bitbucket.org/thecove/trion-webapp/pull-requests/7?at=x",
    );
    rowIds.nonNumerico = await seedTicketRepo(7, "https://github.com/acme/r/pull/abc");

    // Review storiche (una per stato, `running` compresa: una review in volo
    // al deploy), con `created_at` nel passato così il backfill si distingue
    // da un `now()`.
    for (const status of ["running", "completed", "failed"] as const) {
      const rows = await db.execute<{ id: string }>(sql`
        insert into "pr_reviews"
          ("repository_id", "pr_number", "pr_url", "pr_title", "head_sha", "status", "created_at")
        values (${repositoryId}, 10, 'https://github.com/acme/r/pull/10', 'PR', ${"a".repeat(40)},
                ${status}, now() - interval '3 days')
        returning "id"
      `);
      reviewIds[status] = rows[0]!.id;
    }

    // 3) La 0081 sopra i dati seminati.
    await applyMigration0081(db);
  }, 120_000);

  afterAll(async () => {
    await client.end();
    await container.stop();
  });

  async function prNumberOf(id: string): Promise<number | null> {
    const rows = await db.execute<{ pr_number: number | null }>(sql`
      select "pr_number" from "ticket_repositories" where "id" = ${id}
    `);
    return rows[0]!.pr_number;
  }

  it("backfill: GitHub `/pull/N` e Bitbucket `/pull-requests/N` diventano pr_number", async () => {
    expect(await prNumberOf(rowIds.github)).toBe(10);
    expect(await prNumberOf(rowIds.bitbucket)).toBe(7);
  });

  it("backfill: frammento e query dopo il numero non lo alterano", async () => {
    expect(await prNumberOf(rowIds.githubFrammento)).toBe(42);
    expect(await prNumberOf(rowIds.bitbucketQuery)).toBe(7);
  });

  it("backfill: nessuna PR o URL non riconosciuto → pr_number resta NULL (mai un numero inventato)", async () => {
    expect(await prNumberOf(rowIds.senzaPr)).toBeNull();
    expect(await prNumberOf(rowIds.sconosciuto)).toBeNull();
    expect(await prNumberOf(rowIds.nonNumerico)).toBeNull();
  });

  it("projects.pr_correction_max_rounds nasce a 3 sulle righe esistenti", async () => {
    const rows = await db.execute<{ pr_correction_max_rounds: number }>(sql`
      select "pr_correction_max_rounds" from "projects" where "id" = ${projectId}
    `);
    expect(rows[0]!.pr_correction_max_rounds).toBe(3);
  });

  it("il CHECK del tetto rifiuta 11 e accetta 0 (0 = ciclo automatico spento)", async () => {
    await expect(
      db.execute(sql`update "projects" set "pr_correction_max_rounds" = 11 where "id" = ${projectId}`),
    ).rejects.toThrow();
    await db.execute(sql`update "projects" set "pr_correction_max_rounds" = 0 where "id" = ${projectId}`);
  });

  it("il CHECK revisore ≠ principale: un UPDATE diretto che li rende uguali fallisce con 23514", async () => {
    const accounts = await db.execute<{ id: string }>(sql`
      select "git_account_id" as "id" from "repositories" where "id" = ${repositoryId}
    `);
    const mainId = accounts[0]!.id;
    await expectSqlState(
      db.execute(sql`update "repositories" set "review_git_account_id" = ${mainId} where "id" = ${repositoryId}`),
      "23514",
    );
    // Un revisore diverso, e poi nessuno, passano.
    const other = await db.execute<{ id: string }>(sql`
      insert into "git_accounts" ("name", "provider", "encrypted_credentials")
      values ('revisore', 'github', 'enc') returning "id"
    `);
    await db.execute(
      sql`update "repositories" set "review_git_account_id" = ${other[0]!.id} where "id" = ${repositoryId}`,
    );
    // Promuovere il revisore a principale senza toglierlo: rifiutato anche così.
    await expectSqlState(
      db.execute(sql`update "repositories" set "git_account_id" = ${other[0]!.id} where "id" = ${repositoryId}`),
      "23514",
    );
    await db.execute(sql`update "repositories" set "review_git_account_id" = null where "id" = ${repositoryId}`);
  });

  it("le colonne nuove esistono, nullable, sulle tabelle preesistenti", async () => {
    const rows = await db.execute<{ table_name: string; column_name: string; is_nullable: string }>(sql`
      select "table_name", "column_name", "is_nullable" from information_schema.columns
      where ("table_name", "column_name") in (
        ('ai_jobs', 'correction_id'),
        ('repositories', 'review_git_account_id'),
        ('git_accounts', 'provider_user_id'),
        ('ticket_repositories', 'pr_number'),
        ('pr_reviews', 'started_at'),
        ('pr_reviews', 'pr_body'),
        ('pr_reviews', 'source_branch'),
        ('pr_reviews', 'target_branch')
      )
      order by "table_name"
    `);
    expect(rows).toHaveLength(8);
    for (const row of rows) expect(row.is_nullable).toBe("YES");
  });

  it("pr_corrections.feedback_complete nasce false, NOT NULL (una fotografia non letta non fa da taglio)", async () => {
    const rows = await db.execute<{ is_nullable: string; column_default: string | null }>(sql`
      select "is_nullable", "column_default" from information_schema.columns
      where "table_name" = 'pr_corrections' and "column_name" = 'feedback_complete'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.is_nullable).toBe("NO");
    expect(rows[0]!.column_default).toBe("false");
  });

  it("backfill: ogni pr_reviews storica risulta PARTITA (started_at = created_at), running compresa", async () => {
    // Senza, il recovery delle review stantie (solo le partite) non chiuderebbe
    // più una running orfana del worker vecchio, e l'avvio del worker nuovo la
    // scambierebbe per una in attesa: la riaccoderebbe e la cancellerebbe.
    const rows = await db.execute<{ id: string; started_at: Date | null; created_at: Date }>(sql`
      select "id", "started_at", "created_at" from "pr_reviews"
    `);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.started_at).not.toBeNull();
      expect(new Date(row.started_at!).getTime()).toBe(new Date(row.created_at).getTime());
    }
    const inAttesa = await db.execute<{ n: number }>(sql`
      select count(*)::int as "n" from "pr_reviews" where "started_at" is null
    `);
    expect(inAttesa[0]!.n).toBe(0);
    expect(rows.map((r) => r.id).sort()).toEqual(Object.values(reviewIds).sort());
  });

  it("una pr_reviews nuova nasce IN ATTESA (started_at null, metadati del job salvabili)", async () => {
    const rows = await db.execute<{ started_at: Date | null; source_branch: string | null }>(sql`
      insert into "pr_reviews"
        ("repository_id", "pr_number", "pr_url", "pr_title", "head_sha",
         "pr_body", "source_branch", "target_branch")
      values (${repositoryId}, 11, 'https://github.com/acme/r/pull/11', 'PR', ${"b".repeat(40)},
              '', 'stubwise/ticket-1', 'main')
      returning "started_at", "source_branch"
    `);
    expect(rows[0]!.started_at).toBeNull();
    expect(rows[0]!.source_branch).toBe("stubwise/ticket-1");
  });
});
