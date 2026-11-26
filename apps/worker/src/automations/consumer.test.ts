import { randomUUID } from "node:crypto";
import {
  automationEvents,
  automationRuns,
  automations,
  automationVersions,
  backlogItemRequesters,
  backlogItems,
  backlogItemTickets,
  milestones,
  projectMembers,
  projects,
  roles,
  tickets,
  users,
} from "@stubwise/db";
import { firstStatusOf, seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import type { AutomationFlow } from "@stubwise/shared";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { consumeAutomationEvents, CONSUMER_LOCK_KEY, MAX_ACTIVE_RUNS } from "./consumer.js";

/**
 * Il CONSUMATORE degli eventi (area 7, F1): dall'outbox che scrivono i
 * trigger della 0169 alle esecuzioni. Parte un'automazione ATTIVA del
 * progetto dell'evento, accesa PRIMA dell'evento (niente recupero
 * retroattivo), il cui proprietario vede il progetto, col filtro dell'inizio
 * che passa e la catena che lo consente (niente cicli, al più 3). I campi
 * dell'inizio si compongono dalle righe vere, nell'ordine di Q5.
 */

let t: TestDb;
let projectId: string;
let projectCode: string;
let ownerId: string;
let n = 1;

beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
beforeEach(async () => {
  await t.db.delete(automations);
  await t.db.delete(automationEvents);
  ({ projectId } = await seedRepository(t.db));
  projectCode = `C${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
  await t.db.update(projects).set({ code: projectCode }).where(eq(projects.id, projectId));
  ownerId = (await t.db.insert(users).values({ email: `o-${randomUUID()}@x.it`, passwordHash: "x", role: "member" }).returning())[0]!.id;
  await member(ownerId, "project_lead");
});
afterAll(async () => {
  await t?.stop();
});

async function member(userId: string, presetKey: string) {
  const [role] = await t.db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, presetKey));
  await t.db.insert(projectMembers).values({ projectId, userId, roleId: role!.id }).onConflictDoUpdate({ target: [projectMembers.projectId, projectMembers.userId], set: { roleId: role!.id } });
}

const flowOn = (event: string, filter?: AutomationFlow["trigger"] extends infer T ? (T extends { filter?: infer F } ? F : never) : never): AutomationFlow =>
  ({ trigger: { kind: "stubwise", event, ...(filter ? { filter } : {}) }, steps: [], titleTemplate: "Per {{task.titolo}}" }) as AutomationFlow;

async function automation(flow: AutomationFlow, over: Partial<typeof automations.$inferInsert> = {}) {
  const seq = n++;
  const [a] = await t.db
    .insert(automations)
    .values({ code: `${projectCode}-A${seq}`, seq, name: `Auto ${seq}`, projectId, ownerId, status: "active", activeSince: new Date(Date.now() - 60_000), ...over })
    .returning();
  await t.db.insert(automationVersions).values({ automationId: a!.id, n: 1, flow, publishedAt: new Date(Date.now() - 60_000), publishedBy: ownerId });
  return a!;
}

const runsOf = (automationId: string) => t.db.select().from(automationRuns).where(eq(automationRuns.automationId, automationId)).orderBy(asc(automationRuns.n));
const pendingEvents = async () => (await t.db.select().from(automationEvents)).filter((e) => e.consumedAt === null);
let ticketNumber = 1;
const newTask = async (title = "Contratto") => (await t.db.insert(tickets).values({ projectId, number: ticketNumber++, title, type: "task", priority: "medium", source: "manual", assigneeId: ownerId }).returning())[0]!;

describe("consumeAutomationEvents", () => {
  it("una task creata avvia l'automazione attiva del progetto, coi campi dell'inizio composti dalle righe; l'evento è consumato", async () => {
    const a = await automation(flowOn("task_created"));
    const task = await newTask("Contratto Rossi");
    expect(await consumeAutomationEvents({ db: t.db })).toBe(1);
    const [run] = await runsOf(a.id);
    expect(run).toMatchObject({ n: 1, version: 1, status: "running", origin: "stubwise", parentRunId: null, title: "Per Contratto Rossi", projectIds: [projectId] });
    expect(run!.event).toMatchObject({ task: { codice: `${projectCode}-${task.number}`, titolo: "Contratto Rossi", progetto: projectCode, incaricato: ownerId } });
    expect((run!.event as { task: { stato: string } }).task.stato).not.toBe("");
    expect(await pendingEvents()).toEqual([]);
  });

  it("niente recupero retroattivo: un evento nato prima dell'accensione non avvia, ma si consuma", async () => {
    await newTask();
    const a = await automation(flowOn("task_created"), { activeSince: new Date(Date.now() + 60_000) });
    expect(await consumeAutomationEvents({ db: t.db })).toBe(1);
    expect(await runsOf(a.id)).toEqual([]);
    expect(await pendingEvents()).toEqual([]);
  });

  it("non parte: in pausa, in bozza, senza proprietario, d'un altro evento, d'un altro progetto, o col proprietario che non vede più il progetto", async () => {
    const paused = await automation(flowOn("task_created"), { status: "paused" });
    const draft = await automation(flowOn("task_created"), { status: "draft" });
    const orphan = await automation(flowOn("task_created"), { ownerId: null });
    const otherEvent = await automation(flowOn("task_closed"));
    const { projectId: elsewhere } = await seedRepository(t.db);
    const otherProject = await automation(flowOn("task_created"), { projectId: elsewhere, code: `X${randomUUID().slice(0, 5)}-A1` });
    const strangerId = (await t.db.insert(users).values({ email: `s-${randomUUID()}@x.it`, passwordHash: "x", role: "member" }).returning())[0]!.id;
    const blind = await automation(flowOn("task_created"), { ownerId: strangerId });
    await newTask();
    await consumeAutomationEvents({ db: t.db });
    for (const a of [paused, draft, orphan, otherEvent, otherProject, blind]) expect(await runsOf(a.id), a.name).toEqual([]);
  });

  it("il filtro dell'inizio: parte solo se vale sull'evento", async () => {
    const a = await automation(flowOn("task_created", { left: { ref: "task.titolo" }, op: "contains", right: { value: "Contratto" } }));
    await newTask("Altro");
    await newTask("Contratto Bianchi");
    await consumeAutomationEvents({ db: t.db });
    expect((await runsOf(a.id)).map((r) => (r.event as { task: { titolo: string } }).task.titolo)).toEqual(["Contratto Bianchi"]);
  });

  it("task_closed: l'evento della chiusura avvia chi lo ascolta", async () => {
    const a = await automation(flowOn("task_closed"));
    const task = await newTask();
    await t.db.update(tickets).set({ statusId: await firstStatusOf(t.db, projectId, "closed") }).where(eq(tickets.id, task.id));
    await consumeAutomationEvents({ db: t.db });
    expect(await runsOf(a.id)).toHaveLength(1);
  });

  it("request_created coi dati della richiesta (il richiedente scritto DOPO la riga, nella stessa transazione)", async () => {
    const a = await automation({ ...flowOn("request_created"), titleTemplate: "Richiesta {{richiesta.titolo}}" });
    await t.db.transaction(async (tx) => {
      const [item] = await tx.insert(backlogItems).values({ projectId, title: "Export CSV", document: "Serve l'export", source: "manual", urgency: "high" }).returning();
      await tx.insert(backlogItemRequesters).values({ itemId: item!.id, userId: ownerId });
    });
    await consumeAutomationEvents({ db: t.db });
    const [run] = await runsOf(a.id);
    expect(run!.title).toBe("Richiesta Export CSV");
    expect(run!.event).toMatchObject({ richiesta: { titolo: "Export CSV", descrizione: "Serve l'export", progetto: projectCode, richiedente: ownerId, urgenza: "high", dal_supporto: false } });
    expect((run!.event as { richiesta: { codice: string } }).richiesta.codice).toMatch(new RegExp(`^${projectCode}-R\\d+$`));
  });

  it("Q5: la conversione porta richiesta E task, e si consuma PRIMA della task della stessa transazione", async () => {
    const converted = await automation({ ...flowOn("request_converted"), titleTemplate: "{{richiesta.titolo}} → {{task.codice}}" });
    const created = await automation(flowOn("task_created"));
    const [item] = await t.db.insert(backlogItems).values({ projectId, title: "Da convertire", source: "manual" }).returning();
    await consumeAutomationEvents({ db: t.db });
    const task = await t.db.transaction(async (tx) => {
      const [row] = await tx.insert(tickets).values({ projectId, number: ticketNumber++, title: "Da convertire", type: "task", priority: "medium", source: "manual" }).returning();
      await tx.update(backlogItems).set({ status: "converted" }).where(eq(backlogItems.id, item!.id));
      await tx.insert(backlogItemTickets).values({ itemId: item!.id, ticketId: row!.id, role: "converted_to" });
      return row!;
    });
    await consumeAutomationEvents({ db: t.db });
    const [run] = await runsOf(converted.id);
    expect(run!.title).toBe(`Da convertire → ${projectCode}-${task.number}`);
    expect(await runsOf(created.id)).toHaveLength(1);
    const [c] = await runsOf(converted.id);
    const [d] = await runsOf(created.id);
    expect(c!.startedAt.getTime()).toBeLessThanOrEqual(d!.startedAt.getTime());
  });

  it("milestone_reached col nome e il progetto", async () => {
    const a = await automation({ ...flowOn("milestone_reached"), titleTemplate: "{{traguardo.nome}}" });
    const [m] = await t.db.insert(milestones).values({ projectId, name: "v2" }).returning();
    await t.db.update(milestones).set({ status: "closed" }).where(eq(milestones.id, m!.id));
    await consumeAutomationEvents({ db: t.db });
    expect((await runsOf(a.id))[0]).toMatchObject({ title: "v2", event: { traguardo: { nome: "v2", progetto: projectCode } } });
  });

  it("la catena: un evento scritto da un'esecuzione non riavvia la sua automazione, ne avvia un'altra come figlia, e si ferma a 3", async () => {
    const self = await automation(flowOn("task_created"));
    const other = await automation(flowOn("task_created"));
    const [root] = await t.db.insert(automationRuns).values({ automationId: self.id, n: 99, version: 1, title: "radice", origin: "stubwise", status: "done" }).returning();
    await t.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('stubwise.automation_run_id', ${root!.id}, true)`);
      await tx.insert(tickets).values({ projectId, number: ticketNumber++, title: "figlia", type: "task", priority: "medium", source: "automation", automationRunId: root!.id });
    });
    await consumeAutomationEvents({ db: t.db });
    expect((await runsOf(self.id)).map((r) => r.n)).toEqual([99]);
    const [child] = await runsOf(other.id);
    expect(child).toMatchObject({ parentRunId: root!.id, origin: "automation" });
    // Una catena già di 3 (root → child → nipote) non cresce più.
    const third = await automation(flowOn("task_created"));
    const [grandchild] = await t.db.insert(automationRuns).values({ automationId: third.id, n: 50, version: 1, title: "nipote", origin: "stubwise", status: "done", parentRunId: child!.id }).returning();
    const fourth = await automation(flowOn("task_created"));
    await t.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('stubwise.automation_run_id', ${grandchild!.id}, true)`);
      await tx.insert(tickets).values({ projectId, number: ticketNumber++, title: "pronipote", type: "task", priority: "medium", source: "automation" });
    });
    await consumeAutomationEvents({ db: t.db });
    expect(await runsOf(fourth.id)).toEqual([]);
  });

  it("review F1, I2: un'esecuzione d'origine sparita non blocca il consumo (la figlia nasce senza `parent_run_id`)", async () => {
    const a = await automation(flowOn("task_created"));
    const task = await newTask("Orfana");
    const ghost = randomUUID();
    await t.db.update(automationEvents).set({ originRunId: ghost }).where(eq(automationEvents.objectId, task.id));
    const good = await newTask("Buona");
    const lines: string[] = [];
    await consumeAutomationEvents({ db: t.db, log: (m) => lines.push(m) });
    const runs = await runsOf(a.id);
    expect(runs.map((r) => (r.event as { task: { titolo: string } }).task.titolo).sort()).toEqual(["Buona", "Orfana"]);
    expect(runs.find((r) => (r.event as { task: { titolo: string } }).task.titolo === "Orfana")).toMatchObject({ parentRunId: null, origin: "automation" });
    expect(await pendingEvents()).toEqual([]);
    void good;
  });

  it("review F1, I2: un evento che fa lanciare l'avvio di un'automazione non blocca le altre né gli eventi dopo; si consuma, con una riga nel log", async () => {
    const broken = await automation({ ...flowOn("task_created"), trigger: { kind: "stubwise", event: "task_created", filter: { all: 5 } } } as unknown as AutomationFlow);
    const fine = await automation(flowOn("task_created"));
    await newTask("Uno");
    await newTask("Due");
    const lines: string[] = [];
    await consumeAutomationEvents({ db: t.db, log: (m) => lines.push(m) });
    expect(await runsOf(broken.id)).toEqual([]);
    expect((await runsOf(fine.id)).length).toBe(2);
    expect(await pendingEvents()).toEqual([]);
    expect(lines.filter((l) => l.includes(broken.code))).toHaveLength(2);
  });

  it(`al più ${MAX_ACTIVE_RUNS} esecuzioni aperte per automazione: oltre, l'evento non avvia`, async () => {
    const a = await automation(flowOn("task_created"));
    await t.db.insert(automationRuns).values(Array.from({ length: MAX_ACTIVE_RUNS }, (_, i) => ({ automationId: a.id, n: i + 1, version: 1, title: "aperta", origin: "stubwise" as const, status: "waiting_approval" as const })));
    await newTask();
    await consumeAutomationEvents({ db: t.db });
    expect(await t.db.select({ c: sql<number>`count(*)::int` }).from(automationRuns).where(and(eq(automationRuns.automationId, a.id)))).toEqual([{ c: MAX_ACTIVE_RUNS }]);
  });

  it("due consumatori insieme non avviano due volte lo stesso evento (SKIP LOCKED)", async () => {
    const a = await automation(flowOn("task_created"));
    await newTask();
    await Promise.all([consumeAutomationEvents({ db: t.db }), consumeAutomationEvents({ db: t.db })]);
    expect(await runsOf(a.id)).toHaveLength(1);
  });

  it("review F1, M3: un consumatore alla volta, quindi gli eventi di una stessa transazione non si dividono fra due giri concorrenti", async () => {
    await automation(flowOn("task_created"));
    // Tre task nella STESSA transazione: tre eventi con la stessa txid.
    await t.db.transaction(async (tx) => {
      for (const title of ["A", "B", "C"]) await tx.insert(tickets).values({ projectId, number: ticketNumber++, title, type: "task", priority: "medium", source: "manual" });
    });
    // Il primo consumatore tiene il suo turno aperto: il secondo non prende niente, nemmeno gli eventi oltre il lotto.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const holding = new Promise<void>((r) => (held = r));
    const first = t.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${CONSUMER_LOCK_KEY})`);
      held();
      await gate;
    });
    await holding;
    expect(await consumeAutomationEvents({ db: t.db })).toBe(0);
    release();
    await first;
    expect(await consumeAutomationEvents({ db: t.db })).toBe(3);
  });
});
