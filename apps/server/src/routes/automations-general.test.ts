import { randomUUID } from "node:crypto";
import { automationRuns, automations, automationSources, roles, users, type Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import type { AutomationFlow, Step } from "@stubwise/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { projects } from "@stubwise/db";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

/**
 * LE AUTOMAZIONI GENERALI (area 7, F4, S2): senza progetto, di chi ha
 * `automations.general.manage` d'istanza (il design: «`automations.manage`
 * d'istanza»). Nascosto = inesistente (R-G5): chi non ha il permesso non le
 * vede né le crea, anche se è Project Lead. Più il tetto del webhook scelto
 * da chi gestisce l'automazione (F4-2 = c) e un webhook per automazione
 * (F4-1 = a, `source_in_use`).
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
afterEach(() => {
  delete process.env.AUTOMATION_WEBHOOK_MAX_PER_MINUTE;
  delete process.env.AUTOMATION_WEBHOOK_MAX_PER_DAY;
});

async function project() {
  const code = Array.from({ length: 4 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("");
  const [p] = await db.insert(projects).values({ name: `P ${code}`, code, slug: `p-${randomUUID()}`, ingestionKey: randomUUID() }).returning();
  return { id: p!.id, code };
}
const person = () => createUserWithSession(app, `u-${randomUUID().slice(0, 8)}@acme.com`);
const call = (headers: { cookie: string }, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: object) =>
  app.inject({ method, url: `/api${url}`, headers, ...(payload ? { payload } : {}) });

/** Una persona col ruolo d'istanza su misura che ha le generali (oltre a ciò che ha il preset User). */
async function generalManager() {
  const u = await person();
  const [role] = await db
    .insert(roles)
    .values({ name: `Generali ${randomUUID().slice(0, 6)}`, scope: "instance", permissions: ["automations.general.manage"] })
    .returning({ id: roles.id });
  await db.update(users).set({ instanceRoleId: role!.id }).where(eq(users.id, u.id));
  return u;
}

const createTask = (project: Extract<Step, { kind: "createTask" }>["project"]): Step => ({
  id: `t-${randomUUID().slice(0, 6)}`,
  kind: "createTask",
  title: "Una task",
  description: "",
  assignee: null,
  dueInDays: null,
  project,
  milestoneRef: null,
  approval: { mode: "auto" },
});
const flowOf = (steps: Step[], trigger: AutomationFlow["trigger"] = { kind: "manual" }): AutomationFlow => ({ trigger, steps, titleTemplate: "Run" });

async function general(who: { headers: { cookie: string } }, flow?: AutomationFlow) {
  const res = await call(who.headers, "POST", "/automations", { name: "Generale", projectId: null, ...(flow ? { flow } : {}) });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; code: string; projectId: string | null; versions: { rev: number }[]; webhookLimits: Record<string, unknown> };
}

describe("chi crea e chi vede una generale", () => {
  it("con il permesso d'istanza: codice AUT-<n>, nell'elenco e nel dettaglio; un Project Lead senza: 403 a crearla, 404 a vederla, e fuori dagli elenchi", async () => {
    const p = await project();
    const lead = await person();
    await addMember(app, p.id, lead.id, "project_lead");
    const manager = await generalManager();

    const a = await general(manager);
    expect(a.code).toMatch(/^AUT-\d+$/);
    expect(a.projectId).toBeNull();
    const b = await general(manager);
    expect(Number(b.code.slice(4))).toBeGreaterThan(Number(a.code.slice(4)));

    expect((await call(manager.headers, "GET", `/automations/${a.code}`)).statusCode).toBe(200);
    const onlyGeneral = (await call(manager.headers, "GET", "/automations?general=true")).json() as { items: { code: string; permissions: { manage: boolean } }[] };
    expect(onlyGeneral.items.map((i) => i.code)).toEqual(expect.arrayContaining([a.code, b.code]));
    expect(onlyGeneral.items.every((i) => i.permissions.manage)).toBe(true);

    // Il Project Lead: niente generale, in nessuna forma (R-G5), e nessuna riga nuova.
    const before = await db.select().from(automations);
    expect((await call(lead.headers, "POST", "/automations", { name: "X", projectId: null })).statusCode).toBe(403);
    expect((await db.select().from(automations)).length).toBe(before.length);
    expect((await call(lead.headers, "GET", `/automations/${a.code}`)).statusCode).toBe(404);
    expect((await call(lead.headers, "PATCH", `/automations/${a.code}`, { name: "Rinominata" })).statusCode).toBe(404);
    expect((await call(lead.headers, "GET", "/automations?general=true")).json()).toEqual({ items: [] });
    expect(((await call(lead.headers, "GET", "/automations")).json() as { items: { code: string }[] }).items.map((i) => i.code)).not.toContain(a.code);

    // Il full admin le ha implicite.
    expect((await call({ cookie: adminCookie }, "GET", `/automations/${a.code}`)).statusCode).toBe(200);
  });

  it("una generale non ha un progetto suo: un passo «nel progetto dell'automazione» è un errore di configurazione; uno fisso no", async () => {
    const p = await project();
    const manager = await generalManager();
    await addMember(app, p.id, manager.id, "project_lead");
    const own = await general(manager, flowOf([createTask({ mode: "own" })]));
    const res = await call(manager.headers, "POST", `/automations/${own.code}/publish`, {});
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "config" });
    const fixed = await general(manager, flowOf([createTask({ mode: "fixed", projectId: p.id })]));
    const ok = await call(manager.headers, "POST", `/automations/${fixed.code}/publish`, {});
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: "active", ownerId: manager.id });
  });

  it("perso il permesso d'istanza, la generale sparisce anche al suo proprietario", async () => {
    const manager = await generalManager();
    const a = await general(manager);
    const [userRole] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, "User"));
    await db.update(users).set({ instanceRoleId: userRole!.id }).where(eq(users.id, manager.id));
    expect((await call(manager.headers, "GET", `/automations/${a.code}`)).statusCode).toBe(404);
  });
});

describe("la sezione del progetto: le generali che vi hanno agito", () => {
  it("un membro senza il permesso vede l'esecuzione aperta solo con codice e stato (niente nome, titolo, link) e non l'elenco; chi le gestisce vede tutto", async () => {
    const p = await project();
    const member = await person();
    await addMember(app, p.id, member.id, "developer");
    const manager = await generalManager();
    await addMember(app, p.id, manager.id, "developer");
    const a = await general(manager);
    await db.insert(automationRuns).values({ automationId: a.id, n: 1, version: 1, title: "Cliente Acme — ordine 12", origin: "manual", status: "waiting_approval", projectIds: [p.id] });

    const seen = (await call(member.headers, "GET", `/projects/${p.id}/automations`)).json() as { runs: { code: string; title: string; automationName: string; linkable: boolean }[]; general: unknown[] };
    expect(seen.runs).toEqual([expect.objectContaining({ code: `${a.code} #1`, title: "", automationName: "", linkable: false })]);
    expect(seen.general).toEqual([]);

    const full = (await call(manager.headers, "GET", `/projects/${p.id}/automations`)).json() as { runs: { title: string; linkable: boolean }[]; general: { code: string; runCount: number }[] };
    expect(full.runs[0]).toMatchObject({ title: "Cliente Acme — ordine 12", linkable: true });
    expect(full.general).toEqual([expect.objectContaining({ code: a.code, runCount: 1 })]);
  });
});

describe("il tetto del webhook (F4-2 = c)", () => {
  it("lo sceglie chi gestisce l'automazione; null torna al default; oltre il massimo d'istanza si salva ma vale il massimo; senza automations.manage: 403", async () => {
    process.env.AUTOMATION_WEBHOOK_MAX_PER_MINUTE = "100";
    const p = await project();
    const lead = await person();
    const dev = await person();
    await addMember(app, p.id, lead.id, "project_lead");
    await addMember(app, p.id, dev.id, "developer");
    const created = await call(lead.headers, "POST", "/automations", { name: "Ordini", projectId: p.id });
    const a = created.json() as { code: string; webhookLimits: unknown };
    expect(a.webhookLimits).toMatchObject({ perMinute: null, perDay: null, defaultPerMinute: 60, defaultPerDay: 5000, maxPerMinute: 100, effective: { perMinute: 60, perDay: 5000 } });

    const set = await call(lead.headers, "PATCH", `/automations/${a.code}`, { webhookPerMinute: 500, webhookPerDay: 10 });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toMatchObject({ webhookLimits: { perMinute: 500, perDay: 10, effective: { perMinute: 100, perDay: 10 } } });

    const reset = await call(lead.headers, "PATCH", `/automations/${a.code}`, { webhookPerMinute: null });
    expect(reset.json()).toMatchObject({ webhookLimits: { perMinute: null, perDay: 10, effective: { perMinute: 60, perDay: 10 } } });

    expect((await call(lead.headers, "PATCH", `/automations/${a.code}`, { webhookPerMinute: 0 })).statusCode).toBe(400);
    expect((await call(dev.headers, "PATCH", `/automations/${a.code}`, { webhookPerMinute: 5 })).statusCode).toBe(403);
    const [row] = await db.select().from(automations).where(eq(automations.code, a.code));
    expect(row).toMatchObject({ webhookPerMinute: null, webhookPerDay: 10 });
  });
});

describe("un webhook per automazione (F4-1 = a)", () => {
  it("una sorgente già usata da un'altra automazione accesa non si pubblica (source_in_use); messa in bozza l'altra, sì", async () => {
    const p = await project();
    const lead = await person();
    await addMember(app, p.id, lead.id, "project_lead");
    const [source] = await db.insert(automationSources).values({ kind: "webhook", name: "Ordini", secretHash: randomUUID().replace(/-/g, ""), fields: [{ key: "ordine", label: "Ordine", type: "text" }] }).returning();
    const flow = flowOf([createTask({ mode: "own" })], { kind: "source", sourceId: source!.id, event: "webhook" });
    const first = (await call(lead.headers, "POST", "/automations", { name: "A", projectId: p.id, flow })).json() as { code: string };
    expect((await call(lead.headers, "POST", `/automations/${first.code}/publish`, {})).statusCode).toBe(200);
    const second = (await call(lead.headers, "POST", "/automations", { name: "B", projectId: p.id, flow })).json() as { code: string };
    const taken = await call(lead.headers, "POST", `/automations/${second.code}/publish`, {});
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toMatchObject({ code: "source_in_use" });
  });

  it("una sorgente che non esiste è un errore di configurazione", async () => {
    const p = await project();
    const lead = await person();
    await addMember(app, p.id, lead.id, "project_lead");
    const flow = flowOf([createTask({ mode: "own" })], { kind: "source", sourceId: randomUUID(), event: "webhook" });
    const a = (await call(lead.headers, "POST", "/automations", { name: "A", projectId: p.id, flow })).json() as { code: string };
    const res = await call(lead.headers, "POST", `/automations/${a.code}/publish`, {});
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "config" });
  });
});
