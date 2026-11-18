import { randomUUID } from "node:crypto";
import { changeLog, roles, users, type Db } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import type { ChangeEntry, ChangeLogFilters, ChangeLogPage } from "@stubwise/shared";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { recordChange } from "../services/change-log.js";
import { addMember, fullSessionCookie, seedUsers } from "../test/fixtures.js";

/**
 * Area 9, F2, Task 8: la lettura del registro, filtrata nella WHERE prima
 * della paginazione. Il test d'ACCORDO: per un seme con voci d'istanza e di
 * due progetti e cinque persone, ogni voce letta ⇔ la regola scritta qui.
 */

let testDb: TestDb;
let db: Db;
let app: FastifyInstance;
let adminCookie: string;
let admin: { id: string; email: string };

let projectA: string;
let projectB: string;
const cast: Record<"rolesMgr" | "leadA" | "devA" | "viewerAll" | "outsider", { id: string; email: string; cookie: string }> = {} as never;

async function person(prefix: string, instancePermissions?: string[]) {
  const email = `${prefix}-${randomUUID().slice(0, 6)}@acme.com`;
  const [u] = await db.insert(users).values({ email, passwordHash: "x", role: "member" }).returning({ id: users.id });
  if (instancePermissions) {
    const [r] = await db.insert(roles).values({ name: `I ${randomUUID().slice(0, 6)}`, scope: "instance", permissions: instancePermissions }).returning({ id: roles.id });
    await db.update(users).set({ instanceRoleId: r!.id }).where(eq(users.id, u!.id));
  }
  return { id: u!.id, email, cookie: await fullSessionCookie(app, u!.id) };
}

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  app = buildApp({ db, sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!", encryptionKey: Buffer.alloc(32, 11).toString("base64") });
  ({ adminCookie } = await seedUsers(app));
  const [a] = await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.email, "admin@example.com"));
  admin = a!;
  ({ projectId: projectA } = await seedRepository(db));
  ({ projectId: projectB } = await seedRepository(db));
  cast.rolesMgr = await person("roles", ["roles.manage"]);
  cast.leadA = await person("leadA");
  await addMember(app, projectA, cast.leadA.id, "project_lead");
  cast.devA = await person("devA");
  await addMember(app, projectA, cast.devA.id, "developer");
  cast.viewerAll = await person("viewall", ["changelog.view", "users.view_all"]);
  cast.outsider = await person("outsider");
  await addMember(app, projectB, cast.outsider.id, "project_lead");
  // Il seme: voci d'istanza di più tipi e voci di progetto in A e in B.
  await db.transaction(async (tx) => {
    const role = { type: "role", id: randomUUID(), label: "R" };
    await recordChange(tx, { type: "role.created", actor: admin, projectId: null, data: { object: role } });
    await recordChange(tx, { type: "person.deactivated", actor: admin, projectId: null, data: { object: { type: "person", id: cast.devA.id, label: cast.devA.email } } });
    await recordChange(tx, { type: "person.deactivated", actor: admin, projectId: null, data: { object: { type: "person", id: cast.outsider.id, label: cast.outsider.email } } });
    await recordChange(tx, { type: "member.added", actor: admin, projectId: projectA, data: { object: { type: "member", id: cast.devA.id, label: cast.devA.email } } });
    await recordChange(tx, { type: "member.added", actor: admin, projectId: projectB, data: { object: { type: "member", id: cast.outsider.id, label: cast.outsider.email } } });
  });
}, 120_000);
afterAll(async () => {
  await app.close();
  await testDb.stop();
});

const read = async (cookie: string, query = "") => {
  const res = await app.inject({ method: "GET", url: `/api/change-log${query}`, headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return res.json() as ChangeLogPage;
};

/** La regola, riscritta qui a mano: chi legge quale voce del seme. */
function expected(who: keyof typeof cast | "admin", e: ChangeEntry): boolean {
  if (who === "admin") return true;
  if (who === "viewerAll") return e.projectId === null; // changelog.view, ma nessun progetto visibile
  if (who === "rolesMgr") return e.type === "role.created";
  if (who === "leadA") return e.projectId === projectA; // gestisce A
  if (who === "devA") return false; // né changelog.view né la gestione
  if (who === "outsider") return e.projectId === projectB;
  return false;
}

describe("leggere il registro", () => {
  it("ACCORDO: ogni voce del seme si legge ⇔ la regola", async () => {
    const all = (await read(adminCookie, "?withinDays=1")).entries;
    expect(all.length).toBeGreaterThanOrEqual(5);
    for (const who of ["rolesMgr", "leadA", "devA", "viewerAll", "outsider"] as const) {
      const seen = new Set((await read(cast[who].cookie, "?withinDays=1")).entries.map((e) => e.id));
      for (const e of all) expect(seen.has(e.id), `${who} / ${e.type} / ${e.projectId}`).toBe(expected(who, e));
    }
  });

  it("NEGATIVI: un progetto invisibile → 404, senza gestione → 403; una persona invisibile non c'è (anche con changelog.view)", async () => {
    expect((await app.inject({ method: "GET", url: `/api/projects/${projectB}/change-log`, headers: { cookie: cast.leadA.cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/projects/${projectA}/change-log`, headers: { cookie: cast.devA.cookie } })).statusCode).toBe(403);
    const lead = (await app.inject({ method: "GET", url: `/api/projects/${projectA}/change-log`, headers: { cookie: cast.leadA.cookie } })).json() as ChangeLogPage;
    expect(lead.entries.every((e) => e.projectId === projectA)).toBe(true);
    // Chi ha changelog.view ma non vede l'outsider (nessun progetto in comune, niente users.manage).
    const viewerSees = (await read(cast.viewerAll.cookie, "?withinDays=1")).entries;
    expect(viewerSees.some((e) => e.data.object.id === cast.outsider.id)).toBe(false);
  });

  it("le persone invisibili escono dai `params` di un reparto, id e nomi insieme", async () => {
    const dept = { type: "department", id: randomUUID(), label: "Ops" };
    await db.transaction((tx) =>
      recordChange(tx, { type: "department.members_changed", actor: admin, projectId: null, data: { object: dept, params: { added: [cast.leadA.id, cast.outsider.id], removed: [], addedNames: [cast.leadA.email, cast.outsider.email], removedNames: [] } } }),
    );
    const [mgr] = await db.insert(roles).values({ name: `Dep ${randomUUID().slice(0, 4)}`, scope: "instance", permissions: ["departments.manage"] }).returning({ id: roles.id });
    await db.update(users).set({ instanceRoleId: mgr!.id }).where(eq(users.id, cast.devA.id));
    const cookie = await fullSessionCookie(app, cast.devA.id);
    const e = (await read(cookie, "?type=department.members_changed")).entries.find((x) => x.data.object.id === dept.id)!;
    expect(e.data.params).toMatchObject({ added: [cast.leadA.id], addedNames: [cast.leadA.email] });
  });

  it("la paginazione: 50 per pagina, il cursore continua senza buchi né doppioni, e il filtro sta prima", async () => {
    await db.transaction(async (tx) => {
      for (let i = 0; i < 60; i++) {
        await recordChange(tx, { type: "role.updated", actor: admin, projectId: null, data: { object: { type: "role", id: randomUUID(), label: `R${i}` } } });
      }
    });
    const first = await read(cast.rolesMgr.cookie, "?type=role.updated");
    expect(first.entries).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();
    const second = await read(cast.rolesMgr.cookie, `?type=role.updated&cursor=${first.nextCursor}`);
    const ids = [...first.entries, ...second.entries].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(60);
    // Chi non legge i ruoli non riceve pagine corte: nessuna voce, nessun cursore.
    expect(await read(cast.devA.cookie, "?type=role.updated")).toEqual({ entries: [], nextCursor: null });
  });

  it("le scelte dei filtri: everything, i gruppi che si leggono, solo i progetti visibili", async () => {
    const f = (await app.inject({ method: "GET", url: "/api/change-log/filters", headers: { cookie: cast.leadA.cookie } })).json() as ChangeLogFilters;
    expect(f.everything).toBe(false);
    expect(f.groups).toEqual(["members"]);
    expect(f.projects.map((p) => p.projectId)).toEqual([projectA]);
    const v = (await app.inject({ method: "GET", url: "/api/change-log/filters", headers: { cookie: cast.viewerAll.cookie } })).json() as ChangeLogFilters;
    expect(v.everything).toBe(true);
  });

  it("il trigger: un UPDATE e un DELETE diretti falliscono", async () => {
    const [row] = await db.select({ id: changeLog.id }).from(changeLog).limit(1);
    await expect(db.execute(sql`update change_log set data = '{}' where id = ${row!.id}`)).rejects.toThrow();
    await expect(db.execute(sql`delete from change_log where id = ${row!.id}`)).rejects.toThrow();
  });
});
