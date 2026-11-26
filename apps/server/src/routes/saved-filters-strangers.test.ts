import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { milestones, projectStatuses, taskFilters, tickets, users } from "@stubwise/db";
import { seedTicket, startTestDb, type TestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

/**
 * Registro, A11 r.1414, la scelta A di 46 su filtri salvati e Drive (forma
 * concordata con 94): nei criteri un assegnatario sconosciuto è `hidden-<n>`;
 * un segnaposto non si salva; l'esecuzione lo risolve SOLO col filtro salvato
 * (`savedFilterId`), che ha gli id veri; nel Drive un segnaposto non filtra.
 */
let t: TestDb;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40) });
  await seedUsers(app);
}, 120_000);
afterAll(async () => {
  await app.close();
  await t.stop();
});

type U = Awaited<ReturnType<typeof createUserWithSession>>;
const get = (who: U, url: string) => app.inject({ method: "GET", url, headers: { cookie: who.headers.cookie } });
const send = (who: U, method: "POST" | "PATCH", url: string, payload: object) => app.inject({ method, url, headers: { cookie: who.headers.cookie }, payload });

/** Una task assegnata a uno sconosciuto, una a un collega, e un filtro di chi legge che li nomina. */
async function scene() {
  const { projectId, repositoryId, ticketId } = await seedTicket(t.db);
  const { ticketId: otherTicket } = await seedTicket(t.db, { projectId, repositoryId, number: 2 });
  const reader = await createUserWithSession(app, `reader-sf-${randomUUID().slice(0, 6)}@example.com`);
  const colleague = await createUserWithSession(app, `coll-sf-${randomUUID().slice(0, 6)}@example.com`);
  await addMember(app, projectId, reader.id, "developer");
  await addMember(app, projectId, colleague.id, "developer");
  const [stranger] = await t.db.insert(users).values({ email: `stranger-sf-${randomUUID().slice(0, 6)}@x.it`, passwordHash: "x", role: "member" }).returning({ id: users.id });
  await t.db.update(tickets).set({ assigneeId: stranger!.id } as never).where(eq(tickets.id, ticketId));
  await t.db.update(tickets).set({ assigneeId: colleague.id } as never).where(eq(tickets.id, otherTicket));
  const [filter] = await t.db
    .insert(taskFilters)
    .values({ name: "Miei", ownerId: reader.id, visibility: "private", criteria: { assigneeIds: [stranger!.id, "none", reader.id] }, view: "list", groupBy: "none" } as never)
    .returning({ id: taskFilters.id });
  return { projectId, ticketId, otherTicket, reader, colleague, stranger: stranger!.id, filterId: filter!.id };
}

describe("i filtri salvati senza gli sconosciuti", () => {
  it("lettura: un assegnatario sconosciuto nei criteri è `hidden-<n>`; `none` e il proprio id restano", async () => {
    const s = await scene();
    const one = await get(s.reader, `/api/filters/${s.filterId}`);
    expect(one.statusCode, one.body).toBe(200);
    expect((one.json() as { criteria: { assigneeIds: string[] } }).criteria.assigneeIds).toEqual(["hidden-1", "none", s.reader.id]);
    expect(one.body).not.toContain(s.stranger);
    const list = await get(s.reader, "/api/filters");
    expect(list.body).not.toContain(s.stranger);
  });

  it("salvataggio: un segnaposto nei criteri senza il filtro d'origine è 400 `invalid`; una PATCH senza criteri li lascia veri", async () => {
    const s = await scene();
    const bad = { name: "X", visibility: "private", criteria: { assigneeIds: ["hidden-1"] }, view: "list", groupBy: "none" };
    const post = await send(s.reader, "POST", "/api/filters", bad);
    expect([post.statusCode, (post.json() as { code: string }).code]).toEqual([400, "invalid"]);
    const renamed = await send(s.reader, "PATCH", `/api/filters/${s.filterId}`, { name: "Rinominato" });
    expect(renamed.statusCode, renamed.body).toBe(200);
    const [row] = await t.db.select().from(taskFilters).where(eq(taskFilters.id, s.filterId));
    expect(row!.criteria).toEqual({ assigneeIds: [s.stranger, "none", s.reader.id] });
  });

  it("revisione 3bbe2ddc6..444b8b773, I-6: una PATCH coi criteri cambiati rimette al posto del segnaposto gli id del filtro stesso", async () => {
    const s = await scene();
    const res = await send(s.reader, "PATCH", `/api/filters/${s.filterId}`, { criteria: { assigneeIds: ["hidden-1", "none"], stalled: true } });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { criteria: { assigneeIds: string[] } }).criteria.assigneeIds).toEqual(["hidden-1", "none"]);
    const [row] = await t.db.select().from(taskFilters).where(eq(taskFilters.id, s.filterId));
    expect(row!.criteria).toEqual({ assigneeIds: [s.stranger, "none"], stalled: true });
  });

  it("revisione 3bbe2ddc6..444b8b773, I-6: un POST col `savedFilterId` d'origine («salva come») rimette gli id veri; senza, o con un filtro che non vede, 400", async () => {
    const s = await scene();
    const body = { name: "Copia", visibility: "private", criteria: { assigneeIds: ["hidden-1"] }, view: "list", groupBy: "none" };
    const ok = await send(s.reader, "POST", "/api/filters", { ...body, savedFilterId: s.filterId });
    expect(ok.statusCode, ok.body).toBe(201);
    const [copy] = await t.db.select().from(taskFilters).where(eq(taskFilters.id, (ok.json() as { id: string }).id));
    expect(copy!.criteria).toEqual({ assigneeIds: [s.stranger] });
    expect(ok.body).not.toContain(s.stranger);
    expect((await send(s.colleague, "POST", "/api/filters", { ...body, savedFilterId: s.filterId })).statusCode).toBe(400);
    // Un filtro d'origine che non nomina sconosciuti: il segnaposto non si risolve.
    await t.db.update(taskFilters).set({ criteria: { assigneeIds: [s.reader.id] } } as never).where(eq(taskFilters.id, s.filterId));
    expect((await send(s.reader, "POST", "/api/filters", { ...body, savedFilterId: s.filterId })).statusCode).toBe(400);
    expect((await send(s.reader, "PATCH", `/api/filters/${s.filterId}`, { criteria: { assigneeIds: ["hidden-1"] } })).statusCode).toBe(400);
  });

  it("esecuzione: con `savedFilterId` il segnaposto diventa gli id veri del filtro; gli id veri del client restano; l'assegnatario resta mascherato", async () => {
    const s = await scene();
    const res = await get(s.reader, `/api/tasks?projectIds=${s.projectId}&assigneeIds=hidden-1,${s.colleague.id}&savedFilterId=${s.filterId}`);
    expect(res.statusCode, res.body).toBe(200);
    const items = (res.json() as { items: { id: string; assigneeId: string | null }[] }).items;
    expect(items.map((i) => i.id).sort()).toEqual([s.ticketId, s.otherTicket].sort());
    expect(items.find((i) => i.id === s.ticketId)!.assigneeId).toBe("hidden-1");
    expect(res.body).not.toContain(s.stranger);
    // Solo il segnaposto: la sola task dello sconosciuto.
    const only = await get(s.reader, `/api/tasks?projectIds=${s.projectId}&assigneeIds=hidden-1&savedFilterId=${s.filterId}`);
    expect((only.json() as { items: { id: string }[] }).items.map((i) => i.id)).toEqual([s.ticketId]);
    expect((await get(s.reader, `/api/tasks/stalled?assigneeIds=hidden-1&savedFilterId=${s.filterId}`)).statusCode).toBe(200);
    // Un filtro che non nomina sconosciuti: il segnaposto non trova NESSUNO, non tutte le task.
    await t.db.update(taskFilters).set({ criteria: { assigneeIds: [s.reader.id] } } as never).where(eq(taskFilters.id, s.filterId));
    const none = await get(s.reader, `/api/tasks?projectIds=${s.projectId}&assigneeIds=hidden-1&savedFilterId=${s.filterId}`);
    expect((none.json() as { items: unknown[] }).items).toEqual([]);
  });

  it("esecuzione: senza `savedFilterId`, o con un filtro che chi guarda non vede, un segnaposto è 400 `invalid`", async () => {
    const s = await scene();
    for (const url of [`/api/tasks?assigneeIds=hidden-1`, `/api/tasks/stalled?assigneeIds=hidden-1`, `/api/tasks?assigneeIds=hidden-1&savedFilterId=${s.filterId}`]) {
      const who = url.includes("savedFilterId") ? s.colleague : s.reader;
      const res = await get(who, url);
      expect([res.statusCode, (res.json() as { code: string }).code], url).toEqual([400, "invalid"]);
    }
    expect((await get(s.reader, `/api/tasks?assigneeIds=hidden-1&savedFilterId=${randomUUID()}`)).statusCode).toBe(400);
  });

  it("il Drive: un segnaposto come filtro di chi ha aggiunto è 400 `invalid`", async () => {
    const s = await scene();
    for (const url of [`/api/drive/files?addedById=hidden-1`, `/api/projects/${s.projectId}/drive/files?addedById=hidden-1`]) {
      const res = await get(s.reader, url);
      expect([res.statusCode, (res.json() as { code: string }).code], url).toEqual([400, "invalid"]);
    }
  });
});

describe("i filtri pubblici senza i progetti che chi guarda non vede (revisione 3bbe2ddc6..444b8b773, M-1)", () => {
  /** Un filtro pubblico di un collega che nomina il progetto di chi legge (P1) e uno che chi legge non vede (P2). */
  async function scope() {
    const s = await scene();
    const { projectId: p2 } = await seedTicket(t.db);
    await addMember(app, p2, s.colleague.id, "developer");
    const statusOf = async (projectId: string) => (await t.db.select({ id: projectStatuses.id }).from(projectStatuses).where(eq(projectStatuses.projectId, projectId)).limit(1))[0]!.id;
    const [s1, s2] = [await statusOf(s.projectId), await statusOf(p2)];
    const [m2] = await t.db.insert(milestones).values({ projectId: p2, name: "Lancio" } as never).returning({ id: milestones.id });
    const [pub] = await t.db
      .insert(taskFilters)
      .values({ name: "Pubblico", ownerId: s.colleague.id, visibility: "public", criteria: { projectIds: [s.projectId, p2], statusIds: [s1, s2], milestoneIds: [m2!.id] }, view: "list", groupBy: "none" } as never)
      .returning({ id: taskFilters.id });
    return { ...s, p2, s1, s2, m2: m2!.id, publicId: pub!.id };
  }

  it("lettura: i progetti, gli stati e i traguardi di un progetto che chi legge non vede non escono", async () => {
    const s = await scope();
    const res = await get(s.reader, `/api/filters/${s.publicId}`);
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { criteria: Record<string, unknown> }).criteria).toEqual({ projectIds: [s.projectId], statusIds: [s.s1] });
    for (const leak of [s.p2, s.s2, s.m2]) expect(res.body).not.toContain(leak);
    expect((await get(s.reader, "/api/filters")).body).not.toContain(s.p2);
    // Chi li vede li riceve.
    expect((await get(s.colleague, `/api/filters/${s.publicId}`)).json()).toMatchObject({ criteria: { projectIds: [s.projectId, s.p2], milestoneIds: [s.m2] } });
  });

  it("esecuzione: con `savedFilterId` le restrizioni nascoste tornano, e un filtro solo su un progetto invisibile non trova niente (mai tutte le task)", async () => {
    const s = await scope();
    await t.db.update(taskFilters).set({ criteria: { projectIds: [s.p2] } } as never).where(eq(taskFilters.id, s.publicId));
    // Il client manda i criteri che ha letto: nessun progetto.
    expect(((await get(s.reader, `/api/tasks`)).json() as { items: unknown[] }).items.length).toBeGreaterThan(0);
    const res = await get(s.reader, `/api/tasks?savedFilterId=${s.publicId}`);
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { items: unknown[] }).items).toEqual([]);
  });

  it("salvataggio: una PATCH coi criteri cambiati tiene le restrizioni che chi salva non vede", async () => {
    const s = await scope();
    // Il filtro di chi legge nomina P2 (per esempio, un accesso perso dopo averlo salvato).
    await t.db.update(taskFilters).set({ criteria: { assigneeIds: [s.reader.id], projectIds: [s.projectId, s.p2], milestoneIds: [s.m2] } } as never).where(eq(taskFilters.id, s.filterId));
    const res = await send(s.reader, "PATCH", `/api/filters/${s.filterId}`, { criteria: { projectIds: [s.projectId], stalled: true } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toContain(s.p2);
    const [row] = await t.db.select().from(taskFilters).where(eq(taskFilters.id, s.filterId));
    expect(row!.criteria).toEqual({ projectIds: [s.projectId, s.p2], milestoneIds: [s.m2], stalled: true });
  });
});
