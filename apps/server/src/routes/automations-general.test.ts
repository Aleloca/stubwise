import { randomUUID } from "node:crypto";
import { automationRuns, automations, automationSources, automationVersions, clientProjectLinks, googleAccounts, googleWorkspaces, roles, users, type Db } from "@stubwise/db";
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

    // La ricerca (⌘K): chi le gestisce le trova, il Project Lead no.
    const found = (who: { cookie: string }) => call(who, "GET", `/search?q=${a.code}`).then((r) => (r.json() as { automations: { items: { code: string }[] } }).automations.items.map((i) => i.code));
    expect(await found(manager.headers)).toContain(a.code);
    expect(await found(lead.headers)).not.toContain(a.code);

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

  it("review F4, I3: due pubblicazioni INSIEME sulla stessa sorgente: ne passa una sola (anche accendendo)", async () => {
    const p = await project();
    const lead = await person();
    await addMember(app, p.id, lead.id, "project_lead");
    for (const op of ["publish", "activate"] as const) {
      const [source] = await db.insert(automationSources).values({ kind: "webhook", name: "Ordini", secretHash: randomUUID().replace(/-/g, ""), fields: [] }).returning();
      const flow = flowOf([createTask({ mode: "own" })], { kind: "source", sourceId: source!.id, event: "webhook" });
      const codes: string[] = [];
      for (let i = 0; i < 4; i++) codes.push(((await call(lead.headers, "POST", "/automations", { name: `X${i}`, projectId: p.id, flow })).json() as { code: string }).code);
      const results = await Promise.all(codes.map((c) => call(lead.headers, "POST", `/automations/${c}/${op}`, {})));
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409, 409, 409]);
    }
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

describe("R-J13 lungo la catena (S6)", () => {
  it("la figlia di un'esecuzione partita da un'email: il suo proprietario, che non possiede la casella d'origine, non legge mittente, oggetto né testo; il proprietario della casella sì", async () => {
    const p = await project();
    const mailOwner = await person();
    const childOwner = await person();
    await addMember(app, p.id, mailOwner.id, "project_lead");
    await addMember(app, p.id, childOwner.id, "project_lead");
    const [ws] = await db.insert(googleWorkspaces).values({ name: "W", domains: ["acme.com"], clientId: "c", clientSecretEncrypted: "s" }).returning();
    const [box] = await db.insert(googleAccounts).values({ userId: mailOwner.id, workspaceId: ws!.id, email: `m-${randomUUID().slice(0, 5)}@acme.com`, googleSub: randomUUID(), refreshTokenEncrypted: "r", scopes: [] }).returning();
    const seq = Math.floor(Math.random() * 1e6);
    const [child] = await db.insert(automations).values({ code: `${p.code}-A${seq}`, seq, name: "Figlia", projectId: p.id, ownerId: childOwner.id, status: "active", activeSince: new Date() }).returning();
    await db.insert(automationVersions).values({ automationId: child!.id, n: 1, flow: { trigger: { kind: "manual" }, steps: [], titleTemplate: "R" }, publishedAt: new Date() });
    await db.insert(automationRuns).values({
      automationId: child!.id,
      n: 1,
      version: 1,
      title: "Ordine da cliente@x.it",
      origin: "automation",
      status: "done",
      event: { email: { mittente: "cliente@x.it", oggetto: "Ordine riservato", testo: "segreto" } },
      mailOriginAccountId: box!.id,
      projectIds: [p.id],
    });
    const seen = await call(childOwner.headers, "GET", `/automations/${child!.code}/runs/1`);
    expect(seen.statusCode).toBe(200);
    expect(JSON.stringify(seen.json())).not.toContain("segreto");
    expect(JSON.stringify(seen.json())).not.toContain("cliente@x.it");
    expect(seen.json()).toMatchObject({ mailHidden: true });
    const owner = await call(mailOwner.headers, "GET", `/automations/${child!.code}/runs/1`);
    expect(owner.json()).toMatchObject({ event: { email: { testo: "segreto" } } });
  });
});

describe("review F4: «Da decidere» per una generale senza progetto", () => {
  it("un approvatore nominato (non il proprietario) trova il passo che aspetta lui, anche senza vedere progetti", async () => {
    const manager = await generalManager();
    const approver = await person();
    const a = await general(manager, flowOf([{ id: "n1", kind: "notify", who: { personId: approver.id }, text: "x", approval: { mode: "ask", who: { personId: approver.id } } } as unknown as Step]));
    await db.update(automations).set({ ownerId: manager.id, status: "active" }).where(eq(automations.id, a.id));
    await db.insert(automationRuns).values({ automationId: a.id, n: 1, version: 1, title: "R", origin: "manual", status: "waiting_approval", cursor: { path: "0" }, pending: { approverIds: [approver.id], preview: {}, path: "0", round: 0 }, projectIds: [] });
    const items = ((await call(approver.headers, "GET", "/me/automation-approvals")).json() as { items: { automationCode: string }[] }).items;
    expect(items.map((i) => i.automationCode)).toContain(a.code);
  });
});

describe("F4, la prova (46): il progetto del cliente e le automazioni di «avvia un'altra»", () => {
  it("test/client-project risolve per il proprietario con la regola del worker; null fuori tabella o verso un progetto che non vede; 403 a chi non può provare; mai la tabella", async () => {
    const p = await project();
    const hidden = await project();
    const lead = await person();
    const dev = await person();
    await addMember(app, p.id, lead.id, "project_lead");
    await addMember(app, p.id, dev.id, "developer");
    const key = `acme-${randomUUID().slice(0, 6)}.it`;
    const other = `altro-${randomUUID().slice(0, 6)}.it`;
    await db.insert(clientProjectLinks).values([
      { clientKey: key, clientName: "Acme", projectId: p.id },
      { clientKey: other, clientName: "Altro", projectId: p.id },
      { clientKey: `nascosto-${key}`, clientName: "N", projectId: hidden.id },
    ]);
    const a = (await call(lead.headers, "POST", "/automations", { name: "A", projectId: p.id })).json() as { code: string };
    const ask = (who: { cookie: string }, client: string) => call(who, "GET", `/automations/${a.code}/test/client-project?version=draft&client=${encodeURIComponent(client)}`);
    const found = await ask(lead.headers, ` ${key.toUpperCase()} `);
    expect(found.statusCode).toBe(200);
    expect(found.json()).toMatchObject({ project: { id: p.id, code: p.code } });
    expect(JSON.stringify(found.json())).not.toContain(other);
    expect((await ask(lead.headers, "sconosciuto.it")).json()).toEqual({ project: null, people: [] });
    expect((await ask(lead.headers, `nascosto-${key}`)).json()).toEqual({ project: null, people: [] });
    expect((await ask(dev.headers, key)).statusCode).toBe(403);
  });

  it("il contesto degli esempi elenca le automazioni nominate da «avvia un'altra», come le vede il proprietario; codice e nome solo se chi prova la vede", async () => {
    const p = await project();
    const hidden = await project();
    const lead = await person();
    await addMember(app, p.id, lead.id, "project_lead");
    const b = (await call(lead.headers, "POST", "/automations", { name: "B", projectId: p.id })).json() as { id: string; code: string };
    const seq = Math.floor(Math.random() * 1e6);
    const [c] = await db.insert(automations).values({ code: `${hidden.code}-A${seq}`, seq, name: "C segreta", projectId: hidden.id, status: "active" }).returning();
    const start = (id: string): Step => ({ id: `s-${id.slice(0, 4)}`, kind: "startAutomation", automationId: id, approval: { mode: "auto" } }) as Step;
    const a = (await call(lead.headers, "POST", "/automations", { name: "A", projectId: p.id, flow: flowOf([start(b.id), start(c!.id)]) })).json() as { code: string };
    const view = (await call(lead.headers, "GET", `/automations/${a.code}/examples?version=draft`)).json() as { context: { automations: unknown[] } };
    expect(view.context.automations).toEqual(
      expect.arrayContaining([
        { id: b.id, code: b.code, name: "B", status: "draft", visibleToOwner: true, manageableByOwner: true },
        { id: c!.id, code: "", name: "", status: "active", visibleToOwner: false, manageableByOwner: false },
      ]),
    );
    expect(JSON.stringify(view)).not.toContain("C segreta");
  });
});
