import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client.js";
import { projectStatuses, projects, tickets } from "./schema.js";
import { expectSqlState, firstStatusOf, seedRepository, seedTicket } from "./testing.js";

/**
 * Migrazione 0108 (9 nov 2026, integrazione area 2): stati per progetto con
 * l'enum `tickets.status` derivato dal trigger `tickets_status_sync`. Catena
 * fino alla 0107 con ticket «di prima», poi il resto delle migrazioni sullo
 * stesso DB (il backfill gira sui dati veri); poi le regole del trigger.
 */

const DRIZZLE_DIR = path.join(fileURLToPath(new URL("..", import.meta.url)), "drizzle");
const LEGACY = ["open", "triaged", "in_progress", "in_review", "done", "closed"] as const;

async function migrationsFolderUpTo(stopBeforeIdx: number): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sw-mig108-"));
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

type Row = {
  status: string;
  status_name: string;
  closed_at: string | null;
};

async function stateOf(db: Db, ticketId: string): Promise<Row> {
  const rows = await db.execute<Row>(sql`
    select t."status", s."name" as status_name, t."closed_at"
    from "tickets" t join "project_statuses" s on s."id" = t."status_id"
    where t."id" = ${ticketId}
  `);
  return rows[0]!;
}

describe("migrazione 0108: stati per progetto", () => {
  let container: StartedPostgreSqlContainer;
  let db: Db;
  let client: { end: () => Promise<unknown> };
  let oldProjectId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg17")
      .withEnvironment({ POSTGRES_INITDB_ARGS: "--locale=C" })
      .start();
    const handle = createDb(container.getConnectionUri());
    db = handle.db;
    client = handle.client;
    await migrate(db, { migrationsFolder: await migrationsFolderUpTo(108) });
    const [p] = await db.execute<{ id: string }>(sql`
      insert into "projects" ("name", "slug", "ingestion_key")
      values ('Vecchio', 'vecchio', ${randomUUID()}) returning "id"
    `);
    oldProjectId = p!.id;
    let n = 0;
    for (const status of LEGACY) {
      n += 1;
      await db.execute(sql`
        insert into "tickets" ("project_id", "number", "title", "type", "priority", "source", "status")
        values (${oldProjectId}, ${n}, ${status}, 'bug', 'medium', 'manual', ${status})
      `);
    }
    await migrate(db, { migrationsFolder: DRIZZLE_DIR });
  }, 180_000);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it("un progetto nuovo nasce con i cinque stati di default", async () => {
    const { projectId } = await seedRepository(db);
    const rows = await db
      .select({
        name: projectStatuses.name,
        family: projectStatuses.family,
        legacy: projectStatuses.legacyStatus,
      })
      .from(projectStatuses)
      .where(eq(projectStatuses.projectId, projectId))
      .orderBy(projectStatuses.position);
    expect(rows).toEqual([
      { name: "To do", family: "todo", legacy: "open" },
      { name: "In progress", family: "active", legacy: "in_progress" },
      { name: "In review", family: "active", legacy: "in_review" },
      { name: "Done", family: "closed", legacy: "done" },
      { name: "Discarded", family: "closed", legacy: "closed" },
    ]);
  });

  it("backfill: ogni ticket esistente ha lo stato che corrisponde al suo enum", async () => {
    const rows = await db.execute<{ title: string; status: string; name: string; closed: boolean }>(sql`
      select t."title", t."status", s."name", t."closed_at" is not null as closed
      from "tickets" t join "project_statuses" s on s."id" = t."status_id"
      where t."project_id" = ${oldProjectId} order by t."number"
    `);
    expect(rows.map((r) => [r.status, r.name, r.closed])).toEqual([
      ["open", "To do", false],
      ["triaged", "To do", false],
      ["in_progress", "In progress", false],
      ["in_review", "In review", false],
      ["done", "Done", true],
      ["closed", "Discarded", true],
    ]);
  });

  it("un ticket inserito senza status_id prende lo stato del suo enum", async () => {
    const { ticketId } = await seedTicket(db);
    expect(await stateOf(db, ticketId)).toMatchObject({ status: "open", status_name: "To do", closed_at: null });
  });

  it("la pipeline che scrive in_review sposta in In review", async () => {
    const { ticketId } = await seedTicket(db);
    await db.update(tickets).set({ status: "in_progress" }).where(eq(tickets.id, ticketId));
    await db.update(tickets).set({ status: "in_review" }).where(eq(tickets.id, ticketId));
    expect(await stateOf(db, ticketId)).toMatchObject({ status: "in_review", status_name: "In review" });
  });

  it("il webhook che scrive done sposta in Done e valorizza closed_at", async () => {
    const { ticketId } = await seedTicket(db);
    await db.update(tickets).set({ status: "done" }).where(eq(tickets.id, ticketId));
    const s = await stateOf(db, ticketId);
    expect(s).toMatchObject({ status: "done", status_name: "Done" });
    expect(s.closed_at).not.toBeNull();
  });

  it("in_review → triaged torna nel primo todo, lo status resta triaged e closed_at torna null", async () => {
    const { ticketId } = await seedTicket(db);
    await db.update(tickets).set({ status: "done" }).where(eq(tickets.id, ticketId));
    await db.update(tickets).set({ status: "in_review" }).where(eq(tickets.id, ticketId));
    await db.update(tickets).set({ status: "triaged" }).where(eq(tickets.id, ticketId));
    expect(await stateOf(db, ticketId)).toMatchObject({
      status: "triaged",
      status_name: "To do",
      closed_at: null,
    });
  });

  it("cambiare status_id riscrive l'enum dal legacy_status", async () => {
    const { projectId, ticketId } = await seedTicket(db);
    const discarded = await db
      .select({ id: projectStatuses.id })
      .from(projectStatuses)
      .where(sql`${projectStatuses.projectId} = ${projectId} and ${projectStatuses.name} = 'Discarded'`);
    await db.update(tickets).set({ statusId: discarded[0]!.id }).where(eq(tickets.id, ticketId));
    const s = await stateOf(db, ticketId);
    expect(s).toMatchObject({ status: "closed", status_name: "Discarded" });
    expect(s.closed_at).not.toBeNull();
  });

  it("in_review su una task già in uno stato active successivo non la sposta indietro", async () => {
    const { projectId, ticketId } = await seedTicket(db);
    // QA dopo In review (posizioni 0..4 → QA in 3, Done e Discarded scalano).
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        update "project_statuses" set "position" = "position" + 1
        where "project_id" = ${projectId} and "family" = 'closed'
      `);
      await tx.insert(projectStatuses).values({
        projectId,
        name: "QA",
        family: "active",
        position: 3,
        legacyStatus: "in_review",
      });
    });
    const [qa] = await db
      .select({ id: projectStatuses.id })
      .from(projectStatuses)
      .where(sql`${projectStatuses.projectId} = ${projectId} and ${projectStatuses.name} = 'QA'`);
    await db.update(tickets).set({ statusId: qa!.id }).where(eq(tickets.id, ticketId));
    await db.update(tickets).set({ status: "in_progress" }).where(eq(tickets.id, ticketId));
    await db.update(tickets).set({ status: "in_review" }).where(eq(tickets.id, ticketId));
    expect(await stateOf(db, ticketId)).toMatchObject({ status: "in_review", status_name: "QA" });
  });

  it("riscrivere lo stesso enum non sposta la task da uno stato todo personalizzato", async () => {
    const { projectId, ticketId } = await seedTicket(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        update "project_statuses" set "position" = "position" + 1 where "project_id" = ${projectId}
      `);
      await tx.insert(projectStatuses).values({
        projectId,
        name: "Inbox",
        family: "todo",
        position: 0,
        legacyStatus: "open",
      });
    });
    const toDo = await db
      .select({ id: projectStatuses.id })
      .from(projectStatuses)
      .where(sql`${projectStatuses.projectId} = ${projectId} and ${projectStatuses.name} = 'To do'`);
    await db.update(tickets).set({ statusId: toDo[0]!.id }).where(eq(tickets.id, ticketId));
    // Il triage scrive triaged: la task resta nel suo todo, non torna in Inbox.
    await db.update(tickets).set({ status: "triaged" }).where(eq(tickets.id, ticketId));
    expect(await stateOf(db, ticketId)).toMatchObject({ status: "triaged", status_name: "To do" });
  });

  it("famiglie discordanti nello stesso UPDATE sono rifiutate", async () => {
    const { projectId, ticketId } = await seedTicket(db);
    const done = await firstStatusOf(db, projectId, "closed");
    await expectSqlState(
      db.update(tickets).set({ status: "in_progress", statusId: done }).where(eq(tickets.id, ticketId)),
      "23514",
    );
  });

  it("uno stato di un altro progetto è rifiutato", async () => {
    const { ticketId } = await seedTicket(db);
    const other = await seedRepository(db);
    const foreign = await firstStatusOf(db, other.projectId, "active");
    await expectSqlState(
      db.update(tickets).set({ statusId: foreign }).where(eq(tickets.id, ticketId)),
      "23503",
    );
  });

  it("uno stato con task non si elimina, ma il progetto con le sue task sì", async () => {
    const { projectId } = await seedTicket(db);
    const toDo = await firstStatusOf(db, projectId, "todo");
    await expectSqlState(
      db.delete(projectStatuses).where(eq(projectStatuses.id, toDo)),
      "23503",
    );
    await db.delete(projects).where(eq(projects.id, projectId));
    const left = await db.select().from(projectStatuses).where(eq(projectStatuses.projectId, projectId));
    expect(left).toHaveLength(0);
  });
});
