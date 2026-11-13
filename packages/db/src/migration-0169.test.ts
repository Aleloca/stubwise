import { randomUUID } from "node:crypto";
import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  automationEffects,
  automationEvents,
  automationRunLog,
  automationRuns,
  automations,
  automationVersions,
  backlogItems,
  backlogItemTickets,
  milestones,
  projectStatuses,
  roles,
  tickets,
} from "./schema.js";
import { expectSqlState, firstStatusOf, seedBacklogItem, seedRepository, startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0169 (13 nov 2026, area 7, fetta 1): le Automations di progetto
 * e l'OUTBOX degli eventi scritta dai trigger (correzione C1 del piano, nella
 * forma di `chat_publish_event`). Un evento nasce nella transazione della
 * scrittura (un rollback non lo lascia), porta l'esecuzione d'origine quando
 * scrive il motore (`stubwise.automation_run_id`), e una GUC locale
 * (`stubwise.automation_events = 'off'`) lo spegne per le operazioni di massa.
 */

let t: TestDb;
let projectId: string;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
beforeEach(async () => {
  ({ projectId } = await seedRepository(t.db));
});
afterAll(async () => {
  await t?.stop();
});

const eventsOf = (objectId: string) => t.db.select().from(automationEvents).where(eq(automationEvents.objectId, objectId)).orderBy(asc(automationEvents.createdAt));
let n = 100;
const task = (over: Partial<typeof tickets.$inferInsert> = {}) => ({ projectId, number: n++, title: "Una task", type: "task" as const, priority: "medium" as const, source: "manual" as const, ...over });

async function automationWithRun() {
  const [a] = await t.db.insert(automations).values({ code: `T${randomUUID().slice(0, 6)}-A1`, seq: n++, name: "A", projectId }).returning();
  const [run] = await t.db.insert(automationRuns).values({ automationId: a!.id, n: 1, version: 1, title: "Run", origin: "stubwise" }).returning();
  return { automation: a!, run: run! };
}

describe("migrazione 0169: nessuna valanga dalle migrazioni", () => {
  it("una base appena migrata (seed compresi) non ha eventi: le migrazioni di prima girano prima dei trigger", async () => {
    const fresh = await startTestDb();
    try {
      const [row] = await fresh.db.select({ n: sql<number>`count(*)::int` }).from(automationEvents);
      expect(row!.n).toBe(0);
    } finally {
      await fresh.stop();
    }
  }, 120_000);
});

describe("migrazione 0169: i trigger degli eventi", () => {
  it("task_created: un insert in tickets lascia l'evento con la fotografia della riga e nessuna origine", async () => {
    const [row] = await t.db.insert(tickets).values(task({ title: "Nuova" })).returning();
    const events = await eventsOf(row!.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "task_created", projectId, originRunId: null, consumedAt: null, payload: { number: row!.number, title: "Nuova", statusId: row!.statusId } });
  });

  it("un rollback della scrittura non lascia l'evento", async () => {
    const id = randomUUID();
    await expect(
      t.db.transaction(async (tx) => {
        await tx.insert(tickets).values(task({ id }));
        throw new Error("annulla");
      }),
    ).rejects.toThrow("annulla");
    expect(await eventsOf(id)).toEqual([]);
  });

  it("task_closed: ENTRARE nella famiglia closed (anche scrivendo l'enum vecchio); fra due chiusi no; riaperta e richiusa sì", async () => {
    const [row] = await t.db.insert(tickets).values(task()).returning();
    const active = await firstStatusOf(t.db, projectId, "active");
    const closed = await firstStatusOf(t.db, projectId, "closed");
    await t.db.update(tickets).set({ statusId: active }).where(eq(tickets.id, row!.id));
    await t.db.update(tickets).set({ statusId: closed }).where(eq(tickets.id, row!.id));
    const kinds = async () => (await eventsOf(row!.id)).map((e) => e.kind);
    expect(await kinds()).toEqual(["task_created", "task_closed"]);
    // Un'altra scrittura non cambia nulla, né il passaggio fra due stati chiusi.
    await t.db.update(tickets).set({ title: "rinominata" }).where(eq(tickets.id, row!.id));
    const [cancelled] = await t.db.insert(projectStatuses).values({ projectId, name: "Annullata", family: "closed", position: 99, legacyStatus: "closed" }).returning();
    await t.db.update(tickets).set({ statusId: cancelled!.id }).where(eq(tickets.id, row!.id));
    expect(await kinds()).toEqual(["task_created", "task_closed"]);
    await t.db.update(tickets).set({ statusId: active }).where(eq(tickets.id, row!.id));
    // L'enum vecchio: il trigger di sync traduce `status` in `status_id`.
    await t.db.update(tickets).set({ status: "done" }).where(eq(tickets.id, row!.id));
    expect(await kinds()).toEqual(["task_created", "task_closed", "task_closed"]);
  });

  it("request_created: un insert in backlog_items; una riga nata già fusa no", async () => {
    const { itemId } = await seedBacklogItem(t.db, { projectId, title: "Richiesta" });
    expect((await eventsOf(itemId)).map((e) => [e.kind, (e.payload as { title: string }).title])).toEqual([["request_created", "Richiesta"]]);
    const [merged] = await t.db.insert(backlogItems).values({ projectId, title: "Doppione", source: "manual", mergedIntoId: itemId }).returning();
    expect(await eventsOf(merged!.id)).toEqual([]);
  });

  it("request_converted: il legame converted_to, nella stessa transazione (stesso txid) della task che ne nasce", async () => {
    const { itemId } = await seedBacklogItem(t.db, { projectId });
    const ticketId = await t.db.transaction(async (tx) => {
      const [row] = await tx.insert(tickets).values(task()).returning();
      await tx.update(backlogItems).set({ status: "converted" }).where(eq(backlogItems.id, itemId));
      await tx.insert(backlogItemTickets).values({ itemId, ticketId: row!.id, role: "converted_to" });
      return row!.id;
    });
    const [converted] = (await eventsOf(itemId)).filter((e) => e.kind === "request_converted");
    const [created] = await eventsOf(ticketId);
    expect(converted).toMatchObject({ kind: "request_converted", payload: { ticketId } });
    expect(created!.kind).toBe("task_created");
    expect(converted!.txid).toBe(created!.txid);
    // Un legame `origin` (deviazione) non è una conversione.
    const { itemId: other } = await seedBacklogItem(t.db, { projectId });
    await t.db.insert(backlogItemTickets).values({ itemId: other, ticketId, role: "origin" });
    expect((await eventsOf(other)).map((e) => e.kind)).toEqual(["request_created"]);
  });

  it("milestone_reached: open → closed, una volta", async () => {
    const [m] = await t.db.insert(milestones).values({ projectId, name: "v1" }).returning();
    await t.db.update(milestones).set({ status: "closed" }).where(eq(milestones.id, m!.id));
    await t.db.update(milestones).set({ name: "v1.0" }).where(eq(milestones.id, m!.id));
    expect((await eventsOf(m!.id)).map((e) => [e.kind, (e.payload as { name: string }).name])).toEqual([["milestone_reached", "v1"]]);
  });

  it("l'origine: con `stubwise.automation_run_id` impostata (dal motore) l'evento porta l'esecuzione; solo in quella transazione", async () => {
    const { run } = await automationWithRun();
    const ticketId = await t.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('stubwise.automation_run_id', ${run.id}, true)`);
      const [row] = await tx.insert(tickets).values(task({ automationRunId: run.id })).returning();
      return row!.id;
    });
    expect((await eventsOf(ticketId))[0]!.originRunId).toBe(run.id);
    const [after] = await t.db.insert(tickets).values(task()).returning();
    expect((await eventsOf(after!.id))[0]!.originRunId).toBeNull();
  });

  it("la GUC `stubwise.automation_events = 'off'` spegne gli eventi, solo nella sua transazione", async () => {
    const id = await t.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('stubwise.automation_events', 'off', true)`);
      const [row] = await tx.insert(tickets).values(task()).returning();
      const closed = await firstStatusOf(tx as never, projectId, "closed");
      await tx.update(tickets).set({ statusId: closed }).where(eq(tickets.id, row!.id));
      return row!.id;
    });
    expect(await eventsOf(id)).toEqual([]);
    const [after] = await t.db.insert(tickets).values(task()).returning();
    expect(await eventsOf(after!.id)).toHaveLength(1);
  });
});

describe("migrazione 0169: le tabelle", () => {
  it("il registro è append-only; un effetto per chiave; al più una bozza per automazione", async () => {
    const { automation, run } = await automationWithRun();
    const [entry] = await t.db.insert(automationRunLog).values({ runId: run.id, seq: 1, stepId: "s1", path: "0", kind: "createTask", outcome: "done" }).returning();
    await expectSqlState(t.db.update(automationRunLog).set({ outcome: "failed" }).where(eq(automationRunLog.id, entry!.id)), "23001");
    await t.db.insert(automationEffects).values({ runId: run.id, path: "0", idempotencyKey: `${run.id}:0:0`, kind: "task" });
    await expectSqlState(t.db.insert(automationEffects).values({ runId: run.id, path: "0", idempotencyKey: `${run.id}:0:0`, kind: "task" }), "23505");
    await t.db.insert(automationVersions).values({ automationId: automation.id, n: 1, flow: {} });
    await expectSqlState(t.db.insert(automationVersions).values({ automationId: automation.id, n: 2, flow: {} }), "23505");
    await t.db.insert(automationVersions).values({ automationId: automation.id, n: 3, flow: {}, publishedAt: new Date() });
  });

  it("automations.manage al preset Project Lead, non agli altri preset", async () => {
    const rows = await t.db.select({ key: roles.presetKey, permissions: roles.permissions }).from(roles);
    const has = new Map(rows.filter((r) => r.key).map((r) => [r.key!, r.permissions.includes("automations.manage")]));
    expect(has.get("project_lead")).toBe(true);
    for (const key of ["developer", "contributor", "viewer", "legacy_member"]) expect(has.get(key), key).toBe(false);
  });
});
