import { randomBytes } from "node:crypto";
import { notifications, projects, tickets } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedDecisionRequest, seedRepository, startTestDb } from "@stubwise/db/testing";
import {
  decisionRequestViewSchema,
  inboxPageSchema,
  projectDetailSchema,
  projectListItemSchema,
} from "@stubwise/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { addMember, seedUsers, type SeededUsers } from "../test/fixtures.js";

/**
 * Campi DERIVATI A LETTURA per l'app nuova (integrazione area 2, Task 22):
 * nessuno sta nel jsonb di un evento né in una colonna nuova, quindi valgono
 * anche per le card e le righe di prima (regola «si derivano a lettura» in
 * CLAUDE.md).
 */

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";

let testDb: TestDb;
let app: FastifyInstance;
let users: SeededUsers;
let projectId: string;
let code: string;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: randomBytes(32).toString("base64"),
  });
  users = await seedUsers(app);
  ({ projectId } = await seedRepository(testDb.db));
  await addMember(app, projectId, users.memberId, "project_lead");
  code = (await testDb.db.select({ code: projects.code }).from(projects).where(eq(projects.id, projectId)))[0]!.code;
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

const get = (url: string, cookie = users.memberCookie) => app.inject({ method: "GET", url, headers: { cookie } });

describe("InboxItem.taskCode", () => {
  it("una card vecchia senza taskCode nel jsonb lo ha comunque", async () => {
    const [ticket] = await testDb.db
      .insert(tickets)
      .values({ projectId, number: 41, title: "Vecchia", type: "bug", priority: "medium", source: "manual" })
      .returning({ id: tickets.id });
    // L'evento di una versione di prima: nessun codice, nessun riferimento.
    await testDb.db.insert(notifications).values({
      userId: users.memberId,
      projectId,
      ticketId: ticket!.id,
      kind: "ticket.created",
      event: {
        kind: "ticket.created",
        ticketNumber: 41,
        ticketTitle: "Vecchia",
        projectName: "Progetto",
        source: "sdk_error",
        ticketUrl: "https://x/tickets/41",
      },
      status: "open",
    });
    const res = await get("/api/inbox");
    expect(res.statusCode).toBe(200);
    const page = inboxPageSchema.parse(res.json());
    const card = page.items.find((i) => i.ticketId === ticket!.id)!;
    expect(card.taskCode).toBe(`${code}-41`);
  });

  it("una card senza ticket ha taskCode null", async () => {
    await testDb.db.insert(notifications).values({
      userId: users.memberId,
      kind: "security.alert",
      event: { kind: "security.alert", subject: "locked", actorEmail: null },
      status: "open",
    });
    const page = inboxPageSchema.parse((await get("/api/inbox")).json());
    expect(page.items.find((i) => i.kind === "security.alert")!.taskCode).toBeNull();
  });

  it("una risposta senza taskCode parsa (server più vecchio)", () => {
    const page = inboxPageSchema.parse({ items: [], nextCursor: null, total: 0 });
    expect(page.items).toEqual([]);
  });
});

describe("DecisionRequestView.projectId", () => {
  it("la decisione porta il progetto della sua task", async () => {
    const [ticket] = await testDb.db
      .insert(tickets)
      .values({ projectId, number: 42, title: "D", type: "bug", priority: "medium", source: "manual" })
      .returning({ id: tickets.id });
    await seedDecisionRequest(testDb.db, { ticketId: ticket!.id, askedOfUserId: users.memberId });
    const list = decisionRequestViewSchema.array().parse((await get(`/api/decisions?taskId=${ticket!.id}`)).json());
    expect(list[0]!.projectId).toBe(projectId);
  });

  it("una vista senza projectId parsa (server più vecchio)", () => {
    const parsed = decisionRequestViewSchema.parse({
      id: "0b1e6f3a-1111-4222-8333-444455556666",
      taskId: "0b1e6f3a-1111-4222-8333-444455556666",
      askedById: null,
      askedOfId: "0b1e6f3a-1111-4222-8333-444455556666",
      question: "?",
      options: [],
      createdAt: "2026-11-01T00:00:00.000Z",
      withdrawnAt: null,
      answer: null,
    });
    expect(parsed.projectId).toBeUndefined();
  });
});

describe("memberIds effettivi dei progetti", () => {
  it("un full admin non membro compare in memberIds, nell'elenco e nel dettaglio", async () => {
    const list = projectListItemSchema.array().parse((await get("/api/projects")).json());
    const listed = list.find((p) => p.id === projectId)!;
    expect([...(listed.memberIds ?? [])].sort()).toEqual([users.adminId, users.memberId].sort());
    const detail = projectDetailSchema.parse((await get(`/api/projects/${projectId}`)).json());
    expect([...(detail.memberIds ?? [])].sort()).toEqual([users.adminId, users.memberId].sort());
  });
});
