import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { aiJobs, changeLog, issueChatToolToken, projects } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

/**
 * Area 9, F7, Task 3: le B del progetto. Ogni voce chiama il servizio della
 * sua rotta (le stesse voci del registro), «Annulla» riporta `was` e rifiuta
 * se nel frattempo qualcuno ha salvato a mano QUELLE impostazioni (M-7 = a);
 * su un archiviato tutto è un conflitto, tranne la riapertura.
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
  lead = await createUserWithSession(app, "lead-a9p@example.com");
  dev = await createUserWithSession(app, "dev-a9p@example.com");
}, 120_000);

afterAll(async () => {
  await app.close();
  await t.stop();
});

/** Un progetto nuovo per ogni caso: lo stato di uno non sporca l'altro. */
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
  return app.inject({ method: "POST", url: `/api/claude/conversations/${sid}/proposals`, headers: { authorization: `Bearer ${tok}` }, payload: { toolUseId: `tu-a9p-${++n}`, actions } });
}
/** Propone e conferma: restituisce il gruppo eseguito (o la risposta, se non è partita). */
async function run(actions: unknown[], who = lead) {
  const res = await propose(actions, who);
  const body = res.json() as { status: string; proposalId?: string };
  if (body.status !== "awaiting_confirmation") return { res, groupId: null };
  const done = await app.inject({ method: "POST", url: `/api/claude/proposals/${body.proposalId}/confirm`, headers: { cookie: who.headers.cookie }, payload: {} });
  return { res: done, groupId: (done.json() as { groupId?: string }).groupId ?? null };
}
const undo = (groupId: string, who = lead) => app.inject({ method: "POST", url: `/api/claude/groups/${groupId}/undo`, headers: { cookie: who.headers.cookie } });
const row = async (projectId: string) => (await t.db.select().from(projects).where(eq(projects.id, projectId)))[0]!;
const entries = (projectId: string, type: string) => t.db.select().from(changeLog).where(and(eq(changeLog.projectId, projectId), eq(changeLog.type, type)));
const patch = (projectId: string, payload: Record<string, unknown>) =>
  app.inject({ method: "PATCH", url: `/api/projects/${projectId}`, headers: { cookie: lead.headers.cookie }, payload });

describe("area 9, F7: le B del progetto", () => {
  it("updateProjectGeneral: B, il nome cambia con la sua voce; «Annulla» lo riporta", async () => {
    const projectId = await project();
    const before = (await row(projectId)).name;
    const proposed = await propose([{ fn: "updateProjectGeneral", args: { projectId, name: "Nome da Claude" } }]);
    expect(proposed.json()).toMatchObject({ status: "awaiting_confirmation" });
    const { res, groupId } = await run([{ fn: "updateProjectGeneral", args: { projectId, name: "Nome da Claude" } }]);
    expect(res.statusCode).toBe(200);
    expect((await row(projectId)).name).toBe("Nome da Claude");
    expect(await entries(projectId, "project.renamed")).toHaveLength(1);
    expect((await undo(groupId!)).statusCode).toBe(200);
    expect((await row(projectId)).name).toBe(before);
  });

  it("«Annulla» rifiuta se dopo Claude qualcuno ha salvato a mano le STESSE impostazioni; una sezione diversa non lo blocca", async () => {
    const projectId = await project();
    const a = await run([{ fn: "updateProjectGeneral", args: { projectId, name: "Primo" } }]);
    // Un'altra sezione (la cadenza del pulse): l'annulla del nome passa.
    expect((await patch(projectId, { pulseEveryDays: 9 })).statusCode).toBe(200);
    expect((await undo(a.groupId!)).statusCode).toBe(200);
    const b = await run([{ fn: "updateProjectGeneral", args: { projectId, name: "Secondo" } }]);
    expect((await patch(projectId, { name: "A mano" })).statusCode).toBe(200);
    expect((await undo(b.groupId!)).statusCode).toBe(409);
    expect((await row(projectId)).name).toBe("A mano");
  });

  it("saveProjectAutomations: tutta la sezione, la regola del pulse (K-2) e «Annulla» coi valori di prima", async () => {
    const projectId = await project();
    const was = await row(projectId);
    const switches = { docsNightly: true, dailyReport: true, backlogDiscovery: false, pulse: true, weeklyBrief: false };
    // Il pulse senza la discovery: rifiutata già alla proposta (la prova a secco).
    const refused = await propose([{ fn: "saveProjectAutomations", args: { projectId, switches, pulseEveryDays: 5, correctionCap: 2 } }]);
    expect(refused.json()).toMatchObject({ status: "refused" });
    expect((await row(projectId)).pulseEveryDays).toBe(was.pulseEveryDays);
    const ok = await run([{ fn: "saveProjectAutomations", args: { projectId, switches: { ...switches, backlogDiscovery: true }, pulseEveryDays: 5, correctionCap: 2 } }]);
    expect(await row(projectId)).toMatchObject({ docAutoUpdate: true, dailyReportEnabled: true, backlogEnabled: true, pulseEnabled: true, pulseEveryDays: 5, prCorrectionMaxRounds: 2 });
    expect((await undo(ok.groupId!)).statusCode).toBe(200);
    expect(await row(projectId)).toMatchObject({
      docAutoUpdate: was.docAutoUpdate,
      backlogEnabled: was.backlogEnabled,
      pulseEnabled: was.pulseEnabled,
      pulseEveryDays: was.pulseEveryDays,
      prCorrectionMaxRounds: was.prCorrectionMaxRounds,
    });
  });

  it("setProjectAi: un provider che non esiste è rifiutato; «automatico» si salva e si annulla", async () => {
    const projectId = await project();
    const missing = await run([{ fn: "setProjectAi", args: { projectId, providerId: "6f1c2a52-1d7b-4c3e-9a51-0b6a7f2e1a01", exclusive: true } }]);
    expect(missing.res.json()).toMatchObject({ status: "refused" });
    const ok = await run([{ fn: "setProjectAi", args: { projectId, providerId: null, exclusive: false } }]);
    expect(ok.res.statusCode).toBe(200);
    expect(await row(projectId)).toMatchObject({ aiProviderId: null, aiProviderExclusive: false });
  });

  it("archiveProject: archivia; su un archiviato le altre voci sono un conflitto; riapre con reopenProject e con «Annulla»", async () => {
    const projectId = await project();
    const a = await run([{ fn: "archiveProject", args: { projectId } }]);
    expect(a.res.statusCode).toBe(200);
    expect((await row(projectId)).archivedAt).not.toBeNull();
    expect(await entries(projectId, "project.archived")).toHaveLength(1);
    const onArchived = await propose([{ fn: "pauseQueue", args: { projectId } }]);
    expect(onArchived.json()).toMatchObject({ status: "refused" });
    expect((await undo(a.groupId!)).statusCode).toBe(200);
    expect((await row(projectId)).archivedAt).toBeNull();
    await run([{ fn: "archiveProject", args: { projectId } }]);
    const reopened = await run([{ fn: "reopenProject", args: { projectId } }]);
    expect(reopened.res.statusCode).toBe(200);
    expect((await row(projectId)).archivedAt).toBeNull();
  });

  it("pauseQueue / resumeQueue: la pausa con la sua voce; «Annulla» la toglie", async () => {
    const projectId = await project();
    const p = await run([{ fn: "pauseQueue", args: { projectId } }]);
    expect((await row(projectId)).queuePausedAt).not.toBeNull();
    expect(await entries(projectId, "queue.paused")).toHaveLength(1);
    expect((await undo(p.groupId!)).statusCode).toBe(200);
    expect((await row(projectId)).queuePausedAt).toBeNull();
    expect(await entries(projectId, "queue.resumed")).toHaveLength(1);
  });

  it("retryJob: rimette in coda il job fallito con la voce job.retried, senza «Annulla»", async () => {
    const projectId = await project();
    const tk = (await app.inject({ method: "POST", url: "/api/tasks", headers: { cookie: lead.headers.cookie }, payload: { projectId, title: `Task ${++n}`, type: "bug" } })).json() as { id: string };
    const [failed] = await t.db
      .insert(aiJobs)
      .values({ ticketId: tk.id, status: "failed", finishedAt: new Date(Date.now() - 60_000), createdAt: new Date(Date.now() - 300_000) })
      .returning();
    const r = await run([{ fn: "retryJob", args: { jobId: failed!.id } }]);
    expect(r.res.statusCode).toBe(200);
    const [job] = await t.db.select().from(aiJobs).where(eq(aiJobs.id, failed!.id));
    expect(job!.status).toBe("queued");
    expect(await entries(projectId, "job.retried")).toHaveLength(1);
    expect((await undo(r.groupId!)).statusCode).toBe(409);
  });

  it("NEGATIVI: un Developer (senza project.settings.manage) non può proporre nessuna delle B del progetto", async () => {
    const projectId = await project();
    for (const action of [
      { fn: "archiveProject", args: { projectId } },
      { fn: "pauseQueue", args: { projectId } },
      { fn: "updateProjectGeneral", args: { projectId, name: "No" } },
    ]) {
      const res = await propose([action], dev);
      expect(res.json()).toMatchObject({ status: "refused" });
    }
    expect((await row(projectId)).archivedAt).toBeNull();
  });
});
