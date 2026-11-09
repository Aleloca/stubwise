import { randomBytes, randomUUID } from "node:crypto";
import { departmentMembers, departmentRoles, departments } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { departmentHomeViewSchema, meHomeViewSchema, sessionResponseSchema } from "@stubwise/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildApp } from "../app.js";
import { createUserWithSession, seedUsers, type SeededUsers } from "../test/fixtures.js";

/**
 * La Home a blocchi e i ruoli di reparto (integrazione area 2, fetta 3): il
 * server risponde con la Home già risolta per chi guarda (regole di
 * `@stubwise/shared`), valida i blocchi in scrittura, e la Home di un reparto
 * la cambia un full admin o chi ha `department.home.manage` in quel reparto.
 */

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";

let testDb: TestDb;
let app: FastifyInstance;
let users: SeededUsers;
let person: { id: string; headers: { cookie: string } };

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({ db: testDb.db, sessionSecret: SESSION_SECRET, encryptionKey: randomBytes(32).toString("base64") });
  users = await seedUsers(app);
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, cookie: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

async function department(): Promise<string> {
  const [d] = await testDb.db
    .insert(departments)
    .values({ name: `Reparto ${randomUUID().slice(0, 8)}`, colorToken: "--dept-3" })
    .returning({ id: departments.id });
  return d!.id;
}

/** Una persona nuova che sta SOLO nei reparti dati, in quell'ordine. */
async function personIn(departmentIds: string[]) {
  const p = await createUserWithSession(app, `${randomUUID()}@example.com`);
  await testDb.db.delete(departmentMembers).where(eq(departmentMembers.userId, p.id));
  if (departmentIds.length) {
    await testDb.db
      .insert(departmentMembers)
      .values(departmentIds.map((departmentId, position) => ({ departmentId, userId: p.id, position })));
  }
  return p;
}

const setDepartmentHome = (id: string, blocks: object[], cookie = users.adminCookie) =>
  call("PUT", `/api/departments/${id}/home`, cookie, { blocks });

async function myHome(cookie: string) {
  const res = await call("GET", "/api/me/home", cookie);
  expect(res.statusCode, res.body).toBe(200);
  return meHomeViewSchema.parse(res.json());
}

async function publicFilter(cookie: string, visibility: "public" | "private" = "public"): Promise<string> {
  const res = await call("POST", "/api/filters", cookie, {
    name: "F",
    visibility,
    criteria: {},
    view: "list",
    groupBy: "none",
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { id: string }).id;
}

describe("GET /api/me/home", () => {
  it("senza Home personale: l'unione delle Home dei reparti nell'ordine del primo, lo stesso blocco una volta", async () => {
    const d1 = await department();
    const d2 = await department();
    const f = await publicFilter(users.adminCookie);
    expect((await setDepartmentHome(d1, [{ kind: "myTasks" }, { kind: "filter", filterId: f }])).statusCode).toBe(200);
    expect((await setDepartmentHome(d2, [{ kind: "newRequests" }, { kind: "myTasks" }, { kind: "filter", filterId: f }])).statusCode).toBe(200);
    person = await personIn([d2, d1]);
    const home = await myHome(person.headers.cookie);
    expect(home.blocks).toEqual([
      { kind: "decide" },
      { kind: "myWeek" },
      { kind: "newRequests" },
      { kind: "myTasks" },
      { kind: "filter", filterId: f },
    ]);
    expect(home.personal).toBeNull();
    expect(home.departmentChanged).toEqual([]);
    expect(home.departmentIds).toEqual([d2, d1]);
    expect(home.departmentHomes.map((h) => h.departmentId).sort()).toEqual([d1, d2].sort());
  });

  it("chi sta in un reparto senza Home sua vede i fissi", async () => {
    const empty = await department();
    const p = await personIn([empty]);
    expect((await myHome(p.headers.cookie)).blocks).toEqual([{ kind: "decide" }, { kind: "myWeek" }]);
  });
});

describe("Home personale", () => {
  it("si salva normalizzata, un kind ignoto passa, un filtro che non vedo → 400; ripristinare torna ai reparti", async () => {
    const d = await department();
    await setDepartmentHome(d, [{ kind: "myTasks" }]);
    const p = await personIn([d]);
    const othersPrivate = await publicFilter(users.adminCookie, "private");
    const bad = await call("PUT", "/api/me/home", p.headers.cookie, {
      blocks: [{ kind: "filter", filterId: othersPrivate }],
    });
    expect(bad.statusCode).toBe(400);
    expect((bad.json() as { code: string }).code).toBe("filter_not_visible");
    expect(
      (await call("PUT", "/api/me/home", p.headers.cookie, { blocks: [{ kind: "filter", filterId: "non-un-uuid" }] }))
        .statusCode,
    ).toBe(400);
    const res = await call("PUT", "/api/me/home", p.headers.cookie, {
      blocks: [{ kind: "claudeForMe" }, { kind: "claudeForMe" }, { kind: "dashboardFuturo" }],
    });
    expect(res.statusCode, res.body).toBe(200);
    const saved = meHomeViewSchema.parse(res.json());
    expect(saved.blocks).toEqual([
      { kind: "decide" },
      { kind: "myWeek" },
      { kind: "claudeForMe" },
      { kind: "dashboardFuturo" },
    ]);
    expect(saved.personal!.blocks).toEqual(saved.blocks);
    // Chi personalizza parte da ciò che vede: la Home del reparto è già «vista».
    expect(saved.departmentChanged).toEqual([]);
    expect((await call("DELETE", "/api/me/home", p.headers.cookie)).statusCode).toBe(204);
    const back = await myHome(p.headers.cookie);
    expect(back.personal).toBeNull();
    expect(back.blocks).toEqual([{ kind: "decide" }, { kind: "myWeek" }, { kind: "myTasks" }]);
  });

  it("la Home del reparto cambia dopo: «è cambiata», con le novità; vista, la riga sparisce", async () => {
    const d = await department();
    await setDepartmentHome(d, [{ kind: "myTasks" }]);
    const p = await personIn([d]);
    await call("PUT", "/api/me/home", p.headers.cookie, { blocks: [{ kind: "myTasks" }] });
    await new Promise((r) => setTimeout(r, 5));
    await setDepartmentHome(d, [{ kind: "myTasks" }, { kind: "upcomingMilestones" }, { kind: "newRequests" }]);
    const changed = await myHome(p.headers.cookie);
    expect(changed.departmentChanged).toEqual([d]);
    expect(changed.newBlocks).toEqual([{ kind: "upcomingMilestones" }, { kind: "newRequests" }]);
    // La Home personale non cambia da sola.
    expect(changed.blocks).toEqual([{ kind: "decide" }, { kind: "myWeek" }, { kind: "myTasks" }]);
    expect((await call("POST", `/api/me/home/seen/${d}`, p.headers.cookie)).statusCode).toBe(204);
    const seen = await myHome(p.headers.cookie);
    expect(seen.departmentChanged).toEqual([]);
    expect(seen.newBlocks).toEqual([]);
  });

  it("un filtro eliminato dopo resta nella Home come blocco (il client lo mostra «non disponibile»)", async () => {
    const p = await personIn([]);
    const f = await publicFilter(p.headers.cookie, "private");
    await call("PUT", "/api/me/home", p.headers.cookie, { blocks: [{ kind: "filter", filterId: f }] });
    expect((await call("DELETE", `/api/filters/${f}`, p.headers.cookie)).statusCode).toBe(204);
    expect((await myHome(p.headers.cookie)).blocks).toContainEqual({ kind: "filter", filterId: f });
  });
});

describe("Home di reparto", () => {
  it("la cambia un full admin o chi ha department.home.manage nel reparto; gli altri → 403", async () => {
    const d = await department();
    const other = await department();
    const manager = await personIn([d]);
    expect((await setDepartmentHome(d, [{ kind: "myTasks" }], manager.headers.cookie)).statusCode).toBe(403);
    await testDb.db
      .insert(departmentRoles)
      .values({ departmentId: d, userId: manager.id, permissions: ["department.home.manage"] });
    const ok = await setDepartmentHome(d, [{ kind: "myTasks" }], manager.headers.cookie);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(departmentHomeViewSchema.parse(ok.json())).toMatchObject({
      departmentId: d,
      blocks: [{ kind: "decide" }, { kind: "myWeek" }, { kind: "myTasks" }],
      updatedById: manager.id,
    });
    // Il permesso vale nel SUO reparto.
    expect((await setDepartmentHome(other, [{ kind: "myTasks" }], manager.headers.cookie)).statusCode).toBe(403);
    expect((await setDepartmentHome(randomUUID(), [{ kind: "myTasks" }])).statusCode).toBe(404);
    const read = await call("GET", `/api/departments/${d}/home`, users.memberCookie);
    expect(read.statusCode).toBe(200);
    expect(departmentHomeViewSchema.parse(read.json()).blocks.map((b) => b.kind)).toEqual(["decide", "myWeek", "myTasks"]);
    const none = departmentHomeViewSchema.parse((await call("GET", `/api/departments/${other}/home`, users.memberCookie)).json());
    expect(none).toMatchObject({ blocks: [{ kind: "decide" }, { kind: "myWeek" }], updatedAt: null });
  });

  it("nella Home di un reparto solo filtri pubblici: un privato (anche mio) → 400", async () => {
    const d = await department();
    const mine = await publicFilter(users.adminCookie, "private");
    const res = await setDepartmentHome(d, [{ kind: "filter", filterId: mine }]);
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe("filter_not_public");
    const pub = await publicFilter(users.adminCookie);
    expect((await setDepartmentHome(d, [{ kind: "filter", filterId: pub }])).statusCode).toBe(200);
  });
});

describe("ruoli di reparto", () => {
  it("li assegna chi ha departments.manage, senza riconferma; finiscono in /api/auth/me e nell'elenco", async () => {
    const d = await department();
    const p = await personIn([d]);
    const body = { roles: [{ userId: p.id, permissions: ["department.home.manage"] }] };
    expect((await call("PUT", `/api/departments/${d}/roles`, users.memberCookie, body)).statusCode).toBe(403);
    const res = await call("PUT", `/api/departments/${d}/roles`, users.adminCookie, body);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual([{ departmentId: d, userId: p.id, permissions: ["department.home.manage"] }]);
    const me = sessionResponseSchema.parse((await call("GET", "/api/auth/me", p.headers.cookie)).json());
    expect(me.departmentPermissions).toEqual({ [d]: ["department.home.manage"] });
    const list = z
      .array(z.object({ departmentId: z.string(), userId: z.string(), permissions: z.array(z.string()) }))
      .parse((await call("GET", "/api/departments/roles", users.memberCookie)).json());
    expect(list).toContainEqual({ departmentId: d, userId: p.id, permissions: ["department.home.manage"] });
    // Un permesso che non è di reparto, una persona che non esiste: 400.
    expect(
      (await call("PUT", `/api/departments/${d}/roles`, users.adminCookie, { roles: [{ userId: p.id, permissions: ["tickets.edit"] }] }))
        .statusCode,
    ).toBe(400);
    expect(
      (await call("PUT", `/api/departments/${d}/roles`, users.adminCookie, {
        roles: [{ userId: randomUUID(), permissions: ["department.home.manage"] }],
      })).statusCode,
    ).toBe(400);
    // L'insieme si sostituisce: vuoto toglie tutto.
    expect((await call("PUT", `/api/departments/${d}/roles`, users.adminCookie, { roles: [] })).json()).toEqual([]);
    const after = sessionResponseSchema.parse((await call("GET", "/api/auth/me", p.headers.cookie)).json());
    expect(after.departmentPermissions).toEqual({});
  });
});
