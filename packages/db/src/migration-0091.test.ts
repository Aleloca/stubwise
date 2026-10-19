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
 * Verifica la migrazione 0091 (piano `docs/plans/2026-10-19-backlog-solo-sessioni.md`):
 * dismissione di chat della voce, sessione di analisi, domande a bottoni e deep
 * dive. Cancella i job `deep_dive`/`chat_turn` (anche in coda o in corso),
 * ripulisce le sessioni il cui segmento attivo era di quel tipo, chiude gli
 * interventi rimasti `pending` sulle sessioni `backlog_item`, DROPpa le tre
 * tabelle e `backlog_code_session_status`, e ricrea `backlog_job_kind` coi soli
 * `intake`, `estimate`.
 *
 * Strategia (come migration-0085.test): catena FINO alla 0090, semina righe di
 * ogni tipo toccato, poi lo SQL reale della 0091 in una transazione sola, come
 * il migratore.
 */

const DRIZZLE_DIR = path.join(fileURLToPath(new URL("..", import.meta.url)), "drizzle");

async function migrationsFolderUpTo(stopBeforeIdx: number): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sw-mig91-"));
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

async function applyMigration0091(db: Db): Promise<void> {
  const raw = await readFile(path.join(DRIZZLE_DIR, "0091_backlog_solo_sessioni.sql"), "utf8");
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

describe("migrazione 0091: backlog solo sessioni di refinement", () => {
  let container: StartedPostgreSqlContainer;
  let db: Db;
  let client: { end: () => Promise<unknown> };
  /** Job seminati PRIMA della 0091, per kind e stato. */
  const jobs: Record<string, string> = {};
  let itemId: string;
  /** Sessione `backlog_item` col segmento attivo `deep_dive`. */
  let deepDiveSession: string;
  /** Sessione `backlog_item` col segmento attivo `chat_turn`. */
  let chatTurnSession: string;
  /** Sessione di refinement viva: non va toccata. */
  let refineSession: string;
  /** Interventi `pending`: uno su `backlog_item` (chiuso), uno su `backlog_refine` (resta). */
  let backlogInput: string;
  let refineInput: string;

  async function insertJob(kind: string, status: string, payload: object): Promise<string> {
    const rows = await db.execute<{ id: string }>(sql`
      insert into "backlog_jobs" ("project_id", "kind", "status", "payload")
      select "project_id", ${kind}::backlog_job_kind, ${status}::backlog_job_status, ${JSON.stringify(payload)}::jsonb
      from "backlog_items" where "id" = ${itemId}
      returning "id"
    `);
    return rows[0]!.id;
  }

  async function insertSession(
    ownerKey: string,
    kind: string,
    label: string,
    opts: { backlogJobId?: string } = {},
  ): Promise<string> {
    const rows = await db.execute<{ id: string }>(sql`
      insert into "agent_sessions"
        ("owner_key", "kind", "title", "backlog_item_id", "backlog_job_id",
         "active_segment_id", "active_segment_label", "active_segment_interactive", "live_segment_ids")
      values (${ownerKey}, ${kind}, 't', ${itemId}, ${opts.backlogJobId ?? null},
              'seg-1', ${label}, true, '{seg-1}')
      returning "id"
    `);
    return rows[0]!.id;
  }

  async function insertInput(sessionId: string): Promise<string> {
    const rows = await db.execute<{ id: string }>(sql`
      insert into "agent_session_inputs" ("session_id", "text") values (${sessionId}, 'guarda X') returning "id"
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

    await migrate(db, { migrationsFolder: await migrationsFolderUpTo(91) });

    const accounts = await db.execute<{ id: string }>(sql`
      insert into "git_accounts" ("name", "provider", "encrypted_credentials")
      values ('acc', 'github', 'enc') returning "id"
    `);
    const projects = await db.execute<{ id: string }>(sql`
      insert into "projects" ("name", "slug", "ingestion_key")
      values ('P', ${"p-" + crypto.randomUUID()}, ${crypto.randomUUID()}) returning "id"
    `);
    const projectId = projects[0]!.id;
    const repos = await db.execute<{ id: string }>(sql`
      insert into "repositories"
        ("project_id", "name", "slug", "provider", "git_account_id", "repo_url", "default_branch")
      values (${projectId}, 'r', ${"r-" + crypto.randomUUID()}, 'github', ${accounts[0]!.id},
              'https://github.com/acme/r', 'main')
      returning "id"
    `);
    const repositoryId = repos[0]!.id;
    const items = await db.execute<{ id: string }>(sql`
      insert into "backlog_items" ("project_id", "title", "source")
      values (${projectId}, 'Voce', 'manual') returning "id"
    `);
    itemId = items[0]!.id;

    // Le tre tabelle dismesse, con almeno una riga ciascuna.
    await db.execute(sql`
      insert into "backlog_chat_messages" ("item_id", "role", "content") values (${itemId}, 'user', 'ciao')
    `);
    const codeSessions = await db.execute<{ id: string }>(sql`
      insert into "backlog_code_sessions" ("item_id", "repository_id") values (${itemId}, ${repositoryId})
      returning "id"
    `);
    await db.execute(sql`
      insert into "backlog_questions" ("backlog_item_id", "question", "options")
      values (${itemId}, 'Quale?', '[{"label":"A"},{"label":"B"}]'::jsonb)
    `);

    // Job di ogni kind; quelli dismessi anche in coda e in corso.
    jobs.intake = await insertJob("intake", "done", { title: "t", body: "b" });
    jobs.estimate = await insertJob("estimate", "queued", { itemId });
    jobs.deepDiveQueued = await insertJob("deep_dive", "queued", { itemId, repositoryId });
    jobs.deepDiveDone = await insertJob("deep_dive", "done", { itemId, repositoryId });
    jobs.chatTurnRunning = await insertJob("chat_turn", "running", {
      itemId,
      userMessageId: crypto.randomUUID(),
      sessionId: codeSessions[0]!.id,
    });

    deepDiveSession = await insertSession(`backlog_item:${itemId}`, "backlog_item", "deep_dive", {
      backlogJobId: jobs.deepDiveQueued,
    });
    chatTurnSession = await insertSession(`backlog_item:x:${itemId}`, "backlog_item", "chat_turn");
    refineSession = await insertSession(`backlog_refine:${itemId}`, "backlog_refine", "refine");
    backlogInput = await insertInput(chatTurnSession);
    refineInput = await insertInput(refineSession);

    await applyMigration0091(db);
  }, 180_000);

  afterAll(async () => {
    await client.end();
    await container.stop();
  });

  it("i job deep_dive e chat_turn spariscono in ogni stato; intake ed estimate restano", async () => {
    const rows = await db.execute<{ id: string; kind: string }>(sql`select "id", "kind"::text as kind from "backlog_jobs"`);
    expect(rows.map((r) => r.id).sort()).toEqual([jobs.intake, jobs.estimate].sort());
    expect(rows.map((r) => r.kind).sort()).toEqual(["estimate", "intake"]);
  });

  it("backlog_job_kind ha esattamente intake, estimate, in quest'ordine; il tipo vecchio non c'è più", async () => {
    const rows = await db.execute<{ typname: string; labels: string[] }>(sql`
      select t.typname, array_agg(e.enumlabel order by e.enumsortorder) as labels
      from pg_type t join pg_enum e on e.enumtypid = t.oid
      where t.typname in ('backlog_job_kind', 'backlog_job_kind_old', 'backlog_code_session_status')
      group by t.typname
    `);
    expect(rows).toEqual([{ typname: "backlog_job_kind", labels: ["intake", "estimate"] }]);
    await expect(
      db.execute(sql`
        insert into "backlog_jobs" ("project_id", "kind", "payload")
        select "project_id", 'deep_dive', '{}'::jsonb from "backlog_items" where "id" = ${itemId}
      `),
    ).rejects.toThrow();
  });

  it("le tabelle della chat, della sessione di analisi e delle domande non esistono più", async () => {
    const rows = await db.execute<{ t: string | null }>(sql`
      select to_regclass('public.backlog_chat_messages')::text as t
      union all select to_regclass('public.backlog_code_sessions')::text
      union all select to_regclass('public.backlog_questions')::text
    `);
    expect(rows.map((r) => r.t)).toEqual([null, null, null]);
  });

  it("le sessioni col segmento attivo dismesso restano, senza segmento attivo né vivo", async () => {
    const rows = await db.execute<{
      id: string;
      active_segment_id: string | null;
      active_segment_label: string | null;
      active_segment_interactive: boolean;
      live_segment_ids: string[];
      backlog_job_id: string | null;
    }>(sql`
      select "id", "active_segment_id", "active_segment_label", "active_segment_interactive",
             "live_segment_ids", "backlog_job_id"
      from "agent_sessions" where "id" in (${deepDiveSession}, ${chatTurnSession})
    `);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r).toMatchObject({
        active_segment_id: null,
        active_segment_label: null,
        active_segment_interactive: false,
        live_segment_ids: [],
        // Il job deep_dive cancellato: la FK è ON DELETE SET NULL.
        backlog_job_id: null,
      });
    }
  });

  it("la sessione di refinement non è toccata", async () => {
    const rows = await db.execute<{ active_segment_label: string; live_segment_ids: string[] }>(sql`
      select "active_segment_label", "live_segment_ids" from "agent_sessions" where "id" = ${refineSession}
    `);
    expect(rows[0]).toMatchObject({ active_segment_label: "refine", live_segment_ids: ["seg-1"] });
  });

  it("un intervento pending su backlog_item diventa undelivered; quello sul refinement resta pending", async () => {
    const rows = await db.execute<{ id: string; status: string; reason: string | null }>(sql`
      select "id", "status", "reason" from "agent_session_inputs" where "id" in (${backlogInput}, ${refineInput})
    `);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(backlogInput)).toMatchObject({ status: "undelivered", reason: "session_not_live" });
    expect(byId.get(refineInput)).toMatchObject({ status: "pending", reason: null });
  });
});
