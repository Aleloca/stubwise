import { randomUUID } from "node:crypto";
import {
  automationRunInputs,
  automationRunLog,
  automationRuns,
  automations,
  automationVersions,
  googleAccounts,
  googleWorkspaces,
  mailOutgoing,
  projectMembers,
  projects,
  roles,
  tickets,
  users,
} from "@stubwise/db";
import { firstStatusOf, seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import type { AutomationFlow, Step } from "@stubwise/shared";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { consumeAutomationEvents } from "./consumer.js";
import { executeDueRuns } from "./executor.js";
import { wakeReplyWaits } from "./waits.js";

/**
 * LE ATTESE (area 7, F2, S5): un tempo (`due_at`), la risposta a un'email del
 * flusso (SOLO nella stessa conversazione e nella stessa casella) e una task
 * del flusso chiusa. Alla scadenza senza risposta: `risposta.arrivata =
 * false`. Una risposta arrivata in pausa si tiene (F2-6 = a).
 */

const GMAIL_MODIFY = "https://www.googleapis.com/auth/gmail.modify";
const DAY = 86_400_000;
let t: TestDb;
let projectId: string;
let ownerId: string;
let accountId: string;
let seq = 1;

beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});
beforeEach(async () => {
  ({ projectId } = await seedRepository(t.db));
  await t.db.update(projects).set({ code: `W${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}` }).where(eq(projects.id, projectId));
  ownerId = (await t.db.insert(users).values({ email: `${randomUUID()}@x.it`, passwordHash: "x", role: "member", displayName: "Olga" }).returning())[0]!.id;
  const [role] = await t.db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, "project_lead"));
  await t.db.insert(projectMembers).values({ projectId, userId: ownerId, roleId: role!.id });
  const [ws] = await t.db.insert(googleWorkspaces).values({ name: "W", domains: ["acme.com"], clientId: "c", clientSecretEncrypted: "s" }).returning();
  accountId = (await t.db.insert(googleAccounts).values({ userId: ownerId, workspaceId: ws!.id, email: `olga-${randomUUID().slice(0, 6)}@acme.com`, googleSub: randomUUID(), refreshTokenEncrypted: "r", scopes: [GMAIL_MODIFY] }).returning())[0]!.id;
});

const auto = { mode: "auto" } as const;
const email: Step = { id: "mail", kind: "sendEmail", to: "cliente@b.it", subject: "Ciao", body: "Rispondi", attachRefs: [], approval: auto };
const createTask: Step = { id: "task", kind: "createTask", title: "Contratto", description: "", assignee: null, dueInDays: null, project: { mode: "own" }, milestoneRef: null, approval: auto };
const after: Step = { id: "after", kind: "createTask", title: "Dopo: {{risposta.testo}}", description: "", assignee: null, dueInDays: null, project: { mode: "own" }, milestoneRef: null, approval: auto };

async function runOf(steps: Step[]) {
  const n = seq++;
  const flow: AutomationFlow = { trigger: { kind: "manual" }, steps, titleTemplate: "Run" };
  const [a] = await t.db
    .insert(automations)
    .values({ code: `W${n}-A${n}`, seq: n, name: `Auto ${n}`, projectId, ownerId, status: "active", activeSince: new Date(), mailboxAccountId: accountId })
    .returning();
  await t.db.insert(automationVersions).values({ automationId: a!.id, n: 1, flow, publishedAt: new Date(), publishedBy: ownerId });
  const [run] = await t.db.insert(automationRuns).values({ automationId: a!.id, n: 1, version: 1, title: "Run", origin: "manual", event: {}, projectIds: [projectId] }).returning();
  return { automation: a!, run: run! };
}

const exec = (at = new Date()) => executeDueRuns({ db: t.db, now: () => at });
const due = (runId: string) => t.db.update(automationRuns).set({ dueAt: new Date(Date.now() - 1000) }).where(eq(automationRuns.id, runId));
const reload = async (id: string) => (await t.db.select().from(automationRuns).where(eq(automationRuns.id, id)))[0]!;
const logOf = (id: string) => t.db.select().from(automationRunLog).where(eq(automationRunLog.runId, id)).orderBy(asc(automationRunLog.seq));

/** Manda l'email del flusso: il mittente l'ha mandata nella conversazione `thread`. */
async function sendTheEmail(runId: string, thread: string) {
  await exec();
  const [row] = await t.db.select().from(mailOutgoing).where(eq(mailOutgoing.automationRunId, runId));
  await t.db.update(mailOutgoing).set({ state: "sent", gmailMessageId: `gm-${thread}`, gmailThreadId: thread, sentAt: new Date() }).where(eq(mailOutgoing.id, row!.id));
  await due(runId);
  await exec();
}

describe("le attese", () => {
  it("un tempo: in attesa fino a `due_at`; prima non si muove, dopo prosegue", async () => {
    const { run } = await runOf([{ id: "w", kind: "wait", for: { days: 2 } }, createTask]);
    const now = new Date();
    await exec(now);
    const waiting = await reload(run.id);
    expect(waiting.status).toBe("waiting_event");
    expect(Math.abs(waiting.dueAt!.getTime() - (now.getTime() + 2 * DAY))).toBeLessThan(5_000);
    await exec(new Date(now.getTime() + DAY));
    expect((await reload(run.id)).status).toBe("waiting_event");
    await exec(new Date(now.getTime() + 2 * DAY + 60_000));
    expect((await reload(run.id)).status).toBe("done");
  });

  it("la risposta: solo nella STESSA conversazione e nella STESSA casella la sveglia, col testo; dopo l'attesa prosegue", async () => {
    const { run } = await runOf([email, { id: "w", kind: "wait", for: { replyTo: "mail", maxDays: 3 } }, after]);
    await sendTheEmail(run.id, "th-1");
    const waiting = await reload(run.id);
    expect(waiting).toMatchObject({ status: "waiting_event", waitingThread: `${accountId}:th-1` });
    // Un'altra conversazione, un'altra casella: niente.
    expect(await wakeReplyWaits(t.db, { accountId, threadId: "th-altra", text: "no" })).toBe(0);
    expect(await wakeReplyWaits(t.db, { accountId: randomUUID(), threadId: "th-1", text: "no" })).toBe(0);
    expect(await wakeReplyWaits(t.db, { accountId, threadId: "th-1", text: "Va bene, firmo" })).toBe(1);
    await exec();
    const done = await reload(run.id);
    expect(done.status).toBe("done");
    expect(done.vars).toMatchObject({ "risposta.arrivata": true, "risposta.testo": "Va bene, firmo" });
    expect(done).toMatchObject({ waitingThread: null });
    const [created] = await t.db.select().from(tickets).where(eq(tickets.automationRunId, run.id));
    expect(created!.title).toBe("Dopo: Va bene, firmo");
  });

  it("alla scadenza senza risposta: `risposta.arrivata = false`, mai una risposta di prima", async () => {
    const { run } = await runOf([email, { id: "w", kind: "wait", for: { replyTo: "mail", maxDays: 3 } }, after]);
    await sendTheEmail(run.id, "th-2");
    await exec(new Date(Date.now() + 4 * DAY));
    const done = await reload(run.id);
    expect(done.status).toBe("done");
    expect(done.vars).toMatchObject({ "risposta.arrivata": false, "risposta.testo": "" });
    expect((await logOf(run.id)).find((e) => e.kind === "wait" && e.outcome === "ok")?.reason).toContain("3");
  });

  it("una task del flusso chiusa la sveglia (l'evento task_closed, dal consumatore); un'altra task no", async () => {
    const { run } = await runOf([createTask, { id: "w", kind: "wait", for: { taskClosed: "task", maxDays: 5 } }, after]);
    await exec();
    const waiting = await reload(run.id);
    const [mine] = await t.db.select().from(tickets).where(eq(tickets.automationRunId, run.id));
    expect(waiting).toMatchObject({ status: "waiting_event", waitingTicketId: mine!.id });
    const closed = await firstStatusOf(t.db, projectId, "closed");
    // Un'altra task chiusa: niente.
    const [other] = await t.db.insert(tickets).values({ projectId, number: 900 + seq++, title: "Altra", type: "task", priority: "medium", source: "manual" }).returning();
    await t.db.update(tickets).set({ statusId: closed }).where(eq(tickets.id, other!.id));
    await consumeAutomationEvents({ db: t.db });
    await exec();
    expect((await reload(run.id)).status).toBe("waiting_event");
    await t.db.update(tickets).set({ statusId: closed }).where(eq(tickets.id, mine!.id));
    await consumeAutomationEvents({ db: t.db });
    await exec();
    const done = await reload(run.id);
    expect(done.status).toBe("done");
    expect((await logOf(run.id)).find((e) => e.kind === "wait" && e.outcome === "ok")?.output).toEqual({ chiusa: true });
  });

  it("F2-6 = a: una risposta arrivata in PAUSA non si perde; la riprende chi riaccende", async () => {
    const { automation, run } = await runOf([email, { id: "w", kind: "wait", for: { replyTo: "mail", maxDays: 3 } }, after]);
    await sendTheEmail(run.id, "th-3");
    // In pausa: l'attesa si sospende.
    await t.db.update(automations).set({ status: "paused" }).where(eq(automations.id, automation.id));
    await t.db.insert(automationRunInputs).values({ runId: run.id, input: { control: "suspend", byId: ownerId }, byId: ownerId });
    await exec();
    expect((await reload(run.id)).status).toBe("suspended");
    expect(await wakeReplyWaits(t.db, { accountId, threadId: "th-3", text: "Risposta in pausa" })).toBe(1);
    await exec();
    expect((await reload(run.id)).status).toBe("suspended");
    const pending = await t.db.select().from(automationRunInputs).where(eq(automationRunInputs.runId, run.id));
    expect(pending.filter((i) => i.consumedAt === null)).toHaveLength(1);
    // Riaccesa: riprende, e la risposta tenuta vale.
    await t.db.update(automations).set({ status: "active" }).where(eq(automations.id, automation.id));
    await t.db.insert(automationRunInputs).values({ runId: run.id, input: { control: "resume", byId: ownerId }, byId: ownerId });
    await exec();
    await exec();
    const done = await reload(run.id);
    expect(done.status).toBe("done");
    expect(done.vars).toMatchObject({ "risposta.testo": "Risposta in pausa" });
  });
});
