import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client.js";
import { expectSqlState } from "./testing.js";

/**
 * Migrazione 0170 (13 nov 2026, area 7, fetta 2): email e attese. Catena fino
 * alla 0169 con i dati della F1 (un'automazione, un'esecuzione dovuta, un
 * invio di una persona, un evento), poi il migratore vero sulla cartella
 * intera: è il caso di un DB vivo, dove gli enum esistono già e un valore
 * aggiunto non si può usare nella stessa transazione.
 */

const DRIZZLE_DIR = path.join(fileURLToPath(new URL("..", import.meta.url)), "drizzle");

async function migrationsFolderUpTo(stopBeforeIdx: number): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sw-mig170-"));
  await cp(DRIZZLE_DIR, dir, { recursive: true });
  const journalPath = path.join(dir, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: { idx: number; tag: string }[] };
  const dropped = journal.entries.filter((e) => e.idx >= stopBeforeIdx);
  journal.entries = journal.entries.filter((e) => e.idx < stopBeforeIdx);
  await writeFile(journalPath, JSON.stringify(journal, null, 2));
  await Promise.all(dropped.map((e) => rm(path.join(dir, `${e.tag}.sql`), { force: true })));
  return dir;
}

describe("migrazione 0170: email e attese, su un DB con i dati della F1", () => {
  let container: StartedPostgreSqlContainer;
  let db: Db;
  let client: { end: () => Promise<unknown> };
  const ids = { project: randomUUID(), automation: randomUUID(), run: randomUUID(), user: randomUUID(), account: randomUUID(), outgoing: randomUUID() };

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg17").withEnvironment({ POSTGRES_INITDB_ARGS: "--locale=C" }).start();
    const handle = createDb(container.getConnectionUri());
    db = handle.db;
    client = handle.client;
    await migrate(db, { migrationsFolder: await migrationsFolderUpTo(170) });
    // I dati della F1.
    await db.execute(sql`insert into "projects" ("id", "name", "slug", "ingestion_key", "code") values (${ids.project}, 'P', 'p', ${randomUUID()}, 'PRJ')`);
    await db.execute(sql`insert into "users" ("id", "email", "password_hash") values (${ids.user}, 'u@acme.com', 'x')`);
    await db.execute(sql`insert into "automations" ("id", "code", "seq", "name", "project_id", "owner_id", "status", "active_since") values (${ids.automation}, 'PRJ-A1', 1, 'A', ${ids.project}, ${ids.user}, 'active', now())`);
    await db.execute(sql`insert into "automation_runs" ("id", "automation_id", "n", "version", "title", "origin", "status", "due_at") values (${ids.run}, ${ids.automation}, 1, 1, 'R', 'manual', 'running', now())`);
    const [ws] = await db.execute<{ id: string }>(sql`insert into "google_workspaces" ("name", "domains", "client_id", "client_secret_encrypted") values ('W', '{acme.com}', 'c', 's') returning "id"`);
    await db.execute(sql`insert into "google_accounts" ("id", "user_id", "workspace_id", "email", "google_sub", "refresh_token_encrypted") values (${ids.account}, ${ids.user}, ${ws!.id}, 'u@acme.com', ${randomUUID()}, 'r')`);
    await db.execute(sql`insert into "mail_outgoing" ("id", "user_id", "account_id", "gmail_draft_id", "send_at") values (${ids.outgoing}, ${ids.user}, ${ids.account}, 'gd-1', now())`);
    await db.execute(sql`insert into "tickets" ("project_id", "number", "title", "type", "priority", "source") values (${ids.project}, 1, 'T', 'task', 'medium', 'manual')`);
    // Il migratore vero, sulla cartella intera: applica la 0170 a un DB vivo.
    await migrate(db, { migrationsFolder: DRIZZLE_DIR });
  }, 180_000);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it("i dati della F1 restano; i valori d'enum nuovi si usano dopo il batch", async () => {
    const [run] = await db.execute<{ status: string }>(sql`select "status" from "automation_runs" where "id" = ${ids.run}`);
    expect(run!.status).toBe("running");
    const [out] = await db.execute<{ gmail_draft_id: string; automation_run_id: string | null }>(sql`select "gmail_draft_id", "automation_run_id" from "mail_outgoing" where "id" = ${ids.outgoing}`);
    expect(out).toEqual({ gmail_draft_id: "gd-1", automation_run_id: null });
    const [events] = await db.execute<{ n: number }>(sql`select count(*)::int as n from "automation_events"`);
    expect(events!.n).toBe(1); // la task della F1: il trigger c'era già
    await db.execute(sql`update "automation_runs" set "status" = 'waiting_event', "waiting_thread" = ${`${ids.account}:th-1`} where "id" = ${ids.run}`);
    await db.execute(sql`update "automations" set "status" = 'paused', "paused_reason" = 'mailbox_lost', "mailbox_account_id" = ${ids.account} where "id" = ${ids.automation}`);
    await db.execute(sql`insert into "automation_effects" ("run_id", "path", "idempotency_key", "kind", "object_id") values (${ids.run}, '0', ${`${ids.run}:0:0`}, 'email', ${ids.outgoing})`);
  });

  it("un invio senza bozza è solo di un'esecuzione (C-F2-1)", async () => {
    await expectSqlState(db.execute(sql`insert into "mail_outgoing" ("user_id", "account_id", "send_at") values (${ids.user}, ${ids.account}, now())`), "23514");
    await db.execute(sql`insert into "mail_outgoing" ("user_id", "account_id", "send_at", "automation_run_id", "gmail_thread_id") values (${ids.user}, ${ids.account}, now(), ${ids.run}, 'th-1')`);
  });

  it("un evento della posta: senza progetto ma con la casella, deduplicato (C-F2-0)", async () => {
    const insert = (key: string, account: string | null) =>
      db.execute(sql`insert into "automation_events" ("kind", "account_id", "dedupe_key", "payload") values ('mail_received', ${account}, ${key}, '{}'::jsonb)`);
    await insert(`mail:${ids.account}:m1`, ids.account);
    await expectSqlState(insert(`mail:${ids.account}:m1`, ids.account), "23505");
    await expectSqlState(insert(`mail:${ids.account}:m2`, null), "23514");
  });

  it("un inizio a orario scatta una volta per giorno (vincolo, non convenzione)", async () => {
    await db.execute(sql`insert into "automation_schedule_fires" ("automation_id", "local_date") values (${ids.automation}, '2026-11-13')`);
    await expectSqlState(db.execute(sql`insert into "automation_schedule_fires" ("automation_id", "local_date") values (${ids.automation}, '2026-11-13')`), "23505");
    await db.execute(sql`insert into "automation_schedule_fires" ("automation_id", "local_date") values (${ids.automation}, '2026-11-14')`);
  });

  it("una casella scollegata lascia l'automazione senza casella, e i suoi eventi in attesa se ne vanno", async () => {
    await db.execute(sql`update "automations" set "mailbox_account_id" = ${ids.account} where "id" = ${ids.automation}`);
    await db.execute(sql`delete from "mail_outgoing" where "account_id" = ${ids.account}`);
    await db.execute(sql`delete from "google_accounts" where "id" = ${ids.account}`);
    const [a] = await db.execute<{ mailbox_account_id: string | null }>(sql`select "mailbox_account_id" from "automations" where "id" = ${ids.automation}`);
    expect(a!.mailbox_account_id).toBeNull();
    const [events] = await db.execute<{ n: number }>(sql`select count(*)::int as n from "automation_events" where "kind" = 'mail_received'`);
    expect(events!.n).toBe(0);
  });
});
