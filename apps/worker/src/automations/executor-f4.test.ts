import { randomUUID } from "node:crypto";
import { automationRuns, automations, automationVersions, notifications, projectMembers, projects, roles, tickets, users } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import type { AutomationFlow, Step } from "@stubwise/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { executeDueRuns } from "./executor.js";

/**
 * L'esecutore nella F4 (area 7): una GENERALE agisce nel progetto che il
 * passo dice, coi permessi del proprietario, e solo finché il proprietario ha
 * `automations.general.manage` (ricontrollato a ogni effetto, D5).
 */

let t: TestDb;
let projectId: string;
let code: string;
let ownerId: string;
let generalRoleId: string;
let userRoleId: string;
let seq = 1;

beforeAll(async () => {
  t = await startTestDb();
  const [r] = await t.db.insert(roles).values({ name: `Generali ${randomUUID().slice(0, 6)}`, scope: "instance", permissions: ["automations.general.manage"] }).returning({ id: roles.id });
  generalRoleId = r!.id;
  userRoleId = (await t.db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, "user")))[0]!.id;
}, 120_000);
beforeEach(async () => {
  ({ projectId } = await seedRepository(t.db));
  code = `F${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
  await t.db.update(projects).set({ code }).where(eq(projects.id, projectId));
  ownerId = (await t.db.insert(users).values({ email: `${randomUUID()}@x.it`, passwordHash: "x", role: "member", displayName: "Olga", instanceRoleId: generalRoleId }).returning())[0]!.id;
  const [lead] = await t.db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, "project_lead"));
  await t.db.insert(projectMembers).values({ projectId, userId: ownerId, roleId: lead!.id });
});
afterAll(async () => {
  await t?.stop();
});

const fixedTask = (): Step => ({
  id: `t${seq++}`,
  kind: "createTask",
  title: "Dal generale",
  description: "",
  assignee: null,
  dueInDays: null,
  project: { mode: "fixed", projectId },
  milestoneRef: null,
  approval: { mode: "auto" },
});

async function generalRun(steps: Step[]) {
  const n = 5000 + seq++;
  const flow: AutomationFlow = { trigger: { kind: "manual" }, steps, titleTemplate: "Run" };
  const [a] = await t.db.insert(automations).values({ code: `AUT-${n}`, seq: n, name: `Generale ${n}`, projectId: null, ownerId, status: "active", activeSince: new Date() }).returning();
  await t.db.insert(automationVersions).values({ automationId: a!.id, n: 1, flow, publishedAt: new Date(), publishedBy: ownerId });
  const [run] = await t.db.insert(automationRuns).values({ automationId: a!.id, n: 1, version: 1, title: "Run", origin: "manual", event: {}, projectIds: [] }).returning();
  return { automation: a!, run: run! };
}

const reload = async (id: string) => (await t.db.select().from(automationRuns).where(eq(automationRuns.id, id)))[0]!;

describe("le generali nell'esecutore", () => {
  it("una generale crea la task nel progetto fisso, a nome del proprietario, e il progetto entra fra quelli in cui ha agito", async () => {
    const { run } = await generalRun([fixedTask()]);
    await executeDueRuns({ db: t.db });
    expect(await reload(run.id)).toMatchObject({ status: "done", projectIds: [projectId] });
    expect(await t.db.select().from(tickets).where(eq(tickets.automationRunId, run.id))).toEqual([expect.objectContaining({ projectId, title: "Dal generale" })]);
  });

  it("senza più il permesso delle generali: permission_lost prima dell'effetto, nessuna task, la generale in pausa col suo avviso", async () => {
    const { automation, run } = await generalRun([fixedTask()]);
    await t.db.update(users).set({ instanceRoleId: userRoleId }).where(eq(users.id, ownerId));
    await executeDueRuns({ db: t.db });
    expect(await reload(run.id)).toMatchObject({ status: "failed", error: "permission_lost" });
    expect(await t.db.select().from(tickets).where(eq(tickets.automationRunId, run.id))).toEqual([]);
    expect((await t.db.select().from(automations).where(eq(automations.id, automation.id)))[0]).toMatchObject({ status: "paused", pausedReason: "owner_lost_permission" });
    const cards = (await t.db.select().from(notifications).where(eq(notifications.userId, ownerId))).map((c) => c.kind);
    expect(cards).toContain("automation.paused");
  });
});
