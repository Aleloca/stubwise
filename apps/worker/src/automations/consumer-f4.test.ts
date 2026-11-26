import { randomUUID } from "node:crypto";
import { automationEvents, automationRuns, automations, automationSources, automationVersions, projectMembers, projects, roles, tickets, users } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import type { AutomationFlow } from "@stubwise/shared";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { consumeAutomationEvents } from "./consumer.js";

/**
 * Il consumatore nella F4 (area 7): le GENERALI ascoltano gli eventi di
 * Stubwise di ogni progetto che il proprietario vede, finché ha
 * `automations.general.manage`; l'evento di una SORGENTE (`source_event`, il
 * webhook in arrivo) fa partire l'automazione accesa che ne parte, coi campi
 * proiettati dal server, con origine `source`.
 */

let t: TestDb;
let projectId: string;
let ownerId: string;
let generalRoleId: string;
let n = 1;

beforeAll(async () => {
  t = await startTestDb();
  const [r] = await t.db.insert(roles).values({ name: `Generali ${randomUUID().slice(0, 6)}`, scope: "instance", permissions: ["automations.general.manage"] }).returning({ id: roles.id });
  generalRoleId = r!.id;
}, 120_000);
beforeEach(async () => {
  await t.db.delete(automations);
  await t.db.delete(automationEvents);
  ({ projectId } = await seedRepository(t.db));
  await t.db.update(projects).set({ code: `G${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}` }).where(eq(projects.id, projectId));
  ownerId = (await t.db.insert(users).values({ email: `o-${randomUUID()}@x.it`, passwordHash: "x", role: "member" }).returning())[0]!.id;
  await t.db.update(users).set({ instanceRoleId: generalRoleId }).where(eq(users.id, ownerId));
});
afterAll(async () => {
  await t?.stop();
});

async function member(userId: string, presetKey: string) {
  const [role] = await t.db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, presetKey));
  await t.db.insert(projectMembers).values({ projectId, userId, roleId: role!.id });
}

async function automation(flow: AutomationFlow, over: Partial<typeof automations.$inferInsert> = {}) {
  const seq = 1000 + n++;
  const [a] = await t.db
    .insert(automations)
    .values({ code: `AUT-${seq}`, seq, name: `Auto ${seq}`, projectId: null, ownerId, status: "active", activeSince: new Date(Date.now() - 60_000), ...over })
    .returning();
  await t.db.insert(automationVersions).values({ automationId: a!.id, n: 1, flow, publishedAt: new Date(Date.now() - 60_000), publishedBy: ownerId });
  return a!;
}

const runsOf = (automationId: string) => t.db.select().from(automationRuns).where(eq(automationRuns.automationId, automationId)).orderBy(asc(automationRuns.n));
const onTask: AutomationFlow = { trigger: { kind: "stubwise", event: "task_created" }, steps: [], titleTemplate: "Per {{task.titolo}}" } as AutomationFlow;
let ticketNumber = 1;
const newTask = async () => (await t.db.insert(tickets).values({ projectId, number: ticketNumber++, title: "Contratto", type: "task", priority: "medium", source: "manual" }).returning())[0]!;

describe("le generali sugli eventi di Stubwise", () => {
  it("partono per un evento di un progetto che il proprietario vede, senza progetti in cui hanno già agito", async () => {
    await member(ownerId, "developer");
    const a = await automation(onTask);
    await newTask();
    await consumeAutomationEvents({ db: t.db });
    const [run] = await runsOf(a.id);
    expect(run).toMatchObject({ origin: "stubwise", title: "Per Contratto", projectIds: [] });
  });

  it("non partono per un progetto che il proprietario non vede", async () => {
    const a = await automation(onTask);
    await newTask();
    await consumeAutomationEvents({ db: t.db });
    expect(await runsOf(a.id)).toEqual([]);
  });

  it("non partono se il proprietario non ha più il permesso delle generali", async () => {
    await member(ownerId, "developer");
    const [userRole] = await t.db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, "user"));
    await t.db.update(users).set({ instanceRoleId: userRole!.id }).where(eq(users.id, ownerId));
    const a = await automation(onTask);
    await newTask();
    await consumeAutomationEvents({ db: t.db });
    expect(await runsOf(a.id)).toEqual([]);
  });
});

describe("l'evento di una sorgente (il webhook in arrivo)", () => {
  async function source() {
    const [s] = await t.db.insert(automationSources).values({ kind: "webhook", name: "Ordini", secretHash: randomUUID().replace(/-/g, ""), fields: [{ key: "ordine", label: "Ordine", type: "text" }] }).returning();
    return s!;
  }
  const fromSource = (sourceId: string): AutomationFlow => ({ trigger: { kind: "source", sourceId, event: "webhook" }, steps: [], titleTemplate: "Ordine {{ordine}}" });

  it("fa partire l'automazione accesa che parte da quella sorgente, coi campi dell'evento e origine `source`; non le altre", async () => {
    const s = await source();
    const other = await source();
    const a = await automation(fromSource(s.id));
    const b = await automation(fromSource(other.id));
    await t.db.insert(automationEvents).values({ kind: "source_event", sourceId: s.id, payload: { event: { ordine: "A-12" } } });
    expect(await consumeAutomationEvents({ db: t.db })).toBe(1);
    const [run] = await runsOf(a.id);
    expect(run).toMatchObject({ origin: "source", title: "Ordine A-12", event: { ordine: "A-12" }, parentRunId: null });
    expect(await runsOf(b.id)).toEqual([]);
  });

  it("un'automazione in pausa, o accesa dopo l'evento, non parte", async () => {
    const s = await source();
    const paused = await automation(fromSource(s.id), { status: "paused" });
    await t.db.insert(automationEvents).values({ kind: "source_event", sourceId: s.id, payload: { event: { ordine: "A-1" } } });
    const later = await automation(fromSource(s.id), { activeSince: new Date(Date.now() + 60_000) });
    await consumeAutomationEvents({ db: t.db });
    expect(await runsOf(paused.id)).toEqual([]);
    expect(await runsOf(later.id)).toEqual([]);
  });

  it("una di progetto parte solo se il proprietario vede ancora il progetto", async () => {
    const s = await source();
    const a = await automation(fromSource(s.id), { projectId, code: `${randomUUID().slice(0, 4)}-A1`, seq: 1 });
    await t.db.insert(automationEvents).values({ kind: "source_event", sourceId: s.id, payload: { event: { ordine: "A-1" } } });
    await consumeAutomationEvents({ db: t.db });
    expect(await runsOf(a.id)).toEqual([]);
    await member(ownerId, "project_lead");
    await t.db.insert(automationEvents).values({ kind: "source_event", sourceId: s.id, payload: { event: { ordine: "A-2" } } });
    await consumeAutomationEvents({ db: t.db });
    expect(await runsOf(a.id)).toEqual([expect.objectContaining({ title: "Ordine A-2", projectIds: [projectId] })]);
  });
});
