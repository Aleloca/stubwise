import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client.js";
import { projectStatuses, tickets } from "./schema.js";
import { expectSqlState } from "./testing.js";
import { roleUpdate, statusIdForRole, ticketRoleIn, ticketStatusSql } from "./ticket-status.js";

/**
 * Migrazione 0245 (R3 del ritiro del web vecchio, il passo dei dati del blocco
 * T; `docs/plans/2026-11-28-ritiro-web-vecchio-piano.md` §1.1 e §1.2): via la
 * colonna enum `tickets.status`, il tipo `ticket_status`, e i due trigger che
 * lo leggevano. Un trigger solo, `tickets_state`, fa senza l'enum ciò che di
 * loro resta: `closed_at` dalla famiglia, lo stato di un ticket che cambia
 * progetto dal ruolo dello stato di prima, il segno dello smistamento.
 *
 * Catena fino alla 0244 con ticket «di prima» (scritti come li lascia R2,
 * senza toccare l'enum), poi la 0245 sullo stesso DB: i dati non si muovono.
 */

const DRIZZLE_DIR = path.join(fileURLToPath(new URL("..", import.meta.url)), "drizzle");
const R3_IDX = 245;

type Journal = { entries: { idx: number; when: number; tag: string }[] };

async function migrationsFolderUpTo(stopBeforeIdx: number): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sw-mig245-"));
  await cp(DRIZZLE_DIR, dir, { recursive: true });
  const journalPath = path.join(dir, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as Journal;
  const dropped = journal.entries.filter((e) => e.idx >= stopBeforeIdx);
  journal.entries = journal.entries.filter((e) => e.idx < stopBeforeIdx);
  await writeFile(journalPath, JSON.stringify(journal, null, 2));
  await Promise.all(dropped.map((e) => rm(path.join(dir, `${e.tag}.sql`), { force: true })));
  return dir;
}

describe("il journal delle migrazioni", () => {
  it("idx e `when` crescono insieme lungo tutto il journal (drizzle applica per `when`: una più vecchia arrivata dopo si salta in silenzio)", () => {
    const journal = JSON.parse(readFileSync(path.join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8")) as Journal;
    const out: string[] = [];
    for (let i = 1; i < journal.entries.length; i++) {
      const [a, b] = [journal.entries[i - 1]!, journal.entries[i]!];
      if (!(b.idx > a.idx && b.when > a.when)) out.push(`${a.tag} → ${b.tag}`);
    }
    expect(out).toEqual([]);
    // La 0245 è l'ultima: lascia un margine dopo la 0240 della #146, e chi arriva dopo la segue.
    expect(journal.entries.at(-1)!.tag).toBe("0245_tickets_senza_enum");
  });
});

describe("migrazione 0245: gli stati senza l'enum", () => {
  let container: StartedPostgreSqlContainer;
  let db: Db;
  let client: { end: () => Promise<unknown> };
  let projectA: string;
  let projectB: string;
  let n = 0;
  /** Le righe di prima della 0245: id, stato, closed_at, triaged_at, status derivato. */
  let before: { id: string; status_id: string; closed_at: string | null; triaged_at: string | null; derived: string }[];

  const statusOf = async (projectId: string, name: string) =>
    (await db.select({ id: projectStatuses.id }).from(projectStatuses).where(sql`${projectStatuses.projectId} = ${projectId} and ${projectStatuses.name} = ${name}`))[0]!.id;

  async function newTicket(projectId: string, statusId?: string): Promise<string> {
    n += 1;
    const [row] = await db.execute<{ id: string }>(sql`
      insert into "tickets" ("project_id", "number", "title", "type", "priority", "source"${statusId ? sql`, "status_id"` : sql``})
      values (${projectId}, ${n}, ${`t${n}`}, 'bug', 'medium', 'manual'${statusId ? sql`, ${statusId}` : sql``}) returning "id"
    `);
    return row!.id;
  }

  const state = async (id: string) =>
    (
      await db
        .select({ statusId: tickets.statusId, closedAt: tickets.closedAt, triagedAt: tickets.triagedAt, status: ticketStatusSql, projectId: tickets.projectId })
        .from(tickets)
        .where(eq(tickets.id, id))
    )[0]!;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg17").withEnvironment({ POSTGRES_INITDB_ARGS: "--locale=C" }).start();
    const handle = createDb(container.getConnectionUri());
    db = handle.db;
    client = handle.client;
    await migrate(db, { migrationsFolder: await migrationsFolderUpTo(R3_IDX) });
    const mk = async (name: string) =>
      (await db.execute<{ id: string }>(sql`insert into "projects" ("name", "slug", "ingestion_key") values (${name}, ${name.toLowerCase()}, ${randomUUID()}) returning "id"`))[0]!.id;
    projectA = await mk("Alfa");
    projectB = await mk("Beta");
    // I ticket di prima, uno per stato, più uno smistato e uno chiuso con la sua data.
    const ids: string[] = [];
    // Un secondo todo, per lo spostamento fra due todo.
    await db.execute(sql`insert into "project_statuses" ("project_id", "name", "family", "position", "legacy_status") values (${projectA}, 'Ready', 'todo', 5, 'open')`);
    for (const name of ["To do", "Ready", "In progress", "In review", "Done", "Discarded"]) {
      const sid = (await db.execute<{ id: string }>(sql`select "id" from "project_statuses" where "project_id" = ${projectA} and "name" = ${name}`))[0]?.id;
      if (sid) ids.push(await newTicket(projectA, sid));
    }
    const triaged = await newTicket(projectA);
    await db.execute(sql`update "tickets" set "triaged_at" = now() where "id" = ${triaged}`);
    ids.push(triaged);
    before = await db.execute(sql`
      select "id", "status_id", "closed_at"::text as closed_at, "triaged_at"::text as triaged_at,
        stubwise_ticket_status("status_id", "triaged_at")::text as derived
      from "tickets" where "id" in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}) order by "id"
    `);
    expect(before.length).toBeGreaterThanOrEqual(5);
    await migrate(db, { migrationsFolder: DRIZZLE_DIR });
  }, 180_000);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it("via la colonna, il tipo e i due trigger dell'enum; c'è `tickets_state`", async () => {
    const cols = await db.execute(sql`select 1 from information_schema.columns where table_name = 'tickets' and column_name = 'status'`);
    expect(cols).toHaveLength(0);
    const types = await db.execute(sql`select 1 from pg_type where typname = 'ticket_status'`);
    expect(types).toHaveLength(0);
    const triggers = (await db.execute<{ tgname: string }>(sql`
      select tgname from pg_trigger where tgrelid = 'tickets'::regclass and not tgisinternal order by tgname
    `)).map((r) => r.tgname);
    expect(triggers).not.toContain("tickets_status_sync");
    expect(triggers).not.toContain("tickets_triaged_reset");
    expect(triggers).toContain("tickets_state");
  });

  it("la guardia del blocco T: scrivere o leggere `tickets.status` fallisce (42703), la colonna non esiste", async () => {
    const id = await newTicket(projectA);
    await expectSqlState(db.execute(sql`update "tickets" set "status" = 'done' where "id" = ${id}`), "42703");
    await expectSqlState(db.execute(sql`select "status" from "tickets" where "id" = ${id}`), "42703");
  });

  it("`legacy_status` è text con un CHECK sugli stessi valori di prima", async () => {
    const [col] = await db.execute<{ data_type: string }>(sql`
      select data_type from information_schema.columns where table_name = 'project_statuses' and column_name = 'legacy_status'
    `);
    expect(col!.data_type).toBe("text");
    await expectSqlState(
      db.execute(sql`insert into "project_statuses" ("project_id", "name", "family", "position", "legacy_status") values (${projectA}, 'X', 'todo', 90, 'nope')`),
      "23514",
    );
    const ok = await db.execute<{ legacy_status: string }>(sql`select distinct "legacy_status" from "project_statuses" order by 1`);
    expect(ok.map((r) => r.legacy_status).every((v) => ["open", "triaged", "in_progress", "in_review", "done", "closed"].includes(v))).toBe(true);
  });

  it("le funzioni prendono e danno text", async () => {
    const rows = await db.execute<{ sig: string }>(sql`
      select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') ' || pg_get_function_result(p.oid) as sig
      from pg_proc p where p.proname in ('stubwise_legacy_family', 'stubwise_status_for_legacy', 'stubwise_ticket_status') order by 1
    `);
    expect(rows.map((r) => r.sig)).toEqual([
      "stubwise_legacy_family(s text) text",
      "stubwise_status_for_legacy(p_project uuid, p_legacy text, p_current uuid) uuid",
      "stubwise_ticket_status(p_status uuid, p_triaged timestamp with time zone) text",
    ]);
  });

  it("i dati non si muovono: stato, closed_at, triaged_at e status derivato come prima", async () => {
    const after = await db.execute(sql`
      select "id", "status_id", "closed_at"::text as closed_at, "triaged_at"::text as triaged_at,
        stubwise_ticket_status("status_id", "triaged_at") as derived
      from "tickets" where "id" in (${sql.join(before.map((b) => sql`${b.id}`), sql`, `)}) order by "id"
    `);
    expect(after).toEqual(before);
  });

  it("un ticket inserito senza status_id va nel primo todo (il ruolo `open`); con uno stato chiuso nasce con closed_at", async () => {
    const id = await newTicket(projectA);
    const s = await state(id);
    expect(s.statusId).toBe(await statusOf(projectA, "To do"));
    expect(s.status).toBe("open");
    expect(s.closedAt).toBeNull();
    const closed = await newTicket(projectA, await statusOf(projectA, "Done"));
    expect((await state(closed)).closedAt).not.toBeNull();
  });

  it("closed_at dalla famiglia: si chiude con la data, fra due chiusi resta, riaperto torna null", async () => {
    const id = await newTicket(projectA);
    await db.update(tickets).set(roleUpdate("done")).where(eq(tickets.id, id));
    const first = (await state(id)).closedAt;
    expect(first).not.toBeNull();
    await db.update(tickets).set({ statusId: await statusOf(projectA, "Discarded") }).where(eq(tickets.id, id));
    expect((await state(id)).closedAt).toEqual(first);
    await db.update(tickets).set(roleUpdate("in_progress")).where(eq(tickets.id, id));
    expect((await state(id)).closedAt).toBeNull();
  });

  it("lo smistamento: `triaged` resta in todo; uscito da todo si toglie; uno spostamento fra due todo senza dirlo lo toglie", async () => {
    const id = await newTicket(projectA);
    await db.update(tickets).set(roleUpdate("triaged")).where(eq(tickets.id, id));
    expect((await state(id)).status).toBe("triaged");
    await db.update(tickets).set({ statusId: await statusOf(projectA, "Ready") }).where(eq(tickets.id, id));
    expect((await state(id)).status).toBe("open");
    await db.update(tickets).set(roleUpdate("triaged")).where(eq(tickets.id, id));
    await db.update(tickets).set(roleUpdate("in_progress")).where(eq(tickets.id, id));
    const s = await state(id);
    expect(s.triagedAt).toBeNull();
    expect(s.status).toBe("in_progress");
    // Un segno dato fuori da todo non resta.
    await db.update(tickets).set({ triagedAt: sql`now()` }).where(eq(tickets.id, id));
    expect((await state(id)).triagedAt).toBeNull();
  });

  it("cambio di progetto: lo stato dal RUOLO dello stato di prima, e uno smistato resta smistato", async () => {
    const id = await newTicket(projectA, await statusOf(projectA, "In review"));
    await db.update(tickets).set({ projectId: projectB }).where(eq(tickets.id, id));
    const s = await state(id);
    expect(s.projectId).toBe(projectB);
    expect(s.statusId).toBe(await statusOf(projectB, "In review"));
    const t = await newTicket(projectA);
    await db.update(tickets).set(roleUpdate("triaged")).where(eq(tickets.id, t));
    await db.update(tickets).set({ projectId: projectB }).where(eq(tickets.id, t));
    const moved = await state(t);
    expect(moved.statusId).toBe(await statusOf(projectB, "To do"));
    expect(moved.status).toBe("triaged");
    // Chiuso in A, chiuso in B: closed_at resta quello di prima.
    const c = await newTicket(projectA, await statusOf(projectA, "Done"));
    const closedAt = (await state(c)).closedAt;
    await db.update(tickets).set({ projectId: projectB }).where(eq(tickets.id, c));
    expect((await state(c)).statusId).toBe(await statusOf(projectB, "Done"));
    expect((await state(c)).closedAt).toEqual(closedAt);
  });

  it("uno stato di un altro progetto è rifiutato (23503), all'INSERT e all'UPDATE", async () => {
    const foreign = await statusOf(projectB, "To do");
    await expectSqlState(newTicket(projectA, foreign), "23503");
    const id = await newTicket(projectA);
    await expectSqlState(db.update(tickets).set({ statusId: foreign }).where(eq(tickets.id, id)), "23503");
  });

  it("`statusIdForRole` (il frammento del codice) funziona sui parametri text", async () => {
    const id = await newTicket(projectA);
    await db.update(tickets).set({ statusId: statusIdForRole("in_review") }).where(eq(tickets.id, id));
    expect((await state(id)).statusId).toBe(await statusOf(projectA, "In review"));
  });
});

describe("il codice di R3 gira anche PRIMA della 0245 (il rollback a R2)", () => {
  // Dopo R3 si scende al massimo a R2, e R2 deve girare sul DB di dopo; e il
  // codice di R3, se arriva prima della migrazione (la finestra del deploy),
  // deve girare sul DB di prima. I frammenti di `ticket-status.ts` non
  // nominano il tipo `ticket_status`, che la 0245 toglie: lo stesso codice
  // regge tutti e due gli schemi. (Se questo commit arriva in R0 o R2, quelle
  // immagini reggono la 0245.)
  let container: StartedPostgreSqlContainer;
  let db: Db;
  let client: { end: () => Promise<unknown> };

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg17").withEnvironment({ POSTGRES_INITDB_ARGS: "--locale=C" }).start();
    const handle = createDb(container.getConnectionUri());
    db = handle.db;
    client = handle.client;
    await migrate(db, { migrationsFolder: await migrationsFolderUpTo(R3_IDX) });
  }, 180_000);
  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it("roleUpdate, statusIdForRole, ticketRoleIn e ticketStatusSql sullo schema di prima", async () => {
    const [p] = await db.execute<{ id: string }>(sql`insert into "projects" ("name", "slug", "ingestion_key") values ('Prima', 'prima', ${randomUUID()}) returning "id"`);
    const [t] = await db.execute<{ id: string }>(sql`
      insert into "tickets" ("project_id", "number", "title", "type", "priority", "source") values (${p!.id}, 1, 't', 'bug', 'medium', 'manual') returning "id"
    `);
    await db.update(tickets).set(roleUpdate("in_review")).where(eq(tickets.id, t!.id));
    const [row] = await db.select({ status: ticketStatusSql }).from(tickets).where(eq(tickets.id, t!.id));
    expect(row!.status).toBe("in_review");
    await db.update(tickets).set({ statusId: statusIdForRole("done") }).where(eq(tickets.id, t!.id));
    const found = await db.select({ id: tickets.id }).from(tickets).where(ticketRoleIn(["done", "closed"]));
    expect(found.map((f) => f.id)).toContain(t!.id);
    const triaged = await db.select({ id: tickets.id }).from(tickets).where(ticketRoleIn(["triaged"]));
    expect(triaged.map((f) => f.id)).not.toContain(t!.id);
  });
});

