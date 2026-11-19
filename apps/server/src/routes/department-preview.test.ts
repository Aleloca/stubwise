import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { departmentMembers, departmentProjectPermissions, departments, roles, users } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { PROJECT_PERMISSIONS } from "@stubwise/shared";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, fullSessionCookie, seedUsers } from "../test/fixtures.js";

/**
 * Area 9, F8, Task 2 (F8-2 = a): l'anteprima della bozza di un reparto la
 * calcola il SERVER, con la stessa regola della scrittura (`judgeDraft` del
 * prototipo): `notGivable` (ciò che chi guarda non ha in TUTTI i progetti dove
 * la bozza arriva), `reach`, `missingToAdd` (per persona) e `missing`.
 */
let t: TestDb;
let app: ReturnType<typeof buildApp>;
let adminCookie: string;
type U = { id: string; cookie: string };
let mgr: U;
let p1: string;
let p2: string;
let a: string;
let b: string;
let c: string;
let deptId: string;
let leadPerms: string[];
let devPerms: string[];
/** Un permesso che il Project Lead ha e il Developer no. */
let X: string;
let Y: string;

async function person(email: string) {
  const [u] = await t.db.insert(users).values({ email, passwordHash: "x", role: "member" }).returning({ id: users.id });
  return u!.id;
}

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40), publicUrl: "https://stubwise.example" });
  ({ adminCookie } = await seedUsers(app));
  ({ projectId: p1 } = await seedRepository(t.db));
  ({ projectId: p2 } = await seedRepository(t.db));
  const [role] = await t.db.insert(roles).values({ name: "Gestore reparti F8", scope: "instance", permissions: ["departments.manage"] }).returning({ id: roles.id });
  const mgrId = await person("mgr-f8p@example.com");
  await t.db.update(users).set({ instanceRoleId: role!.id }).where(eq(users.id, mgrId));
  mgr = { id: mgrId, cookie: await fullSessionCookie(app, mgrId) };
  await addMember(app, p1, mgr.id, "project_lead");
  await addMember(app, p2, mgr.id, "developer");
  a = await person("a-f8p@example.com");
  b = await person("b-f8p@example.com");
  c = await person("c-f8p@example.com");
  await addMember(app, p1, a, "developer");
  await addMember(app, p1, b, "developer");
  await addMember(app, p2, b, "developer");
  leadPerms = (await t.db.select({ p: roles.permissions }).from(roles).where(eq(roles.presetKey, "project_lead")))[0]!.p;
  devPerms = (await t.db.select({ p: roles.permissions }).from(roles).where(eq(roles.presetKey, "developer")))[0]!.p;
  const onlyLead = PROJECT_PERMISSIONS.filter((p) => leadPerms.includes(p) && !devPerms.includes(p));
  [X, Y] = onlyLead as [string, string];
  const [d] = await t.db.insert(departments).values({ name: "Reparto F8 anteprima", colorToken: "--dept-3" }).returning();
  deptId = d!.id;
  await t.db.insert(departmentMembers).values({ departmentId: deptId, userId: a });
}, 120_000);

afterAll(async () => {
  await app.close();
  await t.stop();
});

type Preview = { reach: string; notGivable: string[]; missingToAdd: Record<string, string[]>; missing: string[] };
const preview = async (draft: { memberIds: string[]; projectPermissions: string[] }, cookie = mgr.cookie, id = deptId) => {
  const res = await app.inject({ method: "POST", url: `/api/departments/${id}/preview`, headers: { cookie }, payload: draft });
  return { status: res.statusCode, body: res.json() as Preview };
};
const sorted = (xs: readonly string[]) => [...xs].sort();

describe("area 9, F8: l'anteprima della bozza di un reparto", () => {
  it("le premesse: due permessi che il Project Lead ha e il Developer no", () => {
    expect(X).toBeDefined();
    expect(Y).toBeDefined();
  });

  it("notGivable: ciò che chi guarda non ha in TUTTI i progetti dove la bozza arriva", async () => {
    // Solo a (P1, dove mgr è Project Lead).
    const one = await preview({ memberIds: [a], projectPermissions: [] });
    expect(one.status).toBe(200);
    expect(one.body.reach).toBe("projects");
    expect(sorted(one.body.notGivable)).toEqual(sorted(PROJECT_PERMISSIONS.filter((p) => !leadPerms.includes(p))));
    // Con b arriva anche in P2, dove mgr è Developer.
    const two = await preview({ memberIds: [a, b], projectPermissions: [] });
    expect(two.body.notGivable).toContain(X);
    expect(sorted(two.body.notGivable)).toEqual(sorted(PROJECT_PERMISSIONS.filter((p) => !(leadPerms.includes(p) && devPerms.includes(p)))));
  });

  it("missingToAdd e missing: chi entra riceve TUTTI i permessi della bozza nei suoi progetti", async () => {
    const r = await preview({ memberIds: [a], projectPermissions: [X] });
    // b entrerebbe portando X anche in P2: manca. c non ha progetti: niente.
    expect(r.body.missingToAdd[b]).toEqual([X]);
    expect(r.body.missingToAdd[c]).toEqual([]);
    expect(r.body.missing).toEqual([]);
    expect(r.body.missingToAdd[a]).toBeUndefined();
    const withB = await preview({ memberIds: [a, b], projectPermissions: [X] });
    expect(withB.body.missing).toEqual([X]);
  });

  it("un membro salvato porta solo i permessi AGGIUNTI; un reparto senza progetti è «anywhere»", async () => {
    await t.db.insert(departmentProjectPermissions).values({ departmentId: deptId, permission: X });
    await t.db.insert(departmentMembers).values({ departmentId: deptId, userId: b });
    // X è salvato: rimetterlo con b dentro non manca. Y aggiunto sì (b è in P2).
    expect((await preview({ memberIds: [a, b], projectPermissions: [X] })).body.missing).toEqual([]);
    expect((await preview({ memberIds: [a, b], projectPermissions: [X, Y] })).body.missing).toEqual([Y]);
    // b salvato e tolto dalla bozza: rientrando riporterebbe solo i permessi AGGIUNTI.
    const out = await preview({ memberIds: [a], projectPermissions: [X, Y] });
    expect(out.body.missingToAdd[b]).toEqual([Y]);
    const empty = await preview({ memberIds: [], projectPermissions: [X, Y] });
    expect(empty.body).toMatchObject({ reach: "anywhere", notGivable: [], missing: [] });
    await t.db.delete(departmentProjectPermissions).where(eq(departmentProjectPermissions.departmentId, deptId));
    await t.db.delete(departmentMembers).where(eq(departmentMembers.userId, b));
  });

  it("un permesso che chi guarda ha SOLO dal suo reparto conta, nei progetti dove gli arriva", async () => {
    const [own] = await t.db.insert(departments).values({ name: "Reparto di mgr F8", colorToken: "--dept-4" }).returning();
    await t.db.insert(departmentMembers).values({ departmentId: own!.id, userId: mgr.id });
    await t.db.insert(departmentProjectPermissions).values({ departmentId: own!.id, permission: X });
    const r = await preview({ memberIds: [a, b], projectPermissions: [X] });
    expect(r.body.notGivable).not.toContain(X);
    expect(r.body.missing).toEqual([]);
    await t.db.delete(departments).where(eq(departments.id, own!.id));
  });

  it("il full admin non ha niente di mancante; Claude non è fra i candidati", async () => {
    const r = await preview({ memberIds: [a, b], projectPermissions: [X, Y] }, adminCookie);
    expect(r.body).toMatchObject({ notGivable: [], missing: [] });
    expect(Object.values(r.body.missingToAdd).every((m) => m.length === 0)).toBe(true);
    const [agent] = await t.db.select({ id: users.id }).from(users).where(eq(users.isAgent, true));
    expect(r.body.missingToAdd[agent!.id]).toBeUndefined();
  });

  it("NEGATIVI: senza departments.manage 403; un reparto che non c'è 404; un permesso che non è di progetto 400", async () => {
    const plain = await createUserWithSession(app, "plain-f8p@example.com");
    expect((await preview({ memberIds: [], projectPermissions: [] }, plain.headers.cookie)).status).toBe(403);
    expect((await preview({ memberIds: [], projectPermissions: [] }, mgr.cookie, "6f1c2a52-1d7b-4c3e-9a51-0b6a7f2e1a01")).status).toBe(404);
    expect((await preview({ memberIds: [], projectPermissions: ["instance.full_admin"] })).status).toBe(400);
  });
});
