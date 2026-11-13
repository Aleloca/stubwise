import { randomUUID } from "node:crypto";
import { automationRunInputs, automationRuns, automations, automationVersions, projectMembers as projectMembersTable, projects, type Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
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

