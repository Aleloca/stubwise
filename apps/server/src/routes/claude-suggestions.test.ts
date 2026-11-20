import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { agentQuestions, agentRuns, aiJobs, automations, claudeSuggestionDismissals, instanceSettings, notifications, prReleaseNotes, projects, ticketRepositories, tickets, users } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

// Area 10, F7 (D-5 = a): le righe «Claude can help you…». Una riga c'è solo
// se l'azione suggerita passerebbe per chi guarda; «Not now» è per persona e
// per oggetto; un oggetto che chi guarda non vede dà null, mai 404.

let t: TestDb;
let app: ReturnType<typeof buildApp>;
let projectId: string;
let projectCode: string;
let repositoryId: string;
type U = Awaited<ReturnType<typeof createUserWithSession>>;
let lead: U;
let developer: U;
let contributor: U;
let outsider: U;
let n = 0;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40) });
  await seedUsers(app);
  ({ projectId, repositoryId } = await seedRepository(t.db));
  projectCode = (await t.db.select({ code: projects.code }).from(projects).where(eq(projects.id, projectId)))[0]!.code;
  lead = await createUserWithSession(app, "lead-sg@example.com");
  developer = await createUserWithSession(app, "dev-sg@example.com");
  contributor = await createUserWithSession(app, "contrib-sg@example.com");
  outsider = await createUserWithSession(app, "out-sg@example.com");
  await addMember(app, projectId, lead.id, "project_lead");
  await addMember(app, projectId, developer.id, "developer");
  await addMember(app, projectId, contributor.id, "contributor");
}, 120_000);
afterAll(async () => {
  await app.close();
  await t.stop();
});

const suggestion = async (who: U, page: string, objectId?: string) => {
  const q = new URLSearchParams({ page, ...(objectId !== undefined ? { objectId } : {}) });
  const res = await app.inject({ method: "GET", url: `/api/claude/suggestions?${q.toString()}`, headers: { cookie: who.headers.cookie } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { kind: string; params: Record<string, string>; suggestionId: string } | null;
};
const dismiss = (who: U, kind: string, objectId?: string) =>
  app.inject({ method: "POST", url: "/api/claude/suggestions/dismiss", headers: { cookie: who.headers.cookie }, payload: { kind, ...(objectId !== undefined ? { objectId } : {}) } });
async function task(): Promise<{ id: string; code: string }> {
  n += 1;
  const res = await app.inject({ method: "POST", url: "/api/tasks", headers: { cookie: lead.headers.cookie }, payload: { projectId, title: `Task ${n}`, type: "bug" } });
  return res.json() as { id: string; code: string };
}
async function openPr(): Promise<{ objectId: string; ticketId: string; code: string }> {
  const tk = await task();
  const prNumber = 100 + n;
  await t.db.insert(ticketRepositories).values({ ticketId: tk.id, repositoryId, branch: `b-${n}`, prUrl: `https://github.com/acme/demo/pull/${prNumber}`, prNumber, prState: "open" });
  return { objectId: `${repositoryId}:${prNumber}`, ticketId: tk.id, code: tk.code };
}

describe("usage", () => {
  it("la regola di /api/ai-usage/summary: con la spesa del progetto sì, senza no", async () => {
    expect(await suggestion(lead, "usage")).toMatchObject({ kind: "monthSpend", suggestionId: "monthSpend:" });
    expect(await suggestion(contributor, "usage")).toBeNull();
  });
});

describe("automations", () => {
  it("chi ha automations.manage e un progetto senza automazioni: la riga col codice; gli altri no; un progetto invisibile null, non 404", async () => {
    expect(await suggestion(lead, "automations", projectId)).toMatchObject({ kind: "buildAutomation", params: { code: projectCode } });
    expect(await suggestion(developer, "automations", projectId)).toBeNull();
    expect(await suggestion(outsider, "automations", projectId)).toBeNull();
    expect(await suggestion(lead, "automations", randomUUID())).toBeNull();
    expect(await suggestion(lead, "automations", "non-un-uuid")).toBeNull();
  });

  it("un progetto che ha già un'automazione (anche una bozza): niente riga", async () => {
    const other = await seedRepository(t.db);
    await addMember(app, other.projectId, lead.id, "project_lead");
    const [p] = await t.db.select({ code: projects.code }).from(projects).where(eq(projects.id, other.projectId));
    expect(await suggestion(lead, "automations", other.projectId)).toMatchObject({ kind: "buildAutomation", params: { code: p!.code } });
    await t.db.insert(automations).values({ code: `${p!.code}-A1`, seq: 1, name: "Auto", description: "", projectId: other.projectId, status: "draft", createdBy: lead.id });
    expect(await suggestion(lead, "automations", other.projectId)).toBeNull();
  });
});

describe("overview", () => {
  it("una task ferma e nessuna proposta del polso aperta: la riga; con la proposta del polso no; un invisibile null", async () => {
    const other = await seedRepository(t.db);
    await addMember(app, other.projectId, lead.id, "project_lead");
    // Nessuna task ferma: niente riga (non porta mai a «niente di fermo»).
    expect(await suggestion(lead, "overview", other.projectId)).toBeNull();
    const tk = await task();
    // Ferma a mano (la stessa regola di /api/tasks/stalled).
    await t.db.update(tickets).set({ manualStallReason: "Aspetta il fornitore", manualStallSince: new Date() }).where(eq(tickets.id, tk.id));
    expect(await suggestion(lead, "overview", projectId)).toMatchObject({ kind: "whyStalled", params: { code: projectCode } });
    expect(await suggestion(outsider, "overview", projectId)).toBeNull();
    const [card] = await t.db.insert(notifications).values({ userId: lead.id, projectId, kind: "project.pulse", event: {} } as typeof notifications.$inferInsert).returning({ id: notifications.id });
    expect(await suggestion(lead, "overview", projectId)).toBeNull();
    await t.db.update(notifications).set({ status: "handled", handledAt: new Date() }).where(eq(notifications.id, card!.id));
    expect(await suggestion(lead, "overview", projectId)).toMatchObject({ kind: "whyStalled" });
  });
});

describe("pr", () => {
  it("PR aperta, note vuote, chi può scriverle e nessuno aspettato: la riga col codice della task; altrimenti no", async () => {
    const pr = await openPr();
    expect(await suggestion(lead, "pr", pr.objectId)).toMatchObject({ kind: "releaseNotes", params: { code: pr.code } });
    expect(await suggestion(developer, "pr", pr.objectId)).toMatchObject({ kind: "releaseNotes" });
    // Chi non può scrivere le note, chi non vede il progetto, una PR sconosciuta, un id rotto.
    expect(await suggestion(contributor, "pr", pr.objectId)).toBeNull();
    expect(await suggestion(outsider, "pr", pr.objectId)).toBeNull();
    expect(await suggestion(lead, "pr", `${repositoryId}:99999`)).toBeNull();
    expect(await suggestion(lead, "pr", "x:1")).toBeNull();
  });

  it("note già scritte, PR chiusa, un piano da approvare, una domanda aperta: niente riga", async () => {
    const written = await openPr();
    const [, num] = written.objectId.split(":");
    await t.db.insert(prReleaseNotes).values({ repositoryId, prNumber: Number(num), body: "- già scritte", updatedBy: lead.id });
    expect(await suggestion(lead, "pr", written.objectId)).toBeNull();
    const closed = await openPr();
    await t.db.update(ticketRepositories).set({ prState: "merged" }).where(eq(ticketRepositories.ticketId, closed.ticketId));
    expect(await suggestion(lead, "pr", closed.objectId)).toBeNull();
    const plan = await openPr();
    await t.db.insert(aiJobs).values({ ticketId: plan.ticketId, status: "awaiting_plan_approval" } as typeof aiJobs.$inferInsert);
    expect(await suggestion(lead, "pr", plan.objectId)).toBeNull();
    const asked = await openPr();
    const [job] = await t.db.insert(aiJobs).values({ ticketId: asked.ticketId, status: "awaiting_input" } as typeof aiJobs.$inferInsert).returning({ id: aiJobs.id });
    await t.db.insert(agentQuestions).values({ jobId: job!.id, ticketId: asked.ticketId, round: 1, question: "A o B?", options: [{ label: "A" }, { label: "B" }] } as typeof agentQuestions.$inferInsert);
    expect(await suggestion(lead, "pr", asked.objectId)).toBeNull();
  });
});

describe("i limiti di tutte le righe", () => {
  it("«Not now» nasconde QUELLA riga solo a chi l'ha scelto e solo su quell'oggetto", async () => {
    const a = await openPr();
    const b = await openPr();
    expect((await dismiss(lead, "releaseNotes", a.objectId)).statusCode).toBe(204);
    expect((await dismiss(lead, "releaseNotes", a.objectId)).statusCode).toBe(204);
    expect(await suggestion(lead, "pr", a.objectId)).toBeNull();
    expect(await suggestion(lead, "pr", b.objectId)).toMatchObject({ kind: "releaseNotes" });
    expect(await suggestion(developer, "pr", a.objectId)).toMatchObject({ kind: "releaseNotes" });
  });

  it("il budget del mese esaurito: nessuna riga, su nessuna pagina", async () => {
    const pr = await openPr();
    expect(await suggestion(lead, "usage")).not.toBeNull();
    await t.db.insert(instanceSettings).values({ id: 1, monthlyBudgetUsd: "1" }).onConflictDoUpdate({ target: instanceSettings.id, set: { monthlyBudgetUsd: "1" } });
    const [run] = await t.db.insert(agentRuns).values({ phase: "triage", operation: "triage", model: "claude-sonnet-5-5", costUsd: "2" } as typeof agentRuns.$inferInsert).returning({ id: agentRuns.id });
    try {
      expect(await suggestion(lead, "usage")).toBeNull();
      expect(await suggestion(lead, "pr", pr.objectId)).toBeNull();
      expect(await suggestion(lead, "automations", projectId)).toBeNull();
    } finally {
      await t.db.update(instanceSettings).set({ monthlyBudgetUsd: null });
      await t.db.delete(agentRuns).where(eq(agentRuns.id, run!.id));
    }
  });

  it("togliere una persona toglie i suoi «Not now» (CASCADE)", async () => {
    const gone = await createUserWithSession(app, "gone-sg@example.com");
    await addMember(app, projectId, gone.id, "project_lead");
    expect((await dismiss(gone, "monthSpend")).statusCode).toBe(204);
    expect(await t.db.select().from(claudeSuggestionDismissals).where(eq(claudeSuggestionDismissals.userId, gone.id))).toHaveLength(1);
    await t.db.execute(sql`delete from project_members where user_id = ${gone.id}`);
    await t.db.delete(users).where(eq(users.id, gone.id));
    expect(await t.db.select().from(claudeSuggestionDismissals).where(eq(claudeSuggestionDismissals.userId, gone.id))).toEqual([]);
  });
});
