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
 * Verifica il backfill della migrazione 0096 (21 ott 2026): `agent_runs.operation`
 * dalla fase (e per il fix dal modello), `project_id` dal ticket del job o dal
 * repository della review, poi NOT NULL.
 *
 * Strategia (come migration-0095.test): catena FINO alla 0095, righe storiche
 * seminate con lo schema vecchio, poi lo SQL REALE della 0096 in una
 * transazione sola. Il test non copia nessuna espressione di backfill.
 */

const DRIZZLE_DIR = path.join(fileURLToPath(new URL("..", import.meta.url)), "drizzle");

async function migrationsFolderUpTo(stopBeforeIdx: number): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sw-mig96-"));
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

async function applyMigration0096(db: Db): Promise<void> {
  const raw = await readFile(path.join(DRIZZLE_DIR, "0096_ai_models_and_usage.sql"), "utf8");
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


describe("migrazione 0096: operazione e progetto dei run storici", () => {
  let container: StartedPostgreSqlContainer;
  let db: Db;
  let client: { end: () => Promise<unknown> };
  const ids: Record<string, string> = {};
  let projectId: string;

  async function insertRun(
    key: string,
    cols: { jobId?: string; prReviewId?: string; emailMessageId?: string },
    phase: string,
    model: string,
  ): Promise<void> {
    const rows = await db.execute<{ id: string }>(sql`
      insert into "agent_runs" ("job_id", "pr_review_id", "email_message_id", "phase", "model")
      values (${cols.jobId ?? null}, ${cols.prReviewId ?? null}, ${cols.emailMessageId ?? null},
              ${phase}::agent_run_phase, ${model})
      returning "id"
    `);
    ids[key] = rows[0]!.id;
  }

  async function runOf(key: string) {
    const rows = await db.execute<{ operation: string; project_id: string | null }>(sql`
      select "operation", "project_id" from "agent_runs" where "id" = ${ids[key]!}
    `);
    return rows[0]!;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg17")
      .withEnvironment({ POSTGRES_INITDB_ARGS: "--locale=C" })
      .start();
    const handle = createDb(container.getConnectionUri());
    db = handle.db;
    client = handle.client;
    await migrate(db, { migrationsFolder: await migrationsFolderUpTo(96) });

    // Tutto in SQL grezzo: il DB è fermo alla 0095, e gli helper Drizzle di
    // testing.ts nominano le colonne dello schema di OGGI (es. `projects.code`
    // della 0107, `users.display_name`), che qui non esistono ancora.
    const [account] = await db.execute<{ id: string }>(sql`
      insert into "git_accounts" ("name", "provider", "encrypted_credentials")
      values ('Account', 'github', 'blob') returning "id"
    `);
    const [project] = await db.execute<{ id: string }>(sql`
      insert into "projects" ("name", "slug", "ingestion_key")
      values ('Progetto', 'progetto-0096', 'chiave-0096') returning "id"
    `);
    const [repository] = await db.execute<{ id: string }>(sql`
      insert into "repositories" ("project_id", "name", "slug", "provider", "git_account_id", "repo_url", "default_branch")
      values (${project!.id}, 'Repo', 'repo-0096', 'github', ${account!.id}, 'https://example.com/repo.git', 'main')
      returning "id"
    `);
    const [ticket] = await db.execute<{ id: string }>(sql`
      insert into "tickets" ("project_id", "number", "title", "type", "priority", "source")
      values (${project!.id}, 1, 'Ticket', 'bug', 'medium', 'manual') returning "id"
    `);
    const seeded = { projectId: project!.id, repositoryId: repository!.id, ticketId: ticket!.id };
    projectId = seeded.projectId;
    const job = await db.execute<{ id: string }>(sql`
      insert into "ai_jobs" ("ticket_id") values (${seeded.ticketId}) returning "id"
    `);
    const jobId = job[0]!.id;
    const review = await db.execute<{ id: string }>(sql`
      insert into "pr_reviews" ("repository_id", "pr_number", "pr_url", "pr_title", "head_sha")
      values (${seeded.repositoryId}, 1, 'https://example.com/pr/1', 't', 'abc') returning "id"
    `);
    // L'utente a mano: `users` cresce dopo la 0096 (instance_role_id, 0097) e
    // l'insert di drizzle nominerebbe colonne che a questo punto non esistono.
    const owner = await db.execute<{ id: string }>(sql`
      insert into "users" ("email", "password_hash", "role")
      values ('owner@acme.test', 'x', 'member') returning "id"
    `);
    const [workspace] = await db.execute<{ id: string }>(sql`
      insert into "google_workspaces" ("name", "domains", "client_id", "client_secret_encrypted")
      values ('Acme', ARRAY['acme.test'], 'c', 'x') returning "id"
    `);
    const [googleAccount] = await db.execute<{ id: string }>(sql`
      insert into "google_accounts" ("user_id", "workspace_id", "email", "google_sub", "refresh_token_encrypted")
      values (${owner[0]!.id}, ${workspace!.id}, 'casella@acme.test', 'sub-0096', 'x') returning "id"
    `);
    const [message] = await db.execute<{ id: string }>(sql`
      insert into "email_messages" ("account_id", "gmail_message_id", "thread_id", "from_address", "received_at")
      values (${googleAccount!.id}, 'gm-0096', 'th-0096', 'cliente@acme.test', now()) returning "id"
    `);
    const messageId = message!.id;

    await insertRun("triage", { jobId }, "triage", "claude-haiku-5-5");
    await insertRun("fixOpus", { jobId }, "fix", "claude-opus-5-5");
    await insertRun("fixSonnet", { jobId }, "fix", "claude-sonnet-5-5");
    await insertRun("review", { prReviewId: review[0]!.id }, "review", "claude-sonnet-5-5");
    await insertRun("mail", { emailMessageId: messageId }, "email_classify", "claude-haiku-5-5");
    await applyMigration0096(db);
  }, 180_000);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it("triage -> triage, review -> pr_review, email_classify -> mail_classify", async () => {
    expect((await runOf("triage")).operation).toBe("triage");
    expect((await runOf("review")).operation).toBe("pr_review");
    expect((await runOf("mail")).operation).toBe("mail_classify");
  });

  it("fix si divide per modello: opus -> fix_plan, il resto -> fix_execute", async () => {
    expect((await runOf("fixOpus")).operation).toBe("fix_plan");
    expect((await runOf("fixSonnet")).operation).toBe("fix_execute");
  });

  it("project_id: dal ticket del job e dal repository della review, null per la posta", async () => {
    expect((await runOf("triage")).project_id).toBe(projectId);
    expect((await runOf("fixOpus")).project_id).toBe(projectId);
    expect((await runOf("review")).project_id).toBe(projectId);
    expect((await runOf("mail")).project_id).toBeNull();
  });

  it("operation è NOT NULL dopo la migrazione", async () => {
    await expect(
      db.execute(sql`insert into "agent_runs" ("model") values ('m')`),
    ).rejects.toThrow();
  });
});
