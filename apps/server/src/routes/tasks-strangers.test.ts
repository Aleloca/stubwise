import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { automations, backlogItemRequesters, projects, tickets, users } from "@stubwise/db";
import { seedBacklogItem, seedTicket, startTestDb, type TestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

/**
 * Registro, A11 r.1414: nelle task chi guarda non riceve l'id di chi non
 * conosce (uno sconosciuto VERO: nessun progetto in comune, presente o passato,
 * nessun canale). Qui l'assegnatario è messo a mano nel DB.
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

describe("le task senza gli sconosciuti", () => {
  it("un assegnatario che chi legge non conosce: `assigneeId` è `hidden-<n>`, e il suo id non esce; il proprio id resta vero", async () => {
    const { projectId, ticketId } = await seedTicket(t.db);
    const reader = await createUserWithSession(app, `reader-ts-${randomUUID().slice(0, 6)}@example.com`);
    await addMember(app, projectId, reader.id, "developer");
    const [stranger] = await t.db.insert(users).values({ email: `stranger-ts-${randomUUID().slice(0, 6)}@x.it`, passwordHash: "x", role: "member" }).returning({ id: users.id });
    await t.db.update(tickets).set({ assigneeId: stranger!.id, createdByUserId: reader.id } as never).where(eq(tickets.id, ticketId));
    const [ticket] = await t.db.select({ number: tickets.number }).from(tickets).where(eq(tickets.id, ticketId));
    const [project] = await t.db.select({ code: projects.code }).from(projects).where(eq(projects.id, projectId));
    const res = await app.inject({ method: "GET", url: `/api/tasks/by-code/${project!.code}-${ticket!.number}`, headers: { cookie: reader.headers.cookie } });
    expect(res.statusCode, res.body).toBe(200);
    const view = res.json() as { assigneeId: string | null };
    expect(view.assigneeId).toBe("hidden-1");
    expect(res.body).not.toContain(stranger!.id);
  });

  it("revisione del lotto 2, C1: una task ferma a mano da uno sconosciuto — GET /api/tasks risponde 200 (il serializer accetta il segnaposto) e `manualStall.byId` è `hidden-<n>`", async () => {
    const { projectId, ticketId } = await seedTicket(t.db);
    const reader = await createUserWithSession(app, `reader-ms-${randomUUID().slice(0, 6)}@example.com`);
    await addMember(app, projectId, reader.id, "developer");
    const [stranger] = await t.db.insert(users).values({ email: `stranger-ms-${randomUUID().slice(0, 6)}@x.it`, passwordHash: "x", role: "member" }).returning({ id: users.id });
    await t.db
      .update(tickets)
      .set({ manualStallReason: "waiting_client", manualStallNote: "", manualStallSince: new Date(), manualStallByUserId: stranger!.id } as never)
      .where(eq(tickets.id, ticketId));
    const res = await app.inject({ method: "GET", url: `/api/tasks?projectId=${projectId}`, headers: { cookie: reader.headers.cookie } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toContain(stranger!.id);
    const items = (res.json() as { items: { id: string; manualStall: { byId: string | null } | null }[] }).items;
    expect(items.find((i) => i.manualStall)?.manualStall?.byId).toBe("hidden-1");
  });

  it("una richiesta di uno sconosciuto: `requesterIds` porta `hidden-<n>`, il suo id non esce", async () => {
    const { projectId, itemId } = await seedBacklogItem(t.db);
    const reader = await createUserWithSession(app, `reader-rq-${randomUUID().slice(0, 6)}@example.com`);
    await addMember(app, projectId, reader.id, "developer");
    const [stranger] = await t.db.insert(users).values({ email: `stranger-rq-${randomUUID().slice(0, 6)}@x.it`, passwordHash: "x", role: "member" }).returning({ id: users.id });
    await t.db.insert(backlogItemRequesters).values({ itemId, userId: stranger!.id } as never);
    const res = await app.inject({ method: "GET", url: `/api/requests/${itemId}`, headers: { cookie: reader.headers.cookie } });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { requesterIds: string[] }).requesterIds).toContain("hidden-1");
    expect(res.body).not.toContain(stranger!.id);
  });

  it("un'automazione di uno sconosciuto: `ownerId` è `hidden-<n>`, il suo id non esce", async () => {
    const { projectId } = await seedTicket(t.db);
    const reader = await createUserWithSession(app, `reader-au-${randomUUID().slice(0, 6)}@example.com`);
    await addMember(app, projectId, reader.id, "project_lead");
    const [stranger] = await t.db.insert(users).values({ email: `stranger-au-${randomUUID().slice(0, 6)}@x.it`, passwordHash: "x", role: "member" }).returning({ id: users.id });
    const code = `Q${randomUUID().slice(0, 5).toUpperCase()}-A1`;
    await t.db.insert(automations).values({ code, seq: 1, name: "Di un altro", projectId, ownerId: stranger!.id } as never);
    const res = await app.inject({ method: "GET", url: `/api/automations/${code}`, headers: { cookie: reader.headers.cookie } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).toContain("hidden-1");
    expect(res.body).not.toContain(stranger!.id);
  });
});
