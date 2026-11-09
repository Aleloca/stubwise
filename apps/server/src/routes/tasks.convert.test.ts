import { randomBytes } from "node:crypto";
import { backlogItemRequesters, backlogItemTickets, backlogItems, tickets } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedBacklogItem, seedRepository, startTestDb } from "@stubwise/db/testing";
import { requestToConvertViewSchema } from "@stubwise/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession } from "../test/fixtures.js";

/**
 * Fix della fetta 3: trasformare una richiesta in task (`POST /api/tasks` con
 * `requestId`) la segna `converted`, come nel prototipo e come
 * `POST /api/backlog/:id/convert`; così non torna in «Da decidere». Una voce
 * già convertita o archiviata non si converte (409, come nel prototipo). Il permesso è `tickets.create` («crea una
 * task da zero o da una richiesta», design dell'area 2).
 */

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";

let testDb: TestDb;
let app: FastifyInstance;
let projectId: string;
let dev: { id: string; headers: { cookie: string } };
let contributor: { id: string; headers: { cookie: string } };

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({ db: testDb.db, sessionSecret: SESSION_SECRET, encryptionKey: randomBytes(32).toString("base64") });
  ({ projectId } = await seedRepository(testDb.db));
  dev = await createUserWithSession(app, "dev@example.com");
  contributor = await createUserWithSession(app, "contrib@example.com");
  await addMember(app, projectId, dev.id, "developer");
  await addMember(app, projectId, contributor.id, "contributor");
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

const convert = (requestId: string, cookie: string, title = "Dalla richiesta") =>
  app.inject({
    method: "POST",
    url: "/api/tasks",
    headers: { cookie },
    payload: { projectId, title, type: "feature", requestId },
  });

const statusOf = async (id: string) =>
  (await testDb.db.select({ s: backlogItems.status }).from(backlogItems).where(eq(backlogItems.id, id)))[0]!.s;

describe("POST /api/tasks con requestId (fix fetta 3)", () => {
  it("dopo createTask con requestId la voce è converted e non compare in to-convert", async () => {
    const { itemId } = await seedBacklogItem(testDb.db, { projectId, status: "ready" });
    const res = await convert(itemId, dev.headers.cookie);
    expect(res.statusCode, res.body).toBe(201);
    expect(await statusOf(itemId)).toBe("converted");
    const list = z
      .array(requestToConvertViewSchema)
      .parse((await app.inject({ method: "GET", url: "/api/requests/to-convert", headers: { cookie: dev.headers.cookie } })).json());
    expect(list.some((r) => r.id === itemId)).toBe(false);
  });

  it("una voce archived o già converted → 409 request_not_convertible e nessuna task (come nel prototipo)", async () => {
    for (const status of ["archived", "converted"] as const) {
      const { itemId } = await seedBacklogItem(testDb.db, { projectId, status });
      const title = `Da ${status}`;
      const res = await convert(itemId, dev.headers.cookie, title);
      expect(res.statusCode, status).toBe(409);
      expect(res.json()).toMatchObject({ code: "request_not_convertible" });
      expect(await statusOf(itemId)).toBe(status);
      expect(await testDb.db.select().from(tickets).where(eq(tickets.title, title))).toHaveLength(0);
      expect(await testDb.db.select().from(backlogItemTickets).where(eq(backlogItemTickets.itemId, itemId))).toHaveLength(0);
    }
  });

  it("una voce che chi chiede non vede (Contributor, non richiedente) → 400 request_not_found come un'inesistente, e voce invariata", async () => {
    const { itemId } = await seedBacklogItem(testDb.db, { projectId, status: "new" });
    const res = await convert(itemId, contributor.headers.cookie, "Di un altro");
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "request_not_found" });
    expect(await statusOf(itemId)).toBe("new");
    expect(await testDb.db.select().from(tickets).where(eq(tickets.title, "Di un altro"))).toHaveLength(0);
    // Stessa risposta di una voce che non esiste.
    const missing = await convert("00000000-0000-4000-8000-0000000000ee", contributor.headers.cookie, "Inesistente");
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ code: "request_not_found" });
  });

  it("un Contributor con tickets.create converte e la voce è converted (il permesso è tickets.create, come nel design)", async () => {
    const { itemId } = await seedBacklogItem(testDb.db, { projectId, status: "new" });
    // Senza backlog.view_all vede solo le richieste che ha fatto: è una sua.
    await testDb.db.insert(backlogItemRequesters).values({ itemId, userId: contributor.id });
    const res = await convert(itemId, contributor.headers.cookie, "Convertita dal contributor");
    expect(res.statusCode, res.body).toBe(201);
    expect(await statusOf(itemId)).toBe("converted");
  });

  it("la task eredita come richiedente il richiedente PIÙ VECCHIO della voce; effort e piano no (come nel prototipo)", async () => {
    const { itemId } = await seedBacklogItem(testDb.db, { projectId, status: "ready" });
    await testDb.db.update(backlogItems).set({ effort: 3, implementationPlan: "Il piano" }).where(eq(backlogItems.id, itemId));
    await testDb.db.insert(backlogItemRequesters).values([
      { itemId, userId: contributor.id, requestedAt: new Date("2026-10-01T10:00:00Z") },
      { itemId, userId: dev.id, requestedAt: new Date("2026-10-05T10:00:00Z") },
    ]);
    const res = await convert(itemId, dev.headers.cookie, "Eredita il richiedente");
    expect(res.statusCode, res.body).toBe(201);
    const [t] = await testDb.db
      .select({ by: tickets.requestedByUserId, effort: tickets.effort, plan: tickets.implementationPlan })
      .from(tickets)
      .where(eq(tickets.title, "Eredita il richiedente"));
    expect(t).toEqual({ by: contributor.id, effort: null, plan: null });
  });

  it("chi converte senza tickets.view_all resta richiedente se il più vecchio è un altro (altrimenti non vedrebbe la task che ha creato)", async () => {
    const { itemId } = await seedBacklogItem(testDb.db, { projectId, status: "new" });
    await testDb.db.insert(backlogItemRequesters).values([
      { itemId, userId: dev.id, requestedAt: new Date("2026-10-01T10:00:00Z") },
      { itemId, userId: contributor.id, requestedAt: new Date("2026-10-05T10:00:00Z") },
    ]);
    const res = await convert(itemId, contributor.headers.cookie, "Resta del contributor");
    expect(res.statusCode, res.body).toBe(201);
    const [t] = await testDb.db.select({ by: tickets.requestedByUserId }).from(tickets).where(eq(tickets.title, "Resta del contributor"));
    expect(t!.by).toBe(contributor.id);
  });
});

