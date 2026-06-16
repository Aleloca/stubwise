import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { tickets } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import type { SeededUsers } from "../test/fixtures.js";
import { seedUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";

let testDb: TestDb;
let app: FastifyInstance;
let users: SeededUsers;
let projectId: string;
let otherProjectId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: randomBytes(32).toString("base64"),
  });
  users = await seedUsers(app);
  projectId = await createProject("Progetto Milestone");
  otherProjectId = await createProject("Progetto Milestone Beta");
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

async function createGitAccount(): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/git-accounts",
    headers: { cookie: users.adminCookie },
    payload: { name: "Account di test", provider: "github", credentials: { token: "token-di-test" } },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

async function createProject(name: string): Promise<string> {
  const gitAccountId = await createGitAccount();
  const res = await app.inject({
    method: "POST",
    url: "/api/projects",
    headers: { cookie: users.adminCookie },
    payload: {
      name,
      gitAccountId,
      repoUrl: `https://github.com/acme/${name.toLowerCase().replace(/\s+/g, "-")}`,
    },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

function createMilestone(payload: Record<string, unknown>, cookie = users.memberCookie) {
  return app.inject({
    method: "POST",
    url: "/api/milestones",
    headers: { cookie },
    payload,
  });
}

function listMilestones(query: Record<string, string>, cookie = users.memberCookie) {
  return app.inject({ method: "GET", url: "/api/milestones", query, headers: { cookie } });
}

function getMilestone(id: string, cookie = users.memberCookie) {
  return app.inject({ method: "GET", url: `/api/milestones/${id}`, headers: { cookie } });
}

function patchMilestone(id: string, payload: Record<string, unknown>, cookie = users.memberCookie) {
  return app.inject({ method: "PATCH", url: `/api/milestones/${id}`, headers: { cookie }, payload });
}

function deleteMilestone(id: string, cookie = users.memberCookie) {
  return app.inject({ method: "DELETE", url: `/api/milestones/${id}`, headers: { cookie } });
}

async function createTicketInMilestone(
  ms: string,
  status: string,
  title: string,
): Promise<string> {
  const post = await app.inject({
    method: "POST",
    url: "/api/tickets",
    headers: { cookie: users.memberCookie },
    payload: { projectId, title, type: "bug" },
  });
  expect(post.statusCode).toBe(201);
  const id = (post.json() as { id: string }).id;
  // Assegna milestone + stato direttamente sul DB per evitare di dipendere
  // dalle transizioni della PATCH (testate altrove).
  await testDb.db
    .update(tickets)
    .set({ milestoneId: ms, status: status as never })
    .where(eq(tickets.id, id));
  return id;
}

interface MilestoneBody {
  id: string;
  projectId: string;
  name: string;
  dueDate: string | null;
  status: string;
  createdAt: string;
  counts?: {
    total: number;
    completed: number;
    byStatus: Record<string, number>;
  };
}

describe("POST /api/milestones", () => {
  it("crea una milestone: 201 + proiezione esplicita", async () => {
    const res = await createMilestone({ projectId, name: "v1.0", dueDate: "2026-12-31T00:00:00.000Z" });
    expect(res.statusCode).toBe(201);
    const body = res.json() as MilestoneBody;
    expect(body).toEqual({
      id: expect.any(String),
      projectId,
      name: "v1.0",
      dueDate: "2026-12-31T00:00:00.000Z",
      status: "open",
      createdAt: expect.any(String),
    });
  });

  it("dueDate opzionale (null di default)", async () => {
    const res = await createMilestone({ projectId, name: "senza-scadenza" });
    expect(res.statusCode).toBe(201);
    expect((res.json() as MilestoneBody).dueDate).toBeNull();
  });

  it("nome duplicato nello stesso progetto: 409 milestone_exists", async () => {
    await createMilestone({ projectId, name: "dup" });
    const res = await createMilestone({ projectId, name: "dup" });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("milestone_exists");
  });

  it("stesso nome in progetto diverso: ok", async () => {
    await createMilestone({ projectId, name: "shared-name" });
    const res = await createMilestone({ projectId: otherProjectId, name: "shared-name" });
    expect(res.statusCode).toBe(201);
  });

  it("progetto inesistente: 404 project_not_found", async () => {
    const res = await createMilestone({ projectId: randomUUID(), name: "orfana" });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe("project_not_found");
  });

  it("senza sessione: 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/milestones",
      payload: { projectId, name: "no-auth" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/milestones — lista con counts e ordinamento", () => {
  let listProjectId: string;

  beforeAll(async () => {
    listProjectId = await createProject("Progetto Lista");
  });

  function createMs(payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/milestones",
      headers: { cookie: users.memberCookie },
      payload: { projectId: listProjectId, ...payload },
    });
  }

  async function ticketInMs(ms: string, status: string): Promise<void> {
    const post = await app.inject({
      method: "POST",
      url: "/api/tickets",
      headers: { cookie: users.memberCookie },
      payload: { projectId: listProjectId, title: "t", type: "bug" },
    });
    const id = (post.json() as { id: string }).id;
    await testDb.db
      .update(tickets)
      .set({ milestoneId: ms, status: status as never })
      .where(eq(tickets.id, id));
  }

  it("counts corretti: total, completed (done), byStatus", async () => {
    const ms = (await createMs({ name: "counts-ms" })).json() as MilestoneBody;
    await ticketInMs(ms.id, "open");
    await ticketInMs(ms.id, "in_progress");
    await ticketInMs(ms.id, "done");
    await ticketInMs(ms.id, "done");

    const res = await listMilestones({ projectId: listProjectId });
    expect(res.statusCode).toBe(200);
    const items = res.json() as MilestoneBody[];
    const found = items.find((m) => m.id === ms.id);
    expect(found?.counts?.total).toBe(4);
    expect(found?.counts?.completed).toBe(2);
    expect(found?.counts?.byStatus.done).toBe(2);
    expect(found?.counts?.byStatus.open).toBe(1);
    expect(found?.counts?.byStatus.in_progress).toBe(1);
  });

  it("milestone senza ticket: counts a zero", async () => {
    const ms = (await createMs({ name: "empty-ms" })).json() as MilestoneBody;
    const res = await listMilestones({ projectId: listProjectId });
    const found = (res.json() as MilestoneBody[]).find((m) => m.id === ms.id);
    expect(found?.counts?.total).toBe(0);
    expect(found?.counts?.completed).toBe(0);
    expect(found?.counts?.byStatus.done ?? 0).toBe(0);
  });

  it("ordinamento: open prima di closed, poi dueDate asc (NULLS LAST), poi name", async () => {
    const orderProjectId = await createProject("Progetto Ordine");
    async function ms(payload: Record<string, unknown>) {
      const r = await app.inject({
        method: "POST",
        url: "/api/milestones",
        headers: { cookie: users.memberCookie },
        payload: { projectId: orderProjectId, ...payload },
      });
      return (r.json() as MilestoneBody).id;
    }
    await ms({ name: "B-open-nodate" });
    await ms({ name: "A-open-nodate" });
    await ms({ name: "open-late", dueDate: "2027-01-01T00:00:00.000Z" });
    await ms({ name: "open-early", dueDate: "2026-01-01T00:00:00.000Z" });
    await ms({ name: "closed-ms", status: "closed" });

    const res = await listMilestones({ projectId: orderProjectId });
    const names = (res.json() as MilestoneBody[]).map((m) => m.name);
    expect(names).toEqual([
      "open-early",
      "open-late",
      "A-open-nodate",
      "B-open-nodate",
      "closed-ms",
    ]);
  });

  it("projectId mancante: errore di validazione", async () => {
    const res = await listMilestones({});
    expect(res.statusCode).toBe(400);
  });

  it("senza sessione: 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/milestones", query: { projectId } });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/milestones/:id", () => {
  it("dettaglio con counts", async () => {
    const ms = (await createMilestone({ projectId, name: "detail-ms" })).json() as MilestoneBody;
    await createTicketInMilestone(ms.id, "done", "done one");
    await createTicketInMilestone(ms.id, "open", "open one");

    const res = await getMilestone(ms.id);
    expect(res.statusCode).toBe(200);
    const body = res.json() as MilestoneBody;
    expect(body.id).toBe(ms.id);
    expect(body.counts?.total).toBe(2);
    expect(body.counts?.completed).toBe(1);
  });

  it("milestone inesistente: 404 milestone_not_found", async () => {
    const res = await getMilestone(randomUUID());
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe("milestone_not_found");
  });

  it("senza sessione: 401", async () => {
    const ms = (await createMilestone({ projectId, name: "detail-401" })).json() as MilestoneBody;
    const res = await app.inject({ method: "GET", url: `/api/milestones/${ms.id}` });
    expect(res.statusCode).toBe(401);
  });
});

describe("PATCH /api/milestones/:id", () => {
  it("aggiorna name, dueDate e status", async () => {
    const ms = (await createMilestone({ projectId, name: "patch-ms" })).json() as MilestoneBody;
    const res = await patchMilestone(ms.id, {
      name: "patch-ms-renamed",
      dueDate: "2026-06-30T00:00:00.000Z",
      status: "closed",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as MilestoneBody;
    expect(body.name).toBe("patch-ms-renamed");
    expect(body.dueDate).toBe("2026-06-30T00:00:00.000Z");
    expect(body.status).toBe("closed");
    expect(body.counts).toBeDefined();
  });

  it("azzera dueDate (null)", async () => {
    const ms = (
      await createMilestone({ projectId, name: "patch-nulldate", dueDate: "2026-06-30T00:00:00.000Z" })
    ).json() as MilestoneBody;
    const res = await patchMilestone(ms.id, { dueDate: null });
    expect(res.statusCode).toBe(200);
    expect((res.json() as MilestoneBody).dueDate).toBeNull();
  });

  it("collisione name nello stesso progetto: 409 milestone_exists", async () => {
    await createMilestone({ projectId, name: "patch-existing" });
    const ms = (await createMilestone({ projectId, name: "patch-tomove" })).json() as MilestoneBody;
    const res = await patchMilestone(ms.id, { name: "patch-existing" });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("milestone_exists");
  });

  it("nessun campo: errore coerente col pattern (400)", async () => {
    const ms = (await createMilestone({ projectId, name: "patch-empty" })).json() as MilestoneBody;
    const res = await patchMilestone(ms.id, {});
    expect(res.statusCode).toBe(400);
  });

  it("milestone inesistente: 404", async () => {
    const res = await patchMilestone(randomUUID(), { name: "x" });
    expect(res.statusCode).toBe(404);
  });

  it("senza sessione: 401", async () => {
    const ms = (await createMilestone({ projectId, name: "patch-401" })).json() as MilestoneBody;
    const res = await app.inject({
      method: "PATCH",
      url: `/api/milestones/${ms.id}`,
      payload: { name: "y" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("DELETE /api/milestones/:id", () => {
  it("204 e i ticket assegnati restano con milestoneId null", async () => {
    const ms = (await createMilestone({ projectId, name: "delete-ms" })).json() as MilestoneBody;
    const ticketId = await createTicketInMilestone(ms.id, "open", "delete ticket");

    const res = await deleteMilestone(ms.id);
    expect(res.statusCode).toBe(204);

    const [row] = await testDb.db.select().from(tickets).where(eq(tickets.id, ticketId));
    expect(row).toBeDefined();
    expect(row?.milestoneId).toBeNull();
  });

  it("milestone inesistente: 404", async () => {
    const res = await deleteMilestone(randomUUID());
    expect(res.statusCode).toBe(404);
  });

  it("senza sessione: 401", async () => {
    const ms = (await createMilestone({ projectId, name: "delete-401" })).json() as MilestoneBody;
    const res = await app.inject({ method: "DELETE", url: `/api/milestones/${ms.id}` });
    expect(res.statusCode).toBe(401);
  });
});
