import { randomBytes } from "node:crypto";
import { backlogItemRequesters, backlogItems, projects } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { requestToConvertViewSchema } from "@stubwise/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers, type SeededUsers } from "../test/fixtures.js";

/**
 * Le richieste da trasformare (integrazione area 2, fetta 3): servono a «Da
 * decidere» e al blocco «Richieste nuove» della Home. Voci di backlog nuove,
 * in rifinitura o pronte, non fuse, dei progetti visibili dove chi guarda può
 * creare task, dalla più recente; senza `backlog.view_all` solo le proprie.
 */

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";

let testDb: TestDb;
let app: FastifyInstance;
let users: SeededUsers;
let projectId: string;
let projectCode: string;
let viewerOnlyProjectId: string;
let hiddenProjectId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({ db: testDb.db, sessionSecret: SESSION_SECRET, encryptionKey: randomBytes(32).toString("base64") });
  users = await seedUsers(app);
  ({ projectId } = await seedRepository(testDb.db));
  ({ projectId: viewerOnlyProjectId } = await seedRepository(testDb.db));
  ({ projectId: hiddenProjectId } = await seedRepository(testDb.db));
  // Le richieste da trasformare sono dei progetti col backlog acceso.
  await testDb.db.update(projects).set({ backlogEnabled: true });
  await addMember(app, projectId, users.memberId, "developer");
  await addMember(app, viewerOnlyProjectId, users.memberId, "viewer");
  [{ code: projectCode }] = (await testDb.db
    .select({ code: projects.code })
    .from(projects)
    .where(eq(projects.id, projectId))) as [{ code: string }];
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

let minutes = 0;
async function item(
  pid: string,
  status: "new" | "refining" | "ready" | "converted" | "archived",
  over: Partial<typeof backlogItems.$inferInsert> = {},
): Promise<string> {
  minutes += 1;
  const [row] = await testDb.db
    .insert(backlogItems)
    .values({
      projectId: pid,
      title: `Richiesta ${minutes}`,
      source: "manual",
      status,
      urgency: "high",
      createdAt: new Date(Date.UTC(2026, 10, 1, 0, minutes)),
      ...over,
    })
    .returning({ id: backlogItems.id });
  return row!.id;
}

const list = async (cookie: string) => {
  const res = await app.inject({ method: "GET", url: "/api/requests/to-convert", headers: { cookie } });
  expect(res.statusCode, res.body).toBe(200);
  return z.array(requestToConvertViewSchema).parse(res.json());
};

describe("GET /api/requests/to-convert", () => {
  it("nuove, in rifinitura e pronte, non fuse, dalla più recente; codice, richiedenti e link al web vecchio", async () => {
    const a = await item(projectId, "new");
    const b = await item(projectId, "refining");
    const c = await item(projectId, "ready");
    await item(projectId, "converted");
    await item(projectId, "archived");
    await item(projectId, "new", { mergedIntoId: a });
    await testDb.db.insert(backlogItemRequesters).values({ itemId: b, userId: users.memberId });
    const rows = (await list(users.adminCookie)).filter((r) => r.projectId === projectId);
    expect(rows.map((r) => r.id)).toEqual([c, b, a]);
    const first = rows.find((r) => r.id === a)!;
    expect(first).toMatchObject({
      title: expect.stringMatching(/^Richiesta /),
      status: "new",
      urgency: "high",
      webHref: `/backlog/${a}`,
    });
    // Il codice di catalogo: `<PROGETTO>-R<n>`, n in ordine di creazione nel progetto.
    expect(first.code).toBe(`${projectCode}-R1`);
    expect(rows.find((r) => r.id === c)!.code).toBe(`${projectCode}-R3`);
    expect(rows.find((r) => r.id === b)!.requesterIds).toEqual([users.memberId]);
  });

  it("solo i progetti visibili dove chi guarda può creare task", async () => {
    const mine = await item(projectId, "new");
    const asViewer = await item(viewerOnlyProjectId, "new");
    const hidden = await item(hiddenProjectId, "new");
    const ids = (await list(users.memberCookie)).map((r) => r.id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(asViewer);
    expect(ids).not.toContain(hidden);
    // Un full admin le vede tutte.
    const all = (await list(users.adminCookie)).map((r) => r.id);
    expect(all).toEqual(expect.arrayContaining([mine, asViewer, hidden]));
  });

  it("senza backlog.view_all nel progetto, solo le richieste di cui si è richiedenti", async () => {
    const contributor = await createUserWithSession(app, "contributor@example.com");
    const { projectId: pid } = await seedRepository(testDb.db);
    await testDb.db.update(projects).set({ backlogEnabled: true }).where(eq(projects.id, pid));
    await addMember(app, pid, contributor.id, "contributor");
    const others = await item(pid, "new");
    const own = await item(pid, "new");
    await testDb.db.insert(backlogItemRequesters).values({ itemId: own, userId: contributor.id });
    expect((await list(contributor.headers.cookie)).map((r) => r.id)).toEqual([own]);
    expect(others).toBeDefined();
  });

  it("senza sessione → 401", async () => {
    expect((await app.inject({ method: "GET", url: "/api/requests/to-convert" })).statusCode).toBe(401);
  });

  it("un progetto col backlog spento non ha richieste da trasformare (fix fetta 3)", async () => {
    const { projectId: off } = await seedRepository(testDb.db);
    await addMember(app, off, users.memberId, "developer");
    const hiddenByToggle = await item(off, "new");
    expect((await list(users.memberCookie)).some((r) => r.id === hiddenByToggle)).toBe(false);
    await testDb.db.update(projects).set({ backlogEnabled: true }).where(eq(projects.id, off));
    expect((await list(users.memberCookie)).some((r) => r.id === hiddenByToggle)).toBe(true);
  });
});

