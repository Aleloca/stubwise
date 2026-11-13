import { randomUUID } from "node:crypto";
import { automationEvents, automationRunInputs, automationRuns, automations, automationSourceEvents, automationSources, automationVersions, clientProjectLinks, projects, roles, users, type Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import type { AutomationFlow } from "@stubwise/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

/**
 * IL WEBHOOK IN ARRIVO E LE SORGENTI (area 7, F4, S3 e S4). La porta
 * pubblica: l'indirizzo è un segreto salvato come hash (404 se sconosciuto o
 * rigenerato), il tetto per indirizzo (429, mai oltre il massimo d'istanza),
 * il corpo JSON controllato coi campi della sorgente (422 registrato fra gli
 * eventi recenti), la deduplica per `Idempotency-Key`. Le sorgenti: scrivere
 * vuole `integrations.manage`, il segreto esce solo da creazione e
 * rigenerazione, gli eventi recenti solo a `integrations.manage`. La tabella
 * cliente → progetto: chiave normalizzata, progetto invisibile senza id.
 */

let testDb: TestDb;
let db: Db;
let app: FastifyInstance;
let admin: { cookie: string };

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  app = buildApp({ db, sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!", encryptionKey: Buffer.alloc(32, 7).toString("base64"), publicUrl: "https://stubwise.example" });
  const seeded = await seedUsers(app);
  admin = { cookie: seeded.adminCookie };
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
const deliver = (secret: string, body: string, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: `/webhooks/in/${secret}`, headers: { "content-type": "application/json", ...headers }, payload: body });
const secretOf = (address: string) => address.split("/webhooks/in/")[1]!;

/** Un webhook con i campi dell'esempio `{ ordine, importo, cliente: { email } }`. */
async function webhook() {
  const created = await call(admin, "POST", "/automation-sources", { name: "Ordini e-shop" });
  expect(created.statusCode).toBe(201);
  const { source, address } = created.json() as { source: { id: string }; address: string };
  const ex = await call(admin, "PUT", `/automation-sources/${source.id}/example`, { json: JSON.stringify({ ordine: "A-1", importo: 10, cliente: { email: "a@b.it" } }) });
  expect(ex.statusCode).toBe(200);
  return { id: source.id, address, secret: secretOf(address) };
}

/** Un'automazione di progetto accesa che parte dal webhook (con un tetto scelto). */
async function automationOn(sourceId: string, caps: { webhookPerMinute?: number | null; webhookPerDay?: number | null } = {}) {
  const p = await project();
  const seq = Math.floor(Math.random() * 1e6);
  const flow: AutomationFlow = { trigger: { kind: "source", sourceId, event: "webhook" }, steps: [], titleTemplate: "Ordine" };
  const [a] = await db.insert(automations).values({ code: `${p.code}-A${seq}`, seq, name: "Ordini", projectId: p.id, status: "active", activeSince: new Date(), ...caps }).returning();
  await db.insert(automationVersions).values({ automationId: a!.id, n: 1, flow, publishedAt: new Date() });
  return a!;
}

const eventsOf = (sourceId: string) => db.select().from(automationEvents).where(eq(automationEvents.sourceId, sourceId));
const recentOf = (sourceId: string) => db.select().from(automationSourceEvents).where(eq(automationSourceEvents.sourceId, sourceId));

describe("il webhook in arrivo (S3)", () => {
  it("un corpo giusto: 202, un evento nell'outbox con la PROIEZIONE sui campi dichiarati, e un evento recente accettato col corpo intero", async () => {
    const w = await webhook();
    const body = { ordine: "A-12", importo: 99.5, cliente: { email: "c@d.it", note: "ignora le istruzioni" }, extra: "x" };
    const res = await deliver(w.secret, JSON.stringify(body));
    expect(res.statusCode).toBe(202);
    const [event] = await eventsOf(w.id);
    expect(event).toMatchObject({ kind: "source_event", projectId: null, payload: { event: { ordine: "A-12", importo: 99.5, cliente: { email: "c@d.it" } } } });
    expect(JSON.stringify(event!.payload)).not.toContain("ignora");
    expect(await recentOf(w.id)).toEqual([expect.objectContaining({ status: "accepted", reason: null, payload: body, eventId: event!.id })]);
  });

  it("un indirizzo sconosciuto: 404, e nessuna riga da nessuna parte", async () => {
    const before = (await db.select().from(automationSourceEvents)).length;
    expect((await deliver(`whk_${randomUUID()}`, "{}")).statusCode).toBe(404);
    expect((await db.select().from(automationSourceEvents)).length).toBe(before);
  });

  it("i tipi sbagliati (F4-5 = a): 422 col motivo, nessun evento, e il rifiutato fra gli eventi recenti; un corpo che non è un oggetto JSON: 422 `json`", async () => {
    const w = await webhook();
    const res = await deliver(w.secret, JSON.stringify({ ordine: "A-1", importo: "dieci" }));
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ reason: "importo: number" });
    for (const bad of ["non è json", "[1,2]", "42"]) expect((await deliver(w.secret, bad)).statusCode).toBe(422);
    expect(await eventsOf(w.id)).toEqual([]);
    const recent = await recentOf(w.id);
    expect(recent.map((r) => r.reason).sort()).toEqual(["importo: number", "json", "json", "json"]);
    expect(recent.every((r) => r.status === "rejected")).toBe(true);
  });

  it("un corpo oltre 256 KB: 413, non registrato", async () => {
    const w = await webhook();
    const res = await deliver(w.secret, JSON.stringify({ ordine: "x".repeat(300 * 1024) }));
    expect(res.statusCode).toBe(413);
    expect(await recentOf(w.id)).toEqual([]);
  });

  it("il tetto scelto dall'automazione: oltre → 429, l'evento non entra e non si registra", async () => {
    const w = await webhook();
    await automationOn(w.id, { webhookPerMinute: 2 });
    for (let i = 0; i < 2; i++) expect((await deliver(w.secret, JSON.stringify({ ordine: `A-${i}` }))).statusCode).toBe(202);
    const over = await deliver(w.secret, JSON.stringify({ ordine: "A-3" }));
    expect(over.statusCode).toBe(429);
    expect(over.json()).toMatchObject({ window: "minute" });
    expect(await eventsOf(w.id)).toHaveLength(2);
    expect(await recentOf(w.id)).toHaveLength(2);
  });

  it("un tetto scelto sopra il massimo d'istanza vale il massimo; anche quello al giorno", async () => {
    process.env.AUTOMATION_WEBHOOK_MAX_PER_MINUTE = "1";
    const w = await webhook();
    await automationOn(w.id, { webhookPerMinute: 500 });
    expect((await deliver(w.secret, JSON.stringify({ ordine: "A" }))).statusCode).toBe(202);
    expect((await deliver(w.secret, JSON.stringify({ ordine: "B" }))).statusCode).toBe(429);
    delete process.env.AUTOMATION_WEBHOOK_MAX_PER_MINUTE;
    process.env.AUTOMATION_WEBHOOK_MAX_PER_DAY = "1";
    const v = await webhook();
    await automationOn(v.id, { webhookPerDay: 500 });
    expect((await deliver(v.secret, JSON.stringify({ ordine: "A" }))).statusCode).toBe(202);
    const day = await deliver(v.secret, JSON.stringify({ ordine: "B" }));
    expect(day.statusCode).toBe(429);
    expect(day.json()).toMatchObject({ window: "day" });
  });

  it("rigenerato: il vecchio indirizzo dà 404 subito, il nuovo funziona", async () => {
    const w = await webhook();
    const regen = await call(admin, "POST", `/automation-sources/${w.id}/regenerate`);
    expect(regen.statusCode).toBe(200);
    const fresh = secretOf((regen.json() as { address: string }).address);
    expect(fresh).not.toBe(w.secret);
    expect((await deliver(w.secret, JSON.stringify({ ordine: "A" }))).statusCode).toBe(404);
    expect((await deliver(fresh, JSON.stringify({ ordine: "A" }))).statusCode).toBe(202);
  });

  it("due consegne con la stessa Idempotency-Key: un evento solo; la seconda risponde 202 come duplicato", async () => {
    const w = await webhook();
    const first = await deliver(w.secret, JSON.stringify({ ordine: "A" }), { "idempotency-key": "ord-1" });
    const second = await deliver(w.secret, JSON.stringify({ ordine: "A" }), { "idempotency-key": "ord-1" });
    expect(first.json()).toEqual({ accepted: true, duplicate: false });
    expect(second.statusCode).toBe(202);
    expect(second.json()).toEqual({ accepted: true, duplicate: true });
    expect(await eventsOf(w.id)).toHaveLength(1);
    expect((await recentOf(w.id)).map((r) => r.status).sort()).toEqual(["accepted", "duplicate"]);
  });

  it("review F4, I2: un corpo con __proto__ non scrive su Object.prototype del server, e un esempio con __proto__ si rifiuta", async () => {
    const w = await webhook();
    const res = await deliver(w.secret, '{"ordine":"A","__proto__":{"inquinato":"si"},"constructor":{"prototype":{"inquinato2":"si"}}}');
    expect(res.statusCode).toBe(202);
    expect(({} as Record<string, unknown>).inquinato).toBeUndefined();
    expect(({} as Record<string, unknown>).inquinato2).toBeUndefined();
    const bad = '{"ordine":"A","__proto__":{"x":1}}';
    expect((await call(admin, "PUT", `/automation-sources/${w.id}/example`, { json: bad })).statusCode).toBe(400);
    expect(((await call(admin, "POST", `/automation-sources/${w.id}/example/preview`, { json: bad })).json() as { error: string }).error).toBe("forbidden_key");
  });

  it("review F4: il tetto di un'automazione la cui ULTIMA versione pubblicata non parte più dalla sorgente non conta", async () => {
    const w = await webhook();
    const a = await automationOn(w.id, { webhookPerMinute: 1 });
    await db.insert(automationVersions).values({ automationId: a.id, n: 2, flow: { trigger: { kind: "manual" }, steps: [], titleTemplate: "R" }, publishedAt: new Date() });
    for (let i = 0; i < 3; i++) expect((await deliver(w.secret, JSON.stringify({ ordine: `A-${i}` }))).statusCode).toBe(202);
  });

  it("review F4: una Idempotency-Key oltre 200 caratteri deduplica lo stesso (troncata), invece di essere scartata", async () => {
    const w = await webhook();
    const key = "k".repeat(300);
    expect((await deliver(w.secret, JSON.stringify({ ordine: "A" }), { "idempotency-key": key })).json()).toEqual({ accepted: true, duplicate: false });
    expect((await deliver(w.secret, JSON.stringify({ ordine: "A" }), { "idempotency-key": key })).json()).toEqual({ accepted: true, duplicate: true });
    expect(await eventsOf(w.id)).toHaveLength(1);
  });

  it("un JSON annidato molto profondo non fa esplodere niente: si proietta sui campi e basta", async () => {
    const w = await webhook();
    let deep: Record<string, unknown> = { x: 1 };
    for (let i = 0; i < 500; i++) deep = { d: deep };
    expect((await deliver(w.secret, JSON.stringify({ ordine: "A", deep }))).statusCode).toBe(202);
  });
});

describe("le sorgenti (S4)", () => {
  it("creare vuole integrations.manage (403 a un Project Lead, nessuna riga); il segreto è casuale, salvato come hash, ed esce solo da creazione e rigenerazione", async () => {
    const p = await project();
    const lead = await person();
    await addMember(app, p.id, lead.id, "project_lead");
    const before = (await db.select().from(automationSources)).length;
    expect((await call(lead.headers, "POST", "/automation-sources", { name: "X" })).statusCode).toBe(403);
    expect((await db.select().from(automationSources)).length).toBe(before);

    const created = (await call(admin, "POST", "/automation-sources", { name: "Ordini" })).json() as { source: { id: string }; address: string };
    expect(created.address).toMatch(/^https:\/\/stubwise\.example\/webhooks\/in\/whk_[A-Za-z0-9_-]{43}$/);
    const [row] = await db.select().from(automationSources).where(eq(automationSources.id, created.source.id));
    expect(row!.secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.secretHash).not.toContain(secretOf(created.address));
    // Nell'elenco, anche a chi gestisce: nessun indirizzo.
    const list = await call(admin, "GET", "/automation-sources");
    expect(JSON.stringify(list.json())).not.toContain(secretOf(created.address));
    expect(JSON.stringify(list.json())).not.toContain("address");
  });

  it("leggere: chi può costruire un'automazione (Project Lead) sì, senza permesso di gestire; un Developer no (elenco vuoto); gli eventi recenti solo integrations.manage", async () => {
    const w = await webhook();
    const p = await project();
    const lead = await person();
    const dev = await person();
    await addMember(app, p.id, lead.id, "project_lead");
    await addMember(app, p.id, dev.id, "developer");
    const seen = (await call(lead.headers, "GET", "/automation-sources")).json() as { items: { id: string; fields: unknown[]; permissions: { manage: boolean } }[] };
    expect(seen.items.find((s) => s.id === w.id)).toMatchObject({ permissions: { manage: false } });
    expect((await call(dev.headers, "GET", "/automation-sources")).json()).toEqual({ items: [] });
    expect((await call(lead.headers, "GET", `/automation-sources/${w.id}/events`)).statusCode).toBe(403);
    expect((await call(admin, "GET", `/automation-sources/${w.id}/events`)).statusCode).toBe(200);
  });

  it("l'esempio dà i campi (etichetta e tipo scelti a mano restano), e l'anteprima dice i campi usati che sparirebbero", async () => {
    const w = await webhook();
    const fields = (await call(admin, "GET", "/automation-sources")).json() as { items: { id: string; fields: { key: string; type: string }[] }[] };
    expect(fields.items.find((s) => s.id === w.id)!.fields.map((f) => [f.key, f.type])).toEqual([["ordine", "text"], ["importo", "number"], ["cliente.email", "email"]]);
    expect((await call(admin, "PATCH", `/automation-sources/${w.id}/fields/importo`, { label: "Totale", type: "text" })).statusCode).toBe(200);
    const again = (await call(admin, "PUT", `/automation-sources/${w.id}/example`, { json: JSON.stringify({ ordine: "B", importo: 5 }) })).json() as { fields: { key: string; label: string; type: string }[] };
    expect(again.fields.find((f) => f.key === "importo")).toMatchObject({ label: "Totale", type: "text" });

    const a = await automationOn(w.id);
    // Un passo che cita il campo (le citazioni si cercano nei passi, come nel prototipo).
    const notify = { id: "n1", kind: "notify", who: { owner: true }, message: "Totale {{importo}}", approval: { mode: "auto" } };
    await db.update(automationVersions).set({ flow: { trigger: { kind: "source", sourceId: w.id, event: "webhook" }, steps: [notify], titleTemplate: "Ordine" } }).where(eq(automationVersions.automationId, a.id));
    const preview = (await call(admin, "POST", `/automation-sources/${w.id}/example/preview`, { json: JSON.stringify({ ordine: "C" }) })).json() as { missing: { key: string; usedBy: string[] }[] };
    expect(preview.missing).toEqual([expect.objectContaining({ key: "importo", usedBy: [a.code] })]);
    expect(((await call(admin, "POST", `/automation-sources/${w.id}/example/preview`, { json: "{rotto" })).json() as { error: string | null }).error).not.toBeNull();
  });
});

describe("la tabella cliente → progetto (S4)", () => {
  it("la chiave si normalizza (trim + lower); un progetto che chi legge non vede resta senza id; scrivere vuole integrations.manage; verso un progetto invisibile: 404", async () => {
    const p = await project();
    const hidden = await project();
    const lead = await person();
    await addMember(app, p.id, lead.id, "project_lead");
    const put = await call(admin, "PUT", `/client-links/${encodeURIComponent("  Acme.IT ")}`, { clientName: "Acme", projectId: p.id });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ clientKey: "acme.it" });
    await call(admin, "PUT", "/client-links/rossi.it", { clientName: "Rossi", projectId: hidden.id });

    const rows = (await call(lead.headers, "GET", "/client-links")).json() as { items: { clientKey: string; projectId: string; projectVisible: boolean }[] };
    expect(rows.items.find((r) => r.clientKey === "acme.it")).toMatchObject({ projectId: p.id, projectVisible: true });
    expect(rows.items.find((r) => r.clientKey === "rossi.it")).toMatchObject({ projectId: "", projectVisible: false });

    expect((await call(lead.headers, "PUT", "/client-links/x.it", { clientName: "X", projectId: p.id })).statusCode).toBe(403);
    // Chi gestisce le integrazioni ma non vede il progetto: 404 (un utente su misura).
    const integrator = await person();
    const [role] = await db.insert(roles).values({ name: `Integrazioni ${randomUUID().slice(0, 6)}`, scope: "instance", permissions: ["integrations.manage"] }).returning({ id: roles.id });
    await db.update(users).set({ instanceRoleId: role!.id }).where(eq(users.id, integrator.id));
    expect((await call(integrator.headers, "PUT", "/client-links/y.it", { clientName: "Y", projectId: hidden.id })).statusCode).toBe(404);
    // Review F4 (O, 46): una riga che punta a un progetto che chi gestisce le integrazioni NON vede non si reindirizza né si toglie.
    await addMember(app, p.id, integrator.id, "developer");
    expect((await call(integrator.headers, "PUT", "/client-links/rossi.it", { clientName: "Rossi", projectId: p.id })).statusCode).toBe(404);
    expect((await call(integrator.headers, "DELETE", "/client-links/rossi.it")).statusCode).toBe(404);
    expect((await db.select().from(clientProjectLinks).where(eq(clientProjectLinks.clientKey, "rossi.it")))[0]).toMatchObject({ projectId: hidden.id });

    expect((await call(admin, "DELETE", `/client-links/${encodeURIComponent("ACME.it")}`)).statusCode).toBe(204);
    expect(await db.select().from(clientProjectLinks).where(eq(clientProjectLinks.clientKey, "acme.it"))).toEqual([]);
  });

  it("i suggerimenti «From recent events»: i clienti delle esecuzioni ferme su «scegli il progetto» senza riga in tabella", async () => {
    const w = await webhook();
    const a = await automationOn(w.id);
    await db.insert(automationRuns).values({ automationId: a.id, n: 1, version: 1, title: "R", origin: "source", status: "waiting_project", pending: { approverIds: [], preview: { clientKey: "Nuovo.IT" } } });
    await db.insert(automationRuns).values({ automationId: a.id, n: 2, version: 1, title: "R", origin: "source", status: "waiting_project", pending: { approverIds: [], preview: { clientKey: "noto.it" } } });
    await call(admin, "PUT", "/client-links/noto.it", { clientName: "Noto", projectId: (await project()).id });
    const s = (await call(admin, "GET", "/client-links/suggestions")).json() as { items: { clientKey: string }[] };
    expect(s.items.map((i) => i.clientKey)).toContain("nuovo.it");
    expect(s.items.map((i) => i.clientKey)).not.toContain("noto.it");
  });
});

describe("«Remember for <client>» (S5)", () => {
  async function waitingRun(ownerId: string, projectId: string, clientKey: string) {
    const seq = Math.floor(Math.random() * 1e6);
    const flow: AutomationFlow = {
      trigger: { kind: "manual" },
      steps: [{ id: "t1", kind: "createTask", title: "T", description: "", assignee: null, dueInDays: null, project: { mode: "from_client", clientRef: "cliente.dominio" }, milestoneRef: null, approval: { mode: "auto" } }],
      titleTemplate: "R",
    };
    const [a] = await db.insert(automations).values({ code: `AUT-${seq}`, seq, name: "G", projectId: null, ownerId, status: "active", activeSince: new Date() }).returning();
    await db.insert(automationVersions).values({ automationId: a!.id, n: 1, flow, publishedAt: new Date() });
    await db.insert(automationRuns).values({ automationId: a!.id, n: 1, version: 1, title: "R", origin: "manual", status: "waiting_project", cursor: { path: "0" }, pending: { approverIds: [ownerId], preview: { clientKey }, path: "0", round: 0 }, projectIds: [] });
    void projectId;
    return a!;
  }
  async function userWith(permissions: string[]) {
    const u = await person();
    const [role] = await db.insert(roles).values({ name: `R ${randomUUID().slice(0, 6)}`, scope: "instance", permissions }).returning({ id: roles.id });
    await db.update(users).set({ instanceRoleId: role!.id }).where(eq(users.id, u.id));
    return u;
  }

  it("con integrations.manage: la scelta va in coda E la tabella si scrive (chiave normalizzata); il dettaglio dice rememberClient", async () => {
    const p = await project();
    const owner = await userWith(["automations.general.manage", "integrations.manage"]);
    await addMember(app, p.id, owner.id, "project_lead");
    const key = `Ricorda-${randomUUID().slice(0, 6)}.IT`;
    const a = await waitingRun(owner.id, p.id, key);
    const detail = (await call(owner.headers, "GET", `/automations/${a.code}/runs/1`)).json() as { permissions: { rememberClient: boolean } };
    expect(detail.permissions.rememberClient).toBe(true);
    const res = await call(owner.headers, "POST", `/automations/${a.code}/runs/1/project`, { projectId: p.id, expectedPath: "0", remember: true });
    expect(res.statusCode).toBe(204);
    expect(await db.select().from(clientProjectLinks).where(eq(clientProjectLinks.clientKey, key.toLowerCase()))).toEqual([expect.objectContaining({ projectId: p.id, addedBy: owner.id })]);
    const [run] = await db.select().from(automationRuns).where(eq(automationRuns.automationId, a.id));
    expect(await db.select().from(automationRunInputs).where(eq(automationRunInputs.runId, run!.id))).toHaveLength(1);
  });

  it("senza integrations.manage: 403, nessuna scelta in coda e nessuna riga (la regola del prototipo); senza remember la scelta passa", async () => {
    const p = await project();
    const owner = await userWith(["automations.general.manage"]);
    await addMember(app, p.id, owner.id, "project_lead");
    const key = `negato-${randomUUID().slice(0, 6)}.it`;
    const a = await waitingRun(owner.id, p.id, key);
    const detail = (await call(owner.headers, "GET", `/automations/${a.code}/runs/1`)).json() as { permissions: { rememberClient: boolean } };
    expect(detail.permissions.rememberClient).toBe(false);
    const res = await call(owner.headers, "POST", `/automations/${a.code}/runs/1/project`, { projectId: p.id, expectedPath: "0", remember: true });
    expect(res.statusCode).toBe(403);
    const [run] = await db.select().from(automationRuns).where(eq(automationRuns.automationId, a.id));
    expect(await db.select().from(automationRunInputs).where(eq(automationRunInputs.runId, run!.id))).toEqual([]);
    expect(await db.select().from(clientProjectLinks).where(eq(clientProjectLinks.clientKey, key))).toEqual([]);
    expect((await call(owner.headers, "POST", `/automations/${a.code}/runs/1/project`, { projectId: p.id, expectedPath: "0" })).statusCode).toBe(204);
  });
});
