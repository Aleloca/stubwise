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
import { decisionRequests, departments, projects, ticketFollowers, tickets, users } from "./schema.js";
import { expectSqlState, seedDecisionRequest, seedDepartment, seedTicket } from "./testing.js";

/**
 * Migrazione 0109 (9 nov 2026, integrazione area 2): reparto delle task,
 * ferme a mano, soglie, follower, richieste di decisione, e le persone nuove
 * nel reparto di ripiego. Catena fino alla 0108 con un ticket «di prima»,
 * poi il resto sullo stesso DB.
 */

const DRIZZLE_DIR = path.join(fileURLToPath(new URL("..", import.meta.url)), "drizzle");

async function migrationsFolderUpTo(stopBeforeIdx: number): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sw-mig109-"));
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

async function newUser(db: Db): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ email: `${randomUUID()}@example.com`, passwordHash: "h", role: "member" })
    .returning({ id: users.id });
  return u!.id;
}

describe("migrazione 0109: extra delle task", () => {
  let container: StartedPostgreSqlContainer;
  let db: Db;
  let client: { end: () => Promise<unknown> };
  let oldTicketId: string;
  let defaultDeptId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg17")
      .withEnvironment({ POSTGRES_INITDB_ARGS: "--locale=C" })
      .start();
    const handle = createDb(container.getConnectionUri());
    db = handle.db;
    client = handle.client;
    await migrate(db, { migrationsFolder: await migrationsFolderUpTo(109) });
    const [p] = await db.execute<{ id: string }>(sql`
      insert into "projects" ("name", "slug", "ingestion_key")
      values ('Vecchio', 'vecchio', ${randomUUID()}) returning "id"
    `);
    const [t] = await db.execute<{ id: string }>(sql`
      insert into "tickets" ("project_id", "number", "title", "type", "priority", "source")
      values (${p!.id}, 1, 'vecchio', 'bug', 'medium', 'manual') returning "id"
    `);
    oldTicketId = t!.id;
    await migrate(db, { migrationsFolder: DRIZZLE_DIR });
    const [d] = await db.select({ id: departments.id }).from(departments).where(eq(departments.isDefault, true));
    defaultDeptId = d!.id;
  }, 180_000);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it("i ticket esistenti finiscono nel reparto di ripiego", async () => {
    const [t] = await db.select({ d: tickets.departmentId }).from(tickets).where(eq(tickets.id, oldTicketId));
    expect(t!.d).toBe(defaultDeptId);
  });

  it("un ticket inserito senza reparto prende quello di ripiego", async () => {
    const { ticketId } = await seedTicket(db);
    const [t] = await db.select({ d: tickets.departmentId }).from(tickets).where(eq(tickets.id, ticketId));
    expect(t!.d).toBe(defaultDeptId);
  });

  it("un utente nuovo è membro del reparto di ripiego", async () => {
    const userId = await newUser(db);
    const rows = await db.execute<{ department_id: string; position: number }>(sql`
      select "department_id", "position" from "department_members" where "user_id" = ${userId}
    `);
    expect(rows.map((r) => [r.department_id, r.position])).toEqual([[defaultDeptId, 0]]);
  });

  it("eliminare il reparto di ripiego con task è rifiutato", async () => {
    await expectSqlState(db.delete(departments).where(eq(departments.id, defaultDeptId)), "23503");
  });

  it("un reparto con task non si elimina; senza sì", async () => {
    const dept = await seedDepartment(db);
    const { ticketId } = await seedTicket(db);
    await db.update(tickets).set({ departmentId: dept.id }).where(eq(tickets.id, ticketId));
    await expectSqlState(db.delete(departments).where(eq(departments.id, dept.id)), "23503");
    await db.update(tickets).set({ departmentId: defaultDeptId }).where(eq(tickets.id, ticketId));
    await db.delete(departments).where(eq(departments.id, dept.id));
  });

  it("le soglie hanno i default 7/14 e stanno fra 1 e 90", async () => {
    const { projectId } = await seedTicket(db);
    const [p] = await db
      .select({ a: projects.stallActiveDays, t: projects.stallTodoDays })
      .from(projects)
      .where(eq(projects.id, projectId));
    expect(p).toEqual({ a: 7, t: 14 });
    await expectSqlState(
      db.update(projects).set({ stallActiveDays: 0 }).where(eq(projects.id, projectId)),
      "23514",
    );
    await expectSqlState(
      db.update(projects).set({ stallTodoDays: 91 }).where(eq(projects.id, projectId)),
      "23514",
    );
  });

  it("una ferma a mano vuole motivo e data insieme", async () => {
    const { ticketId } = await seedTicket(db);
    await expectSqlState(
      db.update(tickets).set({ manualStallReason: "aspetta il fornitore" }).where(eq(tickets.id, ticketId)),
      "23514",
    );
    await db
      .update(tickets)
      .set({ manualStallReason: "aspetta il fornitore", manualStallSince: new Date() })
      .where(eq(tickets.id, ticketId));
  });

  it("una decisione non può essere sia risposta sia ritirata", async () => {
    const { ticketId } = await seedTicket(db);
    const askedOfUserId = await newUser(db);
    const { id } = await seedDecisionRequest(db, { ticketId, askedOfUserId, options: ["A", "B"] });
    await expectSqlState(
      db
        .update(decisionRequests)
        .set({ answerOptionIndex: 0, answeredAt: new Date(), withdrawnAt: new Date() })
        .where(eq(decisionRequests.id, id)),
      "23514",
    );
  });

  it("una risposta è un indice oppure un testo, non entrambi", async () => {
    const { ticketId } = await seedTicket(db);
    const askedOfUserId = await newUser(db);
    const { id } = await seedDecisionRequest(db, { ticketId, askedOfUserId, options: ["A"] });
    await expectSqlState(
      db
        .update(decisionRequests)
        .set({ answerOptionIndex: 0, answerText: "altro", answeredAt: new Date() })
        .where(eq(decisionRequests.id, id)),
      "23514",
    );
  });

  it("eliminare il ticket elimina follower e decisioni", async () => {
    const { ticketId } = await seedTicket(db);
    const userId = await newUser(db);
    await db.insert(ticketFollowers).values({ ticketId, userId });
    await seedDecisionRequest(db, { ticketId, askedOfUserId: userId });
    await db.delete(tickets).where(eq(tickets.id, ticketId));
    expect(await db.select().from(ticketFollowers).where(eq(ticketFollowers.ticketId, ticketId))).toHaveLength(0);
    expect(await db.select().from(decisionRequests).where(eq(decisionRequests.ticketId, ticketId))).toHaveLength(0);
  });
});
