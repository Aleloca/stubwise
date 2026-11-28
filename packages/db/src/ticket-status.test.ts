import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./client.js";
import { projectStatuses, tickets } from "./schema.js";
import { legacyTicketStatus, seedRepository, startTestDb, type TestDb } from "./testing.js";
import { roleLiteral, roleUpdate, statusIdForRole, ticketStatusSql, type TicketRole } from "./ticket-status.js";

// Gli stati senza l'enum (blocco T del ritiro del web vecchio, R0). Il test
// d'accordo: per ogni ruolo che uno scrittore assegna, da ogni stato di
// partenza, lo scrittore VECCHIO (`UPDATE … SET status = ruolo`, il trigger
// fa il resto) e quello NUOVO (`status_id = statusIdForRole(ruolo)`) danno lo
// stesso stato del progetto, la stessa colonna enum (ancora tenuta dal
// trigger) e lo stesso `status` mostrato (prima la colonna, ora il derivato).

let testDb: TestDb;
let db: Db;
type Status = { id: string; name: string; family: string; legacy: string };
let next = 100;

/** Il progetto con gli stati di default, e uno con stati PERSONALIZZATI: due todo, un solo active (niente «In review»), un solo closed. */
let standard: { projectId: string; statuses: Status[] };
let custom: { projectId: string; statuses: Status[] };

async function statusesOf(projectId: string): Promise<Status[]> {
  return (
    await db
      .select({ id: projectStatuses.id, name: projectStatuses.name, family: projectStatuses.family, legacy: projectStatuses.legacyStatus })
      .from(projectStatuses)
      .where(eq(projectStatuses.projectId, projectId))
      .orderBy(projectStatuses.position)
  ).map((r) => ({ ...r, legacy: String(r.legacy) }));
}

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  const a = await seedRepository(db);
  standard = { projectId: a.projectId, statuses: await statusesOf(a.projectId) };
  const b = await seedRepository(db);
  await db.delete(projectStatuses).where(eq(projectStatuses.projectId, b.projectId));
  await db.insert(projectStatuses).values([
    { projectId: b.projectId, name: "Inbox", family: "todo", position: 0, legacyStatus: "open" },
    { projectId: b.projectId, name: "Ready", family: "todo", position: 1, legacyStatus: "open" },
    { projectId: b.projectId, name: "Doing", family: "active", position: 2, legacyStatus: "in_progress" },
    { projectId: b.projectId, name: "Shipped", family: "closed", position: 3, legacyStatus: "done" },
  ]);
  custom = { projectId: b.projectId, statuses: await statusesOf(b.projectId) };
}, 120_000);
afterAll(async () => {
  await testDb.stop();
});

async function ticketIn(conn: Db, projectId: string, statusId: string): Promise<string> {
  const [row] = await conn
    .insert(tickets)
    .values({ projectId, number: next++, title: "t", type: "bug", priority: "medium", source: "manual", statusId })
    .returning({ id: tickets.id });
  return row!.id;
}

async function observed(conn: Db, id: string) {
  const [row] = await conn
    .select({ statusId: tickets.statusId, derived: ticketStatusSql, column: legacyTicketStatus.status })
    // La stessa riga: `legacyTicketStatus` è la tabella `tickets` vista con la sola colonna enum.
    .from(tickets)
    .where(eq(tickets.id, id));
  return row!;
}

const ROLES: TicketRole[] = ["open", "triaged", "in_progress", "in_review", "done", "closed"];

/**
 * Le differenze fra lo scrittore vecchio e quello nuovo, per ogni ruolo da ogni
 * stato di partenza del progetto. Il percorso VECCHIO è com'era prima di 0240,
 * calcolato (vedi sotto): «smistato» viveva solo nell'enum. Il NUOVO usa
 * `roleUpdate`, e un todo smistato è `triaged_at`.
 */
async function differencesIn(project: { projectId: string; statuses: Status[] }): Promise<string[]> {
  const cases = project.statuses.flatMap((start) =>
    (start.family === "todo" ? [false, true] : [false]).flatMap((triaged) => ROLES.map((role) => ({ start, triaged, role }))),
  );
  // Il riferimento VECCHIO si CALCOLA, non si scrive: prima di 0240 lo
  // scrittore dell'enum lasciava nella colonna il ruolo scritto (il trigger
  // `tickets_status_sync` non la tocca quando cambia solo lei), e lo stato era
  // `stubwise_status_for_legacy(progetto, ruolo, stato di partenza)`. Scriverlo
  // davvero vorrebbe spegnere `tickets_triaged_reset`, e nessun codice spegne
  // un trigger (`automation-triggers-bypass.test.ts`).
  const before: { statusId: string; column: string }[] = [];
  for (const c of cases) {
    const [row] = await db.execute<{ sid: string }>(
      sql`select stubwise_status_for_legacy(${project.projectId}::uuid, ${roleLiteral(c.role)}, ${c.start.id}::uuid) as sid`,
    );
    before.push({ statusId: row!.sid, column: c.role });
  }
  const differences: string[] = [];
  for (const [n, c] of cases.entries()) {
    const id = await ticketIn(db, project.projectId, c.start.id);
    if (c.triaged) await db.update(tickets).set(roleUpdate("triaged")).where(eq(tickets.id, id));
    await db.update(tickets).set(roleUpdate(c.role)).where(eq(tickets.id, id));
    const old = before[n]!;
    const now = await observed(db, id);
    const label = `${c.start.name}${c.triaged ? " (smistato)" : ""} → ${c.role}`;
    if (now.statusId !== old.statusId) differences.push(`${label}: stato ${old.statusId} → ${now.statusId}`);
    // Lo status MOSTRATO: prima era la colonna, ora è il derivato.
    if (now.derived !== old.column) differences.push(`${label}: mostrato ${old.column} → ${now.derived}`);
    // La colonna enum, ancora tenuta dal trigger.
    if (now.column !== old.column) differences.push(`${label}: colonna ${old.column} → ${now.column}`);
  }
  return differences;
}

describe("statusIdForRole contro lo scrittore vecchio dell'enum", () => {
  it("stati di default: per ogni ruolo da ogni stato di partenza, stesso stato, stessa colonna enum, stesso status mostrato", async () => {
    // L'UNICA differenza, voluta: una task in «In review» a cui la pipeline dà
    // `in_progress` (un fix rilanciato) resta in «In review» in entrambi i
    // modi, ma lo scrittore vecchio lasciava l'enum a `in_progress`, in
    // contraddizione con lo stato. Ora lo status mostrato è quello dello stato.
    expect(await differencesIn(standard)).toEqual([
      "In review → in_progress: mostrato in_progress → in_review",
      "In review → in_progress: colonna in_progress → in_review",
    ]);
  });

  it("stati personalizzati (due todo, un active, un closed): vale lo stato RAGGIUNTO, anche quando non ha il ruolo chiesto", async () => {
    // Senza uno stato «in_review» e senza uno «closed», lo scrittore vecchio
    // finiva nello stesso stato (l'unico active, l'unico closed) ma con l'enum
    // al ruolo CHIESTO, in contraddizione con la board. Ora lo status è quello
    // dello stato raggiunto (decisione della revisione di R0, I1).
    const expected = custom.statuses.flatMap((start) =>
      (start.family === "todo" ? [false, true] : [false]).flatMap((triaged) => {
        const label = `${start.name}${triaged ? " (smistato)" : ""}`;
        return [
          `${label} → in_review: mostrato in_review → in_progress`,
          `${label} → in_review: colonna in_review → in_progress`,
          `${label} → closed: mostrato closed → done`,
          `${label} → closed: colonna closed → done`,
        ];
      }),
    );
    expect(await differencesIn(custom)).toEqual(expected);
  });

  it("triaged: un todo smistato mostra triaged; uscito da todo torna senza segno, e rientrando in todo è open", async () => {
    const todo = standard.statuses.find((s) => s.family === "todo")!;
    const id = await ticketIn(db, standard.projectId, todo.id);
    await db.update(tickets).set(roleUpdate("triaged")).where(eq(tickets.id, id));
    expect((await observed(db, id)).derived).toBe("triaged");
    await db.update(tickets).set({ statusId: statusIdForRole("in_progress") }).where(eq(tickets.id, id));
    const [mid] = await db.select({ triagedAt: tickets.triagedAt }).from(tickets).where(eq(tickets.id, id));
    expect(mid!.triagedAt).toBeNull();
    expect((await observed(db, id)).derived).toBe("in_progress");
    await db.update(tickets).set(roleUpdate("open")).where(eq(tickets.id, id));
    expect((await observed(db, id)).derived).toBe("open");
  });

  it("uno scrittore VECCHIO (worker non ribuildato, rollback): l'enum che scrive tiene allineato «smistato»", async () => {
    const todo = standard.statuses.find((s) => s.family === "todo")!;
    const triagedAt = async (id: string) => (await db.select({ t: tickets.triagedAt }).from(tickets).where(eq(tickets.id, id)))[0]!.t;
    const id = await ticketIn(db, standard.projectId, todo.id);
    await db.execute(sql`update tickets set status = 'triaged' where id = ${id}`);
    expect(await triagedAt(id)).not.toBeNull();
    expect((await observed(db, id)).derived).toBe("triaged");
    await db.execute(sql`update tickets set status = 'open' where id = ${id}`);
    expect(await triagedAt(id)).toBeNull();
    expect((await observed(db, id)).derived).toBe("open");
    // E all'INSERT, senza `status_id`: com'era il createTicket di prima.
    const [row] = await db.execute<{ id: string }>(
      sql`insert into tickets (project_id, number, title, type, priority, source, status) values (${standard.projectId}, ${next++}, 't', 'bug', 'medium', 'manual', 'triaged') returning id`,
    );
    expect(await triagedAt(row!.id)).not.toBeNull();
    expect((await observed(db, row!.id)).derived).toBe("triaged");
  });

  it("uno spostamento fra due stati todo senza dire triaged_at toglie il segno, come lo scrittore vecchio", async () => {
    const [inbox, ready] = custom.statuses.filter((s) => s.family === "todo");
    const id = await ticketIn(db, custom.projectId, inbox!.id);
    await db.update(tickets).set(roleUpdate("triaged")).where(eq(tickets.id, id));
    expect((await observed(db, id)).derived).toBe("triaged");
    await db.update(tickets).set({ statusId: ready!.id }).where(eq(tickets.id, id));
    const now = await observed(db, id);
    expect(now.statusId).toBe(ready!.id);
    expect(now.derived).toBe("open");
    expect(now.column).toBe("open");
  });
});
