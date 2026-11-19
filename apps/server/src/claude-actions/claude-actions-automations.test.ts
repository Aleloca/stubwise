import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { automations, automationVersions, claudeActionGroups, claudeActions, claudeProposals, issueChatToolToken } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

/**
 * Area 10, F2, Task 2: le bozze di automazione da Claude. Claude crea, salva ed
 * elimina una BOZZA di progetto; non la pubblica né la accende mai
 * (`docs/invariants/automations.md`). `createAutomation` e
 * `saveAutomationDraft` sono A con «Annulla», `deleteAutomationDraft` è B.
 */
let t: TestDb;
let app: ReturnType<typeof buildApp>;
type U = Awaited<ReturnType<typeof createUserWithSession>>;
let lead: U;
let dev: U;
let n = 0;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40), publicUrl: "https://stubwise.example" });
  await seedUsers(app);
  lead = await createUserWithSession(app, "lead-auto@example.com");
  dev = await createUserWithSession(app, "dev-auto@example.com");
}, 120_000);

afterAll(async () => {
  await app.close();
  await t.stop();
});

async function project(): Promise<string> {
  const { projectId } = await seedRepository(t.db);
  await addMember(app, projectId, lead.id, "project_lead");
  await addMember(app, projectId, dev.id, "developer");
  return projectId;
}
async function propose(actions: unknown[], who = lead) {
  const res = await app.inject({ method: "POST", url: "/api/claude/conversations", headers: { cookie: who.headers.cookie }, payload: {} });
  const sid = (res.json() as { id: string }).id;
  const tok = await issueChatToolToken(t.db, { sessionId: sid, userId: who.id, ttlMs: 60_000 });
  return app.inject({ method: "POST", url: `/api/claude/conversations/${sid}/proposals`, headers: { authorization: `Bearer ${tok}` }, payload: { toolUseId: `tu-auto-${++n}`, actions } });
}
/** Propone e (se serve) conferma: il gruppo eseguito, o la risposta se non è partita. */
async function run(actions: unknown[], who = lead) {
  const res = await propose(actions, who);
  const body = res.json() as { status: string; proposalId?: string; groupId?: string };
  if (body.status === "executed") return { res, body, groupId: await groupOfProposal(body.proposalId!) };
  if (body.status !== "awaiting_confirmation") return { res, body, groupId: null };
  const done = await app.inject({ method: "POST", url: `/api/claude/proposals/${body.proposalId}/confirm`, headers: { cookie: who.headers.cookie }, payload: {} });
  return { res: done, body: done.json() as Record<string, unknown>, groupId: (done.json() as { groupId?: string }).groupId ?? null };
}
/** Il gruppo eseguito di una proposta A (la risposta non lo porta). */
async function groupOfProposal(proposalId: string): Promise<string | null> {
  const [p] = await t.db.select({ groupId: claudeProposals.groupId }).from(claudeProposals).where(eq(claudeProposals.id, proposalId));
  return p?.groupId ?? null;
}
const undo = (groupId: string, who = lead) => app.inject({ method: "POST", url: `/api/claude/groups/${groupId}/undo`, headers: { cookie: who.headers.cookie } });
const step = (title: string) => ({ id: "s1", kind: "createTask", title, description: "", assignee: null, dueInDays: null, project: { mode: "own" }, milestoneRef: null, approval: { mode: "auto" } });
const flow = (title = "Richiama il cliente") => ({
  titleTemplate: "Urgente",
  trigger: { kind: "stubwise", event: "request_created", filter: { left: { ref: "richiesta.urgenza" }, op: "is", right: { value: "high" } } },
  steps: [step(title)],
});
const byProject = async (projectId: string) => t.db.select().from(automations).where(eq(automations.projectId, projectId));
const versionsOf = async (automationId: string) => (await t.db.select().from(automationVersions).where(eq(automationVersions.automationId, automationId))).sort((a, b) => a.n - b.n);
const groupOf = async (groupId: string) => {
  const rows = await t.db.select({ id: claudeActions.id }).from(claudeActions).where(eq(claudeActions.groupId, groupId));
  return rows.map((r) => r.id);
};

describe("area 10, F2: le bozze di automazione da Claude", () => {
  it("createAutomation: A, nasce BOZZA spenta di nessuno, la versione porta l'azione; chi l'ha chiesta la può segnare provata; «Annulla» la cancella tutta", async () => {
    const projectId = await project();
    const proposed = await propose([{ fn: "createAutomation", args: { projectId, name: "Urgenti", flow: flow() } }]);
    expect(proposed.json()).toMatchObject({ status: "executed" });
    const [a] = await byProject(projectId);
    expect(a).toMatchObject({ name: "Urgenti", status: "draft", ownerId: null });
    const [v] = await versionsOf(a!.id);
    expect(v).toMatchObject({ n: 1, publishedAt: null, rev: 1 });
    const groupId = (await groupOfProposal((proposed.json() as { proposalId: string }).proposalId))!;
    expect(await groupOf(groupId)).toContain(v!.viaClaudeActionId);
    // La prova del renderer (decisione di 46): chi l'ha chiesta segna la bozza provata.
    const tested = await app.inject({ method: "POST", url: `/api/automations/${a!.code}/tested`, headers: { cookie: lead.headers.cookie }, payload: { version: 1, rev: 1 } });
    expect(tested.statusCode).toBeLessThan(300);
    expect((await undo(groupId)).statusCode).toBe(200);
    expect(await byProject(projectId)).toEqual([]);
  });

  it("solo bozze di PROGETTO, e prima il progetto poi il flusso: senza progetto invalid, senza permesso forbidden, un progetto invisibile not_found anche con un flusso sbagliato", async () => {
    const projectId = await project();
    const hidden = (await seedRepository(t.db)).projectId;
    const refusal = async (args: unknown, who = lead) => (await propose([{ fn: "createAutomation", args }], who)).json() as { status: string; reason?: string; failure?: { code?: string } };
    expect(await refusal({ name: "x", flow: flow() })).toMatchObject({ status: "refused" });
    expect(await refusal({ projectId: null, name: "x", flow: flow() })).toMatchObject({ status: "refused" });
    const forbidden = await refusal({ projectId, name: "x", flow: flow() }, dev);
    expect(forbidden.status).toBe("refused");
    expect(forbidden.reason).toMatch(/can't do action 1/);
    const broken = { ...flow(), steps: [step("")] };
    const unseen = await refusal({ projectId: hidden, name: "x", flow: broken });
    expect(unseen.status).toBe("refused");
    expect(JSON.stringify(unseen)).toMatch(/not.?found/i);
    expect(await byProject(hidden)).toEqual([]);
  });

  it("un flusso con errori di configurazione non diventa una bozza: rifiutata con gli errori, e nessuna riga resta", async () => {
    const projectId = await project();
    const broken = { ...flow(), steps: [step("")] };
    const res = (await propose([{ fn: "createAutomation", args: { projectId, name: "Rotta", flow: broken } }])).json() as { status: string };
    expect(res.status).toBe("refused");
    expect(await byProject(projectId)).toEqual([]);
  });

  it("saveAutomationDraft: A, «Annulla» rimette flusso e nome di prima; su un'accesa senza bozza l'inverso toglie la bozza nuova", async () => {
    const projectId = await project();
    const created = await propose([{ fn: "createAutomation", args: { projectId, name: "Prima", flow: flow("Prima") } }]);
    const [a] = await byProject(projectId);
    const saved = await run([{ fn: "saveAutomationDraft", args: { code: a!.code, flow: flow("Dopo"), expectedRev: 1, name: "Dopo" } }]);
    expect(saved.body).toMatchObject({ status: "executed" });
    const [v1] = await versionsOf(a!.id);
    expect(v1).toMatchObject({ rev: 2 });
    expect((v1!.flow as { steps: { title: string }[] }).steps[0]!.title).toBe("Dopo");
    expect((await undo(saved.groupId!)).statusCode).toBe(200);
    const [back] = await versionsOf(a!.id);
    expect((back!.flow as { steps: { title: string }[] }).steps[0]!.title).toBe("Prima");
    expect((await byProject(projectId))[0]!.name).toBe("Prima");
    expect((created.json() as { status: string }).status).toBe("executed");

    // Accesa senza bozza: il salvataggio apre la versione 2, e «Annulla» la toglie.
    await t.db.update(automationVersions).set({ publishedAt: new Date(), publishedBy: lead.id }).where(eq(automationVersions.automationId, a!.id));
    await t.db.update(automations).set({ status: "active", ownerId: lead.id }).where(eq(automations.id, a!.id));
    const onActive = await run([{ fn: "saveAutomationDraft", args: { code: a!.code, flow: flow("Nuova"), expectedRev: null } }]);
    expect(onActive.body).toMatchObject({ status: "executed" });
    expect(await versionsOf(a!.id)).toHaveLength(2);
    expect((await undo(onActive.groupId!)).statusCode).toBe(200);
    expect(await versionsOf(a!.id)).toHaveLength(1);
  });

  it("expectedRev vecchio: conflitto; «Annulla» non c'è più se qualcuno salva dopo Claude, anche la STESSA persona", async () => {
    const projectId = await project();
    const created = await propose([{ fn: "createAutomation", args: { projectId, name: "A", flow: flow() } }]);
    const [a] = await byProject(projectId);
    // Anche chi ha scritto l'ultima bozza: da Claude la rev deve essere quella di adesso.
    const stale = (await propose([{ fn: "saveAutomationDraft", args: { code: a!.code, flow: flow("x"), expectedRev: 7 } }])).json() as { status: string };
    expect(stale.status).toBe("refused");
    expect(JSON.stringify(stale)).toMatch(/stale|conflict/);
    // La stessa persona salva a mano dal costruttore: la rev sale, l'«Annulla» di Claude cade.
    const manual = await app.inject({ method: "PUT", url: `/api/automations/${a!.code}/draft`, headers: { cookie: lead.headers.cookie }, payload: { flow: flow("A mano"), expectedRev: 1 } });
    expect(manual.statusCode).toBe(200);
    const groupId = (await groupOfProposal((created.json() as { proposalId: string }).proposalId))!;
    // Lo STATO dell'«Annulla» (non solo il rifiuto, che verrebbe anche dalla rev
    // vecchia dell'inverso): `changed_after`, e chi ha scritto dopo.
    const [g] = await t.db.select({ sessionId: claudeActionGroups.sessionId }).from(claudeActionGroups).where(eq(claudeActionGroups.id, groupId));
    const groups = (await app.inject({ method: "GET", url: `/api/claude/conversations/${g!.sessionId}/groups`, headers: { cookie: lead.headers.cookie } })).json() as { id: string; undo: string }[];
    expect(groups.find((x) => x.id === groupId)).toMatchObject({ undo: "changed_after" });
    const res = await undo(groupId);
    expect(res.statusCode).toBe(409);
    expect(await byProject(projectId)).toHaveLength(1);
  });

  it("deleteAutomationDraft: B, e non si annulla", async () => {
    const projectId = await project();
    await propose([{ fn: "createAutomation", args: { projectId, name: "Da togliere", flow: flow() } }]);
    const [a] = await byProject(projectId);
    const proposed = (await propose([{ fn: "deleteAutomationDraft", args: { code: a!.code, expectedRev: 1 } }])).json() as { status: string };
    expect(proposed.status).toBe("awaiting_confirmation");
    const { groupId } = await run([{ fn: "deleteAutomationDraft", args: { code: a!.code, expectedRev: 1 } }]);
    expect(await byProject(projectId)).toEqual([]);
    expect((await undo(groupId!)).statusCode).toBe(409);
  });
});
