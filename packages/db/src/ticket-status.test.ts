import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./client.js";
import { projectStatuses, tickets } from "./schema.js";
import { legacyTicketStatus, seedRepository, startTestDb, type TestDb } from "./testing.js";
import { roleUpdate, statusIdForRole, ticketStatusSql, type TicketRole } from "./ticket-status.js";

// Gli stati senza l'enum (blocco T del ritiro del web vecchio, R0). Il test
// d'accordo: per ogni ruolo che uno scrittore assegna, da ogni stato di
// partenza, lo scrittore VECCHIO (`UPDATE … SET status = ruolo`, il trigger
// fa il resto) e quello NUOVO (`status_id = statusIdForRole(ruolo)`) danno lo
// stesso stato del progetto, la stessa colonna enum (ancora tenuta dal
// trigger) e lo stesso `status` mostrato (prima la colonna, ora il derivato).

let testDb: TestDb;
let db: Db;
let projectId: string;
let statuses: { id: string; name: string; family: string; legacy: string }[];
let next = 100;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  ({ projectId } = await seedRepository(db));
  statuses = (
    await db
      .select({ id: projectStatuses.id, name: projectStatuses.name, family: projectStatuses.family, legacy: projectStatuses.legacyStatus })
      .from(projectStatuses)
      .where(eq(projectStatuses.projectId, projectId))
      .orderBy(projectStatuses.position)
  ).map((r) => ({ ...r, legacy: String(r.legacy) }));
}, 120_000);
afterAll(async () => {
  await testDb.stop();
});

async function ticketIn(statusId: string, triaged: boolean): Promise<string> {
  const [row] = await db
    .insert(tickets)
    .values({ projectId, number: next++, title: "t", type: "bug", priority: "medium", source: "manual", statusId })
    .returning({ id: tickets.id });
  // Un todo smistato: come lo lasciava uno scrittore vecchio (enum `triaged`) e come lo lascia quello nuovo (`triaged_at`).
  if (triaged) {
    await db.update(legacyTicketStatus).set({ status: "triaged" }).where(eq(legacyTicketStatus.id, row!.id));
    await db.update(tickets).set({ triagedAt: sql`now()` }).where(eq(tickets.id, row!.id));
  }
  return row!.id;
}

async function observed(id: string) {
  const [row] = await db
    .select({ statusId: tickets.statusId, derived: ticketStatusSql, column: legacyTicketStatus.status })
    // La stessa riga: `legacyTicketStatus` è la tabella `tickets` vista con la sola colonna enum.
    .from(tickets)
    .where(eq(tickets.id, id));
  return row!;
}

const ROLES: TicketRole[] = ["open", "triaged", "in_progress", "in_review", "done", "closed"];

describe("statusIdForRole contro lo scrittore vecchio dell'enum", () => {
  it("per ogni ruolo da ogni stato di partenza: stesso stato, stessa colonna enum, stesso status mostrato", async () => {
    const differences: string[] = [];
    for (const start of statuses) {
      for (const triaged of start.family === "todo" ? [false, true] : [false]) {
        for (const role of ROLES) {
          const oldId = await ticketIn(start.id, triaged);
          const newId = await ticketIn(start.id, triaged);
          await db.execute(sql`update tickets set status = ${role}::"ticket_status" where id = ${oldId}`);
          await db.update(tickets).set(roleUpdate(role)).where(eq(tickets.id, newId));
          const before = await observed(oldId);
          const after = await observed(newId);
          const label = `${start.name}${triaged ? " (smistato)" : ""} → ${role}`;
          if (after.statusId !== before.statusId) differences.push(`${label}: stato ${before.statusId} → ${after.statusId}`);
          // Lo status MOSTRATO: prima era la colonna, ora è il derivato.
          if (after.derived !== before.column) differences.push(`${label}: mostrato ${before.column} → ${after.derived}`);
          // La colonna enum, ancora tenuta dal trigger: identica, salvo `triaged` (che ora vive in `triaged_at`).
          if (role !== "triaged" && after.column !== before.column) differences.push(`${label}: colonna ${before.column} → ${after.column}`);
        }
      }
    }
    // L'UNICA differenza, voluta: una task in «In review» a cui la pipeline dà
    // `in_progress` (un fix rilanciato) resta in «In review» in entrambi i
    // modi, ma lo scrittore vecchio lasciava l'enum a `in_progress`, in
    // contraddizione con lo stato. Ora lo status mostrato è quello dello stato.
    expect(differences).toEqual([
      "In review → in_progress: mostrato in_progress → in_review",
      "In review → in_progress: colonna in_progress → in_review",
    ]);
  });

  it("triaged: un todo smistato mostra triaged; uscito da todo torna senza segno, e rientrando in todo è open", async () => {
    const todo = statuses.find((s) => s.family === "todo")!;
    const id = await ticketIn(todo.id, false);
    await db.update(tickets).set(roleUpdate("triaged")).where(eq(tickets.id, id));
    expect((await observed(id)).derived).toBe("triaged");
    await db.update(tickets).set({ statusId: statusIdForRole("in_progress") }).where(eq(tickets.id, id));
    const [mid] = await db.select({ triagedAt: tickets.triagedAt }).from(tickets).where(eq(tickets.id, id));
    expect(mid!.triagedAt).toBeNull();
    expect((await observed(id)).derived).toBe("in_progress");
    await db.update(tickets).set(roleUpdate("open")).where(eq(tickets.id, id));
    expect((await observed(id)).derived).toBe("open");
  });
});
