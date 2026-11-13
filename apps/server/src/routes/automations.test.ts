import { randomUUID } from "node:crypto";
import { automationRunInputs, automationRunLog, automationRuns, automations, automationVersions, milestones, projectMembers as projectMembersTable, projects, tickets, type Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { addDepartmentMember, seedDepartment, startTestDb } from "@stubwise/db/testing";
import type { AutomationFlow, Step } from "@stubwise/shared";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

/**
 * LE ROTTE DELLE AUTOMATIONS (area 7, F1): chi può fare cosa (404 a chi non
 * vede il progetto, 403 senza `automations.manage`, e nessuna riga cambiata),
 * i codici, la bozza con `expectedRev`, la pubblicazione (zero errori di
 * configurazione, i permessi del nuovo proprietario, chi pubblica diventa
 * proprietario), la pausa e la riaccensione (input di controllo in coda), e
 * le decisioni sulle esecuzioni, che vanno SOLO in coda e valgono per il
 * passo che aspetta, da chi decide adesso.
 */

let testDb: TestDb;
let db: Db;
let app: FastifyInstance;
let adminCookie: string;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  app = buildApp({ db, sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!", encryptionKey: Buffer.alloc(32, 7).toString("base64") });
  ({ adminCookie } = await seedUsers(app));
}, 120_000);
afterAll(async () => {
  await app.close();
  await testDb.stop();
});

async function project() {
  const code = Array.from({ length: 4 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("");
  const [p] = await db.insert(projects).values({ name: `P ${code}`, code, slug: `p-${randomUUID()}`, ingestionKey: randomUUID() }).returning();
  return { id: p!.id, code };
}
const person = () => createUserWithSession(app, `u-${randomUUID().slice(0, 8)}@acme.com`);
const call = (headers: { cookie: string }, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: object) =>
  app.inject({ method, url: `/api${url}`, headers, ...(payload ? { payload } : {}) });

const auto = { mode: "auto" } as const;
const createTask = (over: Partial<Extract<Step, { kind: "createTask" }>> = {}): Step => ({
  id: `t-${randomUUID().slice(0, 6)}`,
  kind: "createTask",
  title: "Una task",
  description: "",
  assignee: null,
  dueInDays: null,
  project: { mode: "own" },
  milestoneRef: null,
  approval: auto,
  ...over,
});
const flowOf = (steps: Step[]): AutomationFlow => ({ trigger: { kind: "manual" }, steps, titleTemplate: "Run" });

async function setup() {
  const p = await project();
  const lead = await person();
  const dev = await person();
  const contributor = await person();
  const outsider = await person();
  await addMember(app, p.id, lead.id, "project_lead");
  await addMember(app, p.id, dev.id, "developer");
  await addMember(app, p.id, contributor.id, "contributor");
  return { p, lead, dev, contributor, outsider };
}

async function created(lead: { headers: { cookie: string } }, projectId: string, flow?: AutomationFlow) {
  const res = await call(lead.headers, "POST", "/automations", { name: "Onboarding", projectId, ...(flow ? { flow } : {}) });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; code: string; versions: { n: number; rev: number }[] };
}

describe("chi può fare cosa", () => {
  it("senza automations.manage (Developer, Contributor): 403 su ogni scrittura e nessuna riga cambiata; chi non vede il progetto: 404, come un codice che non esiste", async () => {
    const { p, lead, dev, contributor, outsider } = await setup();
    const a = await created(lead, p.id);
    const before = await db.select().from(automations).where(eq(automations.id, a.id));
    for (const who of [dev, contributor]) {
      expect((await call(who.headers, "POST", "/automations", { name: "X", projectId: p.id })).statusCode).toBe(403);
      expect((await call(who.headers, "PATCH", `/automations/${a.code}`, { name: "Rinominata" })).statusCode).toBe(403);
      expect((await call(who.headers, "PUT", `/automations/${a.code}/draft`, { flow: flowOf([]), expectedRev: 1 })).statusCode).toBe(403);
      expect((await call(who.headers, "POST", `/automations/${a.code}/publish`, {})).statusCode).toBe(403);
      // Leggere sì: è membro del progetto.
      expect((await call(who.headers, "GET", `/automations/${a.code}`)).statusCode).toBe(200);
    }
    expect(await db.select().from(automations).where(eq(automations.id, a.id))).toEqual(before);
    expect((await call(outsider.headers, "GET", `/automations/${a.code}`)).statusCode).toBe(404);
    expect((await call(outsider.headers, "PATCH", `/automations/${a.code}`, { name: "X" })).statusCode).toBe(404);
    expect((await call(outsider.headers, "GET", `/automations/NOPE-A999`)).statusCode).toBe(404);
    expect((await call(outsider.headers, "GET", `/automations`)).json()).toEqual({ items: [] });
    // Un full admin è membro implicito di ogni progetto.
    expect((await call({ cookie: adminCookie }, "GET", `/automations/${a.code}`)).statusCode).toBe(200);
  });
});

describe("i codici e la bozza", () => {
  it("due creazioni insieme prendono codici diversi; una bozza eliminata non libera il suo", async () => {
    const { p, lead } = await setup();
    const [x, y] = await Promise.all([created(lead, p.id), created(lead, p.id)]);
    expect(new Set([x.code, y.code]).size).toBe(2);
    expect((await call(lead.headers, "DELETE", `/automations/${y.code}/draft`)).statusCode).toBe(204);
    const z = await created(lead, p.id);
    expect([x.code, y.code]).not.toContain(z.code);
    expect(z.code).toBe(`${p.code}-A3`);
  });

  it("expectedRev: un'altra persona ha salvato dopo → 409 stale col rev attuale; i salvataggi propri di fila passano", async () => {
    const { p, lead } = await setup();
    const other = await person();
    await addMember(app, p.id, other.id, "project_lead");
    const a = await created(lead, p.id);
    const first = await call(lead.headers, "PUT", `/automations/${a.code}/draft`, { flow: flowOf([createTask()]), expectedRev: 1 });
    expect(first.statusCode).toBe(200);
    const rev = (first.json() as { versions: { rev: number }[] }).versions.at(-1)!.rev;
    expect(rev).toBe(2);
    // Lo stesso autore, di fila, anche con un rev vecchio.
    expect((await call(lead.headers, "PUT", `/automations/${a.code}/draft`, { flow: flowOf([]), expectedRev: 1 })).statusCode).toBe(200);
    const stale = await call(other.headers, "PUT", `/automations/${a.code}/draft`, { flow: flowOf([]), expectedRev: 1 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "stale", rev: 3 });
  });

  it("rinominare non crea una bozza", async () => {
    const { p, lead } = await setup();
    const a = await created(lead, p.id, flowOf([createTask()]));
    await call(lead.headers, "POST", `/automations/${a.code}/publish`, {});
    const res = await call(lead.headers, "PATCH", `/automations/${a.code}`, { name: "Nuovo nome" });
    expect(res.json()).toMatchObject({ name: "Nuovo nome" });
    expect((res.json() as { versions: unknown[] }).versions).toHaveLength(1);
  });
});

describe("pubblicare e accendere", () => {
  it("con un errore di configurazione (un passo fuori dalla fetta 1) → 409 config con gli issues, e niente cambia", async () => {
    const { p, lead } = await setup();
    const email: Step = { id: "e1", kind: "sendEmail", to: "a@b.it", subject: "x", body: "y", attachRefs: [], approval: auto };
    const a = await created(lead, p.id, flowOf([email]));
    const res = await call(lead.headers, "POST", `/automations/${a.code}/publish`, {});
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "config" });
    expect((res.json() as { issues: { code: string }[] }).issues.map((i) => i.code)).toContain("not_available");
    expect((await db.select().from(automations).where(eq(automations.id, a.id)))[0]).toMatchObject({ status: "draft", ownerId: null });
    // /check dice lo stesso su un flusso non salvato.
    const check = await call(lead.headers, "POST", `/automations/${a.code}/check`, { flow: flowOf([email]) });
    expect((check.json() as { issues: { code: string }[] }).issues.map((i) => i.code)).toContain("not_available");
  });

  it("chi pubblica diventa il proprietario, e da lì ascolta (active_since); senza il permesso di creare dove il flusso crea → 409 permission", async () => {
    const { p, lead } = await setup();
    const q = await project();
    await addMember(app, q.id, lead.id, "viewer");
    const fixed = await created(lead, p.id, flowOf([createTask({ project: { mode: "fixed", projectId: q.id } })]));
    const denied = await call(lead.headers, "POST", `/automations/${fixed.code}/publish`, {});
    expect(denied.statusCode).toBe(409);
    expect(denied.json()).toMatchObject({ code: "permission", permission: "tickets.create", projectId: q.id });
    const ok = await created(lead, p.id, flowOf([createTask()]));
    const res = await call(lead.headers, "POST", `/automations/${ok.code}/publish`, { expectedRev: 1 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "active", ownerId: lead.id });
    const [row] = await db.select().from(automations).where(eq(automations.id, ok.id));
    expect(row!.activeSince).toBeInstanceOf(Date);
    expect((await call(lead.headers, "POST", `/automations/${ok.code}/publish`, {})).json()).toMatchObject({ code: "no_draft" });
  });

  it("la pausa mette in coda la sospensione delle esecuzioni ferme; la riaccensione la ripresa delle sospese", async () => {
    const { p, lead } = await setup();
    const a = await created(lead, p.id, flowOf([createTask()]));
    await call(lead.headers, "POST", `/automations/${a.code}/publish`, {});
    const [waiting] = await db.insert(automationRuns).values({ automationId: a.id, n: 1, version: 1, title: "R", origin: "manual", status: "waiting_approval" }).returning();
    const paused = await call(lead.headers, "POST", `/automations/${a.code}/pause`);
    expect(paused.json()).toMatchObject({ status: "paused", pausedById: lead.id });
    expect((await db.select().from(automationRunInputs).where(eq(automationRunInputs.runId, waiting!.id))).map((i) => i.input)).toEqual([{ control: "suspend", byId: lead.id }]);
    expect((await db.select().from(automations).where(eq(automations.id, a.id)))[0]!.activeSince).toBeNull();
    await db.update(automationRuns).set({ status: "suspended" }).where(eq(automationRuns.id, waiting!.id));
    const back = await call(lead.headers, "POST", `/automations/${a.code}/activate`, {});
    expect(back.json()).toMatchObject({ status: "active", ownerId: lead.id });
    const inputs = (await db.select().from(automationRunInputs).where(eq(automationRunInputs.runId, waiting!.id))).map((i) => i.input);
    expect(inputs).toContainEqual({ control: "resume", byId: lead.id });
  });
});

describe("le esecuzioni e le decisioni", () => {
  async function waitingRun(who: Step["kind"] extends never ? never : { owner: true } | { personId: string } | { projectRole: string }) {
    const s = await setup();
    const a = await created(s.lead, s.p.id, flowOf([createTask({ approval: { mode: "ask", who } })]));
    await call(s.lead.headers, "POST", `/automations/${a.code}/publish`, {});
    const [run] = await db
      .insert(automationRuns)
      .values({ automationId: a.id, n: 1, version: 1, title: "R", origin: "manual", status: "waiting_approval", cursor: { path: "0" }, pending: { approverIds: [], preview: {}, path: "0", round: 0 } })
      .returning();
    return { ...s, a, run: run! };
  }
  const inputsOf = (runId: string) => db.select().from(automationRunInputs).where(eq(automationRunInputs.runId, runId));

  it("approva solo chi decide ADESSO; un passo diverso o un giro diverso → 409 stale; e la decisione va SOLO in coda", async () => {
    const { a, run, lead, dev } = await waitingRun({ projectRole: "project_lead" });
    expect((await call(dev.headers, "POST", `/automations/${a.code}/runs/1/approve`, { expectedPath: "0" })).statusCode).toBe(403);
    expect((await call(lead.headers, "POST", `/automations/${a.code}/runs/1/approve`, { expectedPath: "1" })).json()).toMatchObject({ code: "stale" });
    expect((await call(lead.headers, "POST", `/automations/${a.code}/runs/1/approve`, { expectedPath: "0", expectedRound: 1 })).json()).toMatchObject({ code: "stale" });
    expect(await inputsOf(run.id)).toEqual([]);
    expect((await call(lead.headers, "POST", `/automations/${a.code}/runs/1/approve`, { expectedPath: "0" })).statusCode).toBe(204);
    expect((await inputsOf(run.id)).map((i) => i.input)).toEqual([{ kind: "approved", path: "0", byId: lead.id }]);
    // L'esecuzione resta com'è: la muove il worker.
    expect((await db.select().from(automationRuns).where(eq(automationRuns.id, run.id)))[0]!.status).toBe("waiting_approval");
    // Una seconda decisione sullo stesso passo, prima che il worker applichi la prima: stale.
    expect((await call(lead.headers, "POST", `/automations/${a.code}/runs/1/reject`, { expectedPath: "0" })).json()).toMatchObject({ code: "stale" });
  });

  it("un ex approvatore (non ha più il ruolo) → 403; sospesa → 409 suspended; chi non la vede → 404", async () => {
    const { a, run, lead, outsider, p } = await waitingRun({ projectRole: "project_lead" });
    await addMember(app, p.id, lead.id, "developer");
    expect((await call(lead.headers, "POST", `/automations/${a.code}/runs/1/approve`, { expectedPath: "0" })).statusCode).toBe(403);
    await addMember(app, p.id, lead.id, "project_lead");
    await db.update(automationRuns).set({ status: "suspended" }).where(eq(automationRuns.id, run.id));
    expect((await call(lead.headers, "POST", `/automations/${a.code}/runs/1/approve`, { expectedPath: "0" })).json()).toMatchObject({ code: "suspended" });
    expect((await call(outsider.headers, "GET", `/automations/${a.code}/runs/1`)).statusCode).toBe(404);
    expect((await call(outsider.headers, "POST", `/automations/${a.code}/runs/1/approve`, { expectedPath: "0" })).statusCode).toBe(404);
  });

  it("il dettaglio dice chi decide e cosa può fare chi guarda; l'elenco globale filtra per progetto visibile", async () => {
    const { a, lead, dev, outsider } = await waitingRun({ owner: true });
    const detail = (await call(lead.headers, "GET", `/automations/${a.code}/runs/1`)).json();
    expect(detail).toMatchObject({ code: `${a.code} #1`, deciders: [lead.id], ownerId: lead.id, permissions: { manage: true, approve: true, chooseProject: false }, round: 0 });
    expect((await call(dev.headers, "GET", `/automations/${a.code}/runs/1`)).json()).toMatchObject({ permissions: { manage: false, approve: false } });
    expect(((await call(lead.headers, "GET", `/automation-runs?automation=${a.code}`)).json() as { items: { code: string }[] }).items.map((r) => r.code)).toEqual([`${a.code} #1`]);
    expect((await call(outsider.headers, "GET", `/automation-runs?automation=${a.code}`)).json()).toMatchObject({ items: [] });
  });

  it("Annulla/Riprova/Salta: chi gestisce; Riprova su un'esecuzione in attesa → 409 not_failed; vanno in coda", async () => {
    const { a, run, lead, dev } = await waitingRun({ owner: true });
    expect((await call(dev.headers, "POST", `/automations/${a.code}/runs/1/cancel`)).statusCode).toBe(403);
    expect((await call(lead.headers, "POST", `/automations/${a.code}/runs/1/retry`)).json()).toMatchObject({ code: "not_failed" });
    expect((await call(lead.headers, "POST", `/automations/${a.code}/runs/1/cancel`)).statusCode).toBe(204);
    expect((await inputsOf(run.id)).map((i) => i.input)).toEqual([{ control: "cancel", byId: lead.id }]);
  });

  it("«Run now»: un'esecuzione manuale dovuta, che il client legge subito", async () => {
    const { p, lead } = await setup();
    const a = await created(lead, p.id, flowOf([createTask()]));
    await call(lead.headers, "POST", `/automations/${a.code}/publish`, {});
    const res = await call(lead.headers, "POST", `/automations/${a.code}/runs`, {});
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ n: 1, status: "running", origin: "manual", code: `${a.code} #1` });
    const [row] = await db.select().from(automationRuns).where(and(eq(automationRuns.automationId, a.id), eq(automationRuns.n, 1)));
    expect(row).toMatchObject({ startedBy: lead.id });
  });

  it("review F1, I4: «Run now» con un evento a mano: solo i campi dell'inizio, valori semplici e un tetto; per un inizio non manuale chi avvia passa i controlli di chi pubblica", async () => {
    const { p, lead } = await setup();
    const other = await person();
    await addMember(app, p.id, other.id, "project_lead");
    const q = await project();
    await addMember(app, q.id, lead.id, "project_lead");
    const flow: AutomationFlow = { trigger: { kind: "stubwise", event: "task_created" }, steps: [createTask({ project: { mode: "fixed", projectId: q.id } })], titleTemplate: "Per {{task.titolo}}" };
    const a = await created(lead, p.id, flow);
    expect((await call(lead.headers, "POST", `/automations/${a.code}/publish`, {})).statusCode).toBe(200);
    const runs = async () => (await db.select().from(automationRuns).where(eq(automationRuns.automationId, a.id))).length;
    // Chi non può creare dove il flusso crea non inietta dati in un'esecuzione a nome del proprietario.
    const denied = await call(other.headers, "POST", `/automations/${a.code}/runs`, { event: { task: { titolo: "Iniettata" } } });
    expect(denied.statusCode).toBe(409);
    expect(denied.json()).toMatchObject({ code: "permission" });
    // Un campo che l'inizio non ha, un valore non semplice, un testo troppo lungo → 400.
    for (const event of [{ task: { titolo: "x", segreto: "y" } }, { task: { titolo: { nested: true } } }, { task: { titolo: "x".repeat(20_000) } }, { altro: 1 }]) {
      expect((await call(lead.headers, "POST", `/automations/${a.code}/runs`, { event })).statusCode).toBe(400);
    }
    expect(await runs()).toBe(0);
    // Il proprietario, coi campi dell'inizio: parte.
    const ok = await call(lead.headers, "POST", `/automations/${a.code}/runs`, { event: { task: { titolo: "Contratto", codice: "X-1" } } });
    expect(ok.statusCode).toBe(201);
    expect(await runs()).toBe(1);
  });

  it("/tested: segna la revisione provata; una revisione vecchia → 409 stale", async () => {
    const { p, lead } = await setup();
    const a = await created(lead, p.id, flowOf([createTask()]));
    expect((await call(lead.headers, "POST", `/automations/${a.code}/tested`, { version: 1, rev: 1 })).statusCode).toBe(204);
    expect((await db.select().from(automationVersions).where(eq(automationVersions.automationId, a.id)))[0]!.testedRev).toBe(1);
    expect((await call(lead.headers, "POST", `/automations/${a.code}/tested`, { version: 1, rev: 0 })).json()).toMatchObject({ code: "stale", rev: 1 });
  });
});

describe("le letture personali e la card d'inbox", () => {
  async function waiting() {
    const s = await setup();
    const a = await created(s.lead, s.p.id, flowOf([createTask({ approval: { mode: "ask", who: { projectRole: "project_lead" } } })]));
    await call(s.lead.headers, "POST", `/automations/${a.code}/publish`, {});
    const [run] = await db
      .insert(automationRuns)
      .values({ automationId: a.id, n: 1, version: 1, title: "Contratto", origin: "manual", status: "waiting_approval", cursor: { path: "0" }, pending: { approverIds: [], preview: { titolo: "X" }, path: "0", round: 0 } })
      .returning();
    return { ...s, a, run: run! };
  }

  it("«Da decidere» elenca solo ciò che aspetta chi chiama ADESSO; il blocco Home dice perché", async () => {
    const { a, lead, dev } = await waiting();
    const mine = (await call(lead.headers, "GET", "/me/automation-approvals")).json() as { items: { code: string; kind: string; cursor: string; round: number; stepKind: string }[] };
    expect(mine.items).toEqual([expect.objectContaining({ code: `${a.code} #1`, kind: "approval", cursor: "0", round: 0, stepKind: "createTask" })]);
    expect((await call(dev.headers, "GET", "/me/automation-approvals")).json()).toEqual({ items: [] });
    const home = (await call(lead.headers, "GET", "/me/automation-runs")).json() as { items: { code: string; concern: string }[] };
    expect(home.items).toEqual([expect.objectContaining({ code: `${a.code} #1`, concern: "waiting_me" })]);
    expect((await call(dev.headers, "GET", "/me/automation-runs")).json()).toEqual({ items: [] });
  });

  it("review F1, I5 e renderer: «Da decidere» filtra sul progetto dell'APPROVAZIONE (un destinatario fisso che vede solo quello la trova); una decisione già in coda la toglie", async () => {
    const { p, lead } = await setup();
    const q = await project();
    await addMember(app, q.id, lead.id, "project_lead");
    const approver = await person();
    await addMember(app, q.id, approver.id, "developer");
    const a = await created(lead, p.id, flowOf([createTask({ project: { mode: "fixed", projectId: q.id }, approval: { mode: "ask", who: { personId: approver.id } } })]));
    expect((await call(lead.headers, "POST", `/automations/${a.code}/publish`, {})).statusCode).toBe(200);
    const [run] = await db
      .insert(automationRuns)
      .values({ automationId: a.id, n: 1, version: 1, title: "Altrove", origin: "manual", status: "waiting_approval", cursor: { path: "0" }, pending: { approverIds: [approver.id], preview: { titolo: "X", progetto: q.id }, path: "0", round: 0 } })
      .returning();
    const list = async () => ((await call(approver.headers, "GET", "/me/automation-approvals")).json() as { items: { code: string; projectId: string | null }[] }).items;
    expect(await list()).toEqual([expect.objectContaining({ code: `${a.code} #1`, projectId: q.id })]);
    await db.insert(automationRunInputs).values({ runId: run!.id, input: { kind: "approved", path: "0", byId: approver.id }, byId: approver.id });
    expect(await list()).toEqual([]);
  });

  it("la card automation.approval: derivata a lettura — aspetta me finché il passo aspetta; deciso, lo dice; chi non la vede: objectGone", async () => {
    const { a, run, lead, p } = await waiting();
    const second = await person();
    await addMember(app, p.id, second.id, "project_lead");
    const { publishNotification } = await import("@stubwise/notifications");
    for (const who of [lead.id, second.id]) {
      await publishNotification(
        db,
        { kind: "automation.approval", projectId: p.id, automationId: a.id, automationCode: a.code, automationName: "Onboarding", runId: run.id, runNumber: 1, path: "0" },
        { projectId: p.id, accountUserId: who },
      );
    }
    const cardOf = async (h: { cookie: string }) =>
      ((await call(h, "GET", "/inbox")).json() as { items: { kind: string; automation: unknown; objectGone: boolean }[] }).items.find((i) => i.kind === "automation.approval");
    expect(await cardOf(second.headers)).toMatchObject({ objectGone: false, automation: { automationCode: a.code, runCode: `${a.code} #1`, waitingOnYou: true, decided: false } });
    // Un ex approvatore (non ha più il ruolo, resta membro): la card non aspetta più lui.
    await addMember(app, p.id, second.id, "developer");
    expect(await cardOf(second.headers)).toMatchObject({ automation: { waitingOnYou: false, decided: false } });
    await addMember(app, p.id, second.id, "project_lead");
    // Uno decide (il worker ha mosso l'esecuzione): la card dell'altro lo dice.
    await db.update(automationRuns).set({ status: "done", cursor: { path: null } }).where(eq(automationRuns.id, run.id));
    expect(await cardOf(second.headers)).toMatchObject({ automation: { waitingOnYou: false, decided: true, runStatus: "done" } });
    // L'automazione eliminata: la card resta, ma senza oggetto (né link).
    await db.delete(automations).where(eq(automations.id, a.id));
    expect(await cardOf(lead.headers)).toMatchObject({ objectGone: true, automation: null });
    // Uscito dal progetto: la card non gli arriva più affatto (il filtro di visibilità dell'inbox).
    await db.delete(projectMembersTable).where(and(eq(projectMembersTable.projectId, p.id), eq(projectMembersTable.userId, second.id)));
    expect(await cardOf(second.headers)).toBeUndefined();
  });
});

describe("la sezione del progetto e la riga d'origine", () => {
  it("la sezione: le automazioni e le esecuzioni aperte del progetto, canCreate con automations.manage; 404 a chi non lo vede", async () => {
    const { p, lead, dev, outsider } = await setup();
    const a = await created(lead, p.id, flowOf([createTask()]));
    await db.insert(automationRuns).values({ automationId: a.id, n: 1, version: 1, title: "Aperta", origin: "manual", status: "waiting_approval" });
    await db.insert(automationRuns).values({ automationId: a.id, n: 2, version: 1, title: "Finita", origin: "manual", status: "done" });
    const view = (await call(lead.headers, "GET", `/projects/${p.id}/automations`)).json();
    expect(view).toMatchObject({ show: true, canCreate: true, general: [] });
    expect((view as { runs: { title: string }[] }).runs.map((r) => r.title)).toEqual(["Aperta"]);
    expect((view as { automations: { code: string }[] }).automations.map((x) => x.code)).toEqual([a.code]);
    expect((await call(dev.headers, "GET", `/projects/${p.id}/automations`)).json()).toMatchObject({ canCreate: false, show: true });
    expect((await call(outsider.headers, "GET", `/projects/${p.id}/automations`)).statusCode).toBe(404);
  });

  it("l'origine di una task creata da un'esecuzione: codice, nome, numero e la riga del registro; chi non vede il progetto: 404; una task non creata da un'automazione: 404", async () => {
    const { p, lead, outsider } = await setup();
    const a = await created(lead, p.id, flowOf([createTask()]));
    const [run] = await db.insert(automationRuns).values({ automationId: a.id, n: 3, version: 1, title: "R", origin: "manual", status: "done" }).returning();
    const [t] = await db.insert(tickets).values({ projectId: p.id, number: 41, title: "Creata", type: "task", priority: "medium", source: "automation", automationRunId: run!.id }).returning();
    await db.insert(automationRunLog).values({ runId: run!.id, seq: 1, stepId: "s", path: "0", kind: "createTask", outcome: "ok", effects: [{ kind: "task", code: `${p.code}-41` }] });
    expect((await call(lead.headers, "GET", `/automation-origin?task=${p.code}-41`)).json()).toEqual({ visible: true, code: a.code, name: "Onboarding", n: 3, entry: "0" });
    expect((await call(outsider.headers, "GET", `/automation-origin?task=${p.code}-41`)).statusCode).toBe(404);
    await db.insert(tickets).values({ projectId: p.id, number: 42, title: "A mano", type: "task", priority: "medium", source: "manual" });
    expect((await call(lead.headers, "GET", `/automation-origin?task=${p.code}-42`)).statusCode).toBe(404);
    void t;
    // Una task in un progetto che vedo, creata da un'automazione di un progetto che NON vedo: solo «da un'automazione».
    const q = await project();
    const qMember = await person();
    await addMember(app, q.id, qMember.id, "developer");
    await db.insert(tickets).values({ projectId: q.id, number: 1, title: "Altrove", type: "task", priority: "medium", source: "automation", automationRunId: run!.id });
    expect((await call(qMember.headers, "GET", `/automation-origin?task=${q.code}-1`)).json()).toEqual({ visible: false });
  });
});

describe("la prova: gli esempi e il contesto", () => {
  it("un inizio di Stubwise: gli oggetti veri più recenti che passano il filtro, coi campi dell'esecuzione; un avvio a mano: la data di oggi", async () => {
    const { p, lead, dev } = await setup();
    const flow: AutomationFlow = {
      trigger: { kind: "stubwise", event: "task_created", filter: { left: { ref: "task.titolo" }, op: "contains", right: { value: "Contratto" } } },
      steps: [createTask()],
      titleTemplate: "R",
    };
    const a = await created(lead, p.id, flow);
    await db.insert(tickets).values([
      { projectId: p.id, number: 7, title: "Contratto Rossi", type: "task", priority: "medium", source: "manual" },
      { projectId: p.id, number: 8, title: "Altro", type: "task", priority: "medium", source: "manual" },
    ]);
    const view = (await call(lead.headers, "GET", `/automations/${a.code}/examples?version=draft`)).json() as { items: { label: string; code: string; event: { task: { codice: string; progetto: string } } }[] };
    expect(view.items.map((i) => i.label)).toEqual(["Contratto Rossi"]);
    expect(view.items[0]).toMatchObject({ code: `${p.code}-7`, event: { task: { codice: `${p.code}-7`, progetto: p.code } } });
    expect((await call(dev.headers, "GET", `/automations/${a.code}/examples?version=draft`)).statusCode).toBe(403);
    const manual = await created(lead, p.id, flowOf([createTask()]));
    const today = new Date().toISOString().slice(0, 10);
    expect((await call(lead.headers, "GET", `/automations/${manual.code}/examples?version=1`)).json()).toMatchObject({ items: [{ label: today, event: { avvio: { data: today } } }] });
  });

  it("review F1, I3: per una versione non pubblicata il proprietario che avrebbe è chi prova (pubblicando lo diventa), e un progetto che non vede non dice niente del proprietario attuale", async () => {
    const { p, lead } = await setup();
    const other = await person();
    await addMember(app, p.id, other.id, "project_lead");
    const q = await project();
    await addMember(app, q.id, lead.id, "project_lead");
    // `lead` pubblica e resta proprietario; `other` scrive una bozza che crea in Q, chiedendo al proprietario.
    const a = await created(lead, p.id, flowOf([createTask()]));
    expect((await call(lead.headers, "POST", `/automations/${a.code}/publish`, {})).statusCode).toBe(200);
    const flow = flowOf([createTask({ project: { mode: "fixed", projectId: q.id }, approval: { mode: "ask", who: { owner: true } } })]);
    expect((await call(other.headers, "PUT", `/automations/${a.code}/draft`, { flow, expectedRev: null })).statusCode).toBe(200);
    const ctx = ((await call(other.headers, "GET", `/automations/${a.code}/examples?version=draft`)).json() as { context: { ownerId: string; projects: { id: string; seenBy: string[]; ownerCan: Record<string, boolean>; gone: boolean }[] } }).context;
    expect(ctx.ownerId).toBe(other.id);
    expect(ctx.projects.find((x) => x.id === q.id)).toMatchObject({ seenBy: [], gone: false, ownerCan: { createTask: false, createMilestone: false, createRequest: false } });
    // /check dice ciò che direbbe la pubblicazione di `other`: in Q il proprietario (lui) non c'è, quindi nessuno approva.
    const check = (await call(other.headers, "POST", `/automations/${a.code}/check`, { flow })).json() as { issues: { code: string }[] };
    const publish = await call(other.headers, "POST", `/automations/${a.code}/publish`, {});
    expect(publish.statusCode).toBe(409);
    expect(check.issues.length).toBeGreaterThan(0);
    expect(publish.json()).toMatchObject({ code: "config" });
    expect(check.issues.map((i) => i.code).sort()).toEqual(((publish.json() as { issues: { code: string }[] }).issues.map((i) => i.code)).sort());
  });

  it("il contesto: il proprietario che avrebbe (chi prova, per una bozza mai accesa), chi vede, cosa può creare, chi ha i ruoli; un progetto fisso che chi prova non vede resta muto (R-G5)", async () => {
    const { p, lead, dev } = await setup();
    const hidden = await project();
    // Un reparto con una persona che vede SOLO il progetto nascosto: nessuno deve nominarla.
    const dept = await seedDepartment(db);
    const stranger = await person();
    await addMember(app, hidden.id, stranger.id, "developer");
    await addDepartmentMember(db, dept.id, stranger.id);
    const tell: Step = { id: "n1", kind: "notify", who: { departmentId: dept.id }, text: "x", approval: auto };
    const a = await created(lead, p.id, flowOf([createTask({ approval: { mode: "ask", who: { projectRole: "developer" } } }), createTask({ project: { mode: "fixed", projectId: hidden.id } }), tell]));
    const ctx = ((await call(lead.headers, "GET", `/automations/${a.code}/examples?version=draft`)).json() as { context: Record<string, unknown> }).context as {
      ownerId: string;
      draft: boolean;
      rev: number;
      projects: { id: string; code: string; name: string; seenBy: string[]; ownerCan: Record<string, boolean>; roleHolders: Record<string, string[]> }[];
      people: { id: string }[];
    };
    expect(ctx).toMatchObject({ ownerId: lead.id, draft: true, rev: 1 });
    const own = ctx.projects.find((x) => x.id === p.id)!;
    expect(own).toMatchObject({ code: p.code, ownerCan: { createTask: true, createMilestone: true, createRequest: true } });
    expect(own.seenBy).toEqual(expect.arrayContaining([lead.id, dev.id]));
    expect(own.roleHolders.developer).toEqual([dev.id]);
    const other = ctx.projects.find((x) => x.id === hidden.id)!;
    expect(other).toMatchObject({ code: "", name: "", seenBy: [], roleHolders: {}, departmentMembers: {}, ownerCan: { createTask: false } });
    expect(ctx.people.map((x) => x.id)).not.toContain(stranger.id);
    expect(other.roleHolders).toEqual({});
    expect((other as unknown as { departmentMembers: unknown }).departmentMembers).toEqual({});
    expect(ctx.people.map((x) => x.id)).toEqual(expect.arrayContaining([lead.id, dev.id]));
  });
});

describe("l'anteprima condivisa del passo in attesa (pendingEffect)", () => {
  it("una task da approvare: titolo dall'anteprima, incaricato risolto coi piani dell'esecutore; anche in «Da decidere»", async () => {
    const { p, lead, dev } = await setup();
    const a = await created(lead, p.id, flowOf([createTask({ title: "Contratto", assignee: { projectRole: "developer" }, dueInDays: 3, approval: { mode: "ask", who: { owner: true } } })]));
    await call(lead.headers, "POST", `/automations/${a.code}/publish`, {});
    await db.insert(automationRuns).values({
      automationId: a.id,
      n: 1,
      version: 1,
      title: "R",
      origin: "manual",
      status: "waiting_approval",
      cursor: { path: "0" },
      pending: { approverIds: [lead.id], preview: { titolo: "Contratto", descrizione: "" }, path: "0", round: 0 },
    });
    await db.insert(automationRunLog).values({ runId: (await db.select().from(automationRuns).where(eq(automationRuns.automationId, a.id)))[0]!.id, seq: 1, stepId: "trigger", path: "trigger", kind: "trigger", outcome: "ok" });
    const detail = (await call(lead.headers, "GET", `/automations/${a.code}/runs/1`)).json() as { pendingEffect: Record<string, unknown> | null };
    expect(detail.pendingEffect).toMatchObject({ kind: "task", path: "0", title: "Contratto", assigneeId: dev.id, assignedBy: "role", role: "developer", project: { id: p.id, code: p.code }, dueInDays: 3 });
    const decisions = (await call(lead.headers, "GET", "/me/automation-approvals")).json() as { items: { effect: Record<string, unknown> | null }[] };
    expect(decisions.items[0]!.effect).toMatchObject({ kind: "task", assigneeId: dev.id });
  });
});

describe("la ricerca ⌘K", () => {
  it("trova le automazioni per nome o codice e le esecuzioni per codice o titolo, solo nei progetti che chi cerca vede", async () => {
    const { p, lead, outsider } = await setup();
    const a = await created(lead, p.id);
    await db.update(automations).set({ name: "Benvenuto cliente zibaldone" }).where(eq(automations.id, a.id));
    await db.insert(automationRuns).values({ automationId: a.id, n: 4, version: 1, title: "Onboarding zibaldone Rossi", origin: "manual", status: "done" });
    const hits = ((await call(lead.headers, "GET", "/search?q=zibaldone")).json() as { automations: { items: { kind: string; code: string; route: string }[] } }).automations.items;
    expect(hits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "automation", code: a.code, route: `#/automations/${a.code}` }),
        expect.objectContaining({ kind: "run", code: `${a.code} #4`, route: `#/automations/${a.code}/runs/4` }),
      ]),
    );
    const byCode = ((await call(lead.headers, "GET", `/search?q=${encodeURIComponent(`${a.code} #4`)}`)).json() as { automations: { items: { code: string }[] } }).automations.items;
    expect(byCode.map((h) => h.code)).toContain(`${a.code} #4`);
    expect(((await call(outsider.headers, "GET", "/search?q=zibaldone")).json() as { automations: { items: unknown[] } }).automations.items).toEqual([]);
  });
});

describe("R-J12: il registro come lo legge chi guarda", () => {
  it("un progetto che chi guarda non vede, dentro un'esecuzione, è senza id; ciò che vi è stato creato non ha codice", async () => {
    const { p, lead, dev } = await setup();
    const hidden = await project();
    await addMember(app, hidden.id, lead.id, "project_lead");
    const a = await created(lead, p.id);
    const [run] = await db.insert(automationRuns).values({ automationId: a.id, n: 1, version: 1, title: "R", origin: "manual", status: "done", projectIds: [p.id, hidden.id] }).returning();
    await db.insert(automationRunLog).values({ runId: run!.id, seq: 1, stepId: "t1", path: "0", kind: "createTask", outcome: "ok", input: { progetto: hidden.id, titolo: "Altrove" }, effects: [{ kind: "task", code: `${hidden.code}-1` }] });
    const seenByLead = (await call(lead.headers, "GET", `/automations/${a.code}/runs/1`)).json() as { log: { input: { progetto: string }; effects: { code: string }[] }[]; projectIds: string[] };
    expect(seenByLead.log[0]).toMatchObject({ input: { progetto: hidden.id }, effects: [{ code: `${hidden.code}-1` }] });
    const seenByDev = (await call(dev.headers, "GET", `/automations/${a.code}/runs/1`)).json() as typeof seenByLead;
    expect(seenByDev.log[0]).toMatchObject({ input: { progetto: "", titolo: "Altrove" }, effects: [{ code: "" }] });
    expect(seenByDev.projectIds).toEqual([p.id]);
  });
});

describe("i traguardi creati da un'automazione", () => {
  it("automationCreated dice SE chiedere la riga d'origine: vero per un traguardo creato da un'esecuzione, falso per uno a mano", async () => {
    const { p, lead } = await setup();
    const a = await created(lead, p.id);
    const [run] = await db.insert(automationRuns).values({ automationId: a.id, n: 1, version: 1, title: "R", origin: "manual", status: "done" }).returning();
    await db.insert(milestones).values([
      { projectId: p.id, name: "Dall'automazione", automationRunId: run!.id },
      { projectId: p.id, name: "A mano" },
    ]);
    const list = (await call(lead.headers, "GET", `/milestones?projectId=${p.id}`)).json() as { items?: { name: string; automationCreated: boolean }[] } | { name: string; automationCreated: boolean }[];
    const items = Array.isArray(list) ? list : (list.items ?? []);
    expect(Object.fromEntries(items.map((m) => [m.name, m.automationCreated]))).toEqual({ "Dall'automazione": true, "A mano": false });
  });
});

