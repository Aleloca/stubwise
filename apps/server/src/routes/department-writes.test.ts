import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { changeLog, departmentMembers, departmentProjectPermissions, departments, projects, roles, users } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { PROJECT_PERMISSIONS } from "@stubwise/shared";
import { buildApp } from "../app.js";
import { createSession, SESSION_COOKIE } from "../auth/session.js";
import { addMember, fullSessionCookie, seedUsers } from "../test/fixtures.js";

/**
 * Area 9, F8, Task 3: le scritture dei permessi di un reparto, nel `PATCH
 * /api/departments/:id` (la bozza intera, R-3). La riconferma (F8-3 = a del
 * maintainer) solo per un permesso AGGIUNTO o una persona aggiunta a un
 * reparto che ne dà; l'escalation con la regola dell'anteprima; nessun
 * progetto senza gestore (F8-5 = a); Claude mai fra le persone.
 */
let t: TestDb;
let app: ReturnType<typeof buildApp>;
let adminCookie: string;
let mgr: { id: string; cookie: string };
let p1: string;
let p2: string;
let a: string;
let b: string;
let c: string;
let X: string;
let n = 0;

async function person(email: string) {
  const [u] = await t.db.insert(users).values({ email, passwordHash: "x", role: "member" }).returning({ id: users.id });
  return u!.id;
}
async function department(memberIds: string[], perms: string[] = []) {
  const [d] = await t.db.insert(departments).values({ name: `Reparto W ${++n}`, colorToken: "--dept-5" }).returning();
  for (const userId of memberIds) await t.db.insert(departmentMembers).values({ departmentId: d!.id, userId });
  for (const permission of perms) await t.db.insert(departmentProjectPermissions).values({ departmentId: d!.id, permission });
  return d!.id;
}
/** La stessa persona, col secondo fattore di 11 minuti fa (fuori dalla finestra della riconferma). */
async function stale(userId: string): Promise<string> {
  const old = await createSession(t.db, userId, { stage: "full", secondFactorAt: new Date(Date.now() - 11 * 60_000) });
  return `${SESSION_COOKIE}=${encodeURIComponent(app.signCookie(old.id))}`;
}
const patch = (id: string, body: Record<string, unknown>, cookie = mgr.cookie) =>
  app.inject({ method: "PATCH", url: `/api/departments/${id}`, headers: { cookie }, payload: body });
const permsOf = async (id: string) =>
  (await t.db.select({ p: departmentProjectPermissions.permission }).from(departmentProjectPermissions).where(eq(departmentProjectPermissions.departmentId, id))).map((r) => r.p).sort();
const membersOf = async (id: string) =>
  (await t.db.select({ u: departmentMembers.userId }).from(departmentMembers).where(eq(departmentMembers.departmentId, id))).map((r) => r.u).sort();

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40), publicUrl: "https://stubwise.example" });
  ({ adminCookie } = await seedUsers(app));
  ({ projectId: p1 } = await seedRepository(t.db));
  ({ projectId: p2 } = await seedRepository(t.db));
  const [role] = await t.db.insert(roles).values({ name: "Gestore reparti F8w", scope: "instance", permissions: ["departments.manage"] }).returning({ id: roles.id });
  const mgrId = await person("mgr-f8w@example.com");
  await t.db.update(users).set({ instanceRoleId: role!.id }).where(eq(users.id, mgrId));
  mgr = { id: mgrId, cookie: await fullSessionCookie(app, mgrId) };
  await addMember(app, p1, mgr.id, "project_lead");
  await addMember(app, p2, mgr.id, "developer");
  a = await person("a-f8w@example.com");
  b = await person("b-f8w@example.com");
  c = await person("c-f8w@example.com");
  await addMember(app, p1, a, "developer");
  await addMember(app, p1, b, "developer");
  await addMember(app, p2, b, "developer");
  await addMember(app, p1, c, "developer");
  const lead = (await t.db.select({ p: roles.permissions }).from(roles).where(eq(roles.presetKey, "project_lead")))[0]!.p;
  const dev = (await t.db.select({ p: roles.permissions }).from(roles).where(eq(roles.presetKey, "developer")))[0]!.p;
  X = PROJECT_PERMISSIONS.find((p) => lead.includes(p) && !dev.includes(p) && p !== "project.members.manage")!;
}, 120_000);

afterAll(async () => {
  await app.close();
  await t.stop();
});

describe("area 9, F8: la riconferma (F8-3 = a)", () => {
  it("un permesso AGGIUNTO la chiede; con la riconferma si salva, con la sua voce del registro", async () => {
    const d = await department([a]);
    const noReauth = await patch(d, { projectPermissions: [X] }, await stale(mgr.id));
    expect([noReauth.statusCode, (noReauth.json() as { code: string }).code]).toEqual([403, "reauth_required"]);
    expect(await permsOf(d)).toEqual([]);
    expect((await patch(d, { projectPermissions: [X] })).statusCode).toBe(200);
    expect(await permsOf(d)).toEqual([X]);
    const [entry] = await t.db.select().from(changeLog).where(and(eq(changeLog.type, "department.permissions_changed"), eq(changeLog.subjectId, d)));
    expect(entry!.data).toMatchObject({ before: "", after: X, params: { added: [X], removed: [] } });
  });

  it("una persona aggiunta a un reparto che dà permessi la chiede; a un reparto che non ne dà, no", async () => {
    const giving = await department([a], [X]);
    const r = await patch(giving, { memberIds: [a, c] }, await stale(mgr.id));
    expect([r.statusCode, (r.json() as { code: string }).code]).toEqual([403, "reauth_required"]);
    expect(await membersOf(giving)).toEqual([a]);
    expect((await patch(giving, { memberIds: [a, c] })).statusCode).toBe(200);
    const plain = await department([a]);
    expect((await patch(plain, { memberIds: [a, c] }, await stale(mgr.id))).statusCode).toBe(200);
  });

  it("togliere un permesso o una persona, rinominare: niente riconferma", async () => {
    const d = await department([a, c], [X]);
    const s = await stale(mgr.id);
    expect((await patch(d, { name: `Rinominato ${++n}` }, s)).statusCode).toBe(200);
    expect((await patch(d, { memberIds: [a] }, s)).statusCode).toBe(200);
    expect((await patch(d, { projectPermissions: [] }, s)).statusCode).toBe(200);
    expect(await permsOf(d)).toEqual([]);
  });
});

describe("area 9, F8: i rifiuti, e niente si scrive", () => {
  it("escalation: un permesso che chi agisce non ha in TUTTI i progetti dove arriva, o una persona che lo porterebbe dove non lo ha", async () => {
    const withB = await department([b]);
    const r = await patch(withB, { projectPermissions: [X] });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toMatchObject({ code: "escalation", permission: X, missing: [X] });
    expect(await permsOf(withB)).toEqual([]);
    const giving = await department([a], [X]);
    const r2 = await patch(giving, { memberIds: [a, b] });
    expect(r2.json()).toMatchObject({ code: "escalation", missing: [X] });
    expect(await membersOf(giving)).toEqual([a]);
  });

  it("review di F8 (I2): Claude già nel reparto (il ripiego, in ogni istanza esistente) non blocca il salvataggio; rifiutato solo chi ENTRA", async () => {
    const [agent] = await t.db.select({ id: users.id }).from(users).where(eq(users.isAgent, true));
    const d = await department([a, agent!.id]);
    const r = await patch(d, { name: `Con Claude ${++n}`, memberIds: [a, agent!.id] });
    expect(r.statusCode).toBe(200);
    expect(await membersOf(d)).toEqual([a, agent!.id].sort());
  });

  it("invalid_permission per un permesso che non è di progetto; not_a_person per Claude", async () => {
    const empty = await department([]);
    const r = await patch(empty, { projectPermissions: ["instance.full_admin"] });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ code: "invalid_permission", permission: "instance.full_admin" });
    const [agent] = await t.db.select({ id: users.id }).from(users).where(eq(users.isAgent, true));
    const r2 = await patch(empty, { memberIds: [agent!.id] });
    expect([r2.statusCode, (r2.json() as { code: string }).code]).toEqual([400, "not_a_person"]);
    expect(await membersOf(empty)).toEqual([]);
  });
});

describe("area 9, F8: l'ultimo gestore via reparto (F8-5 = a)", () => {
  it("togliere il permesso, la persona o il reparto che faceva gestire un progetto: 409 last_manager (col codice a chi lo vede)", async () => {
    const { projectId: p3 } = await seedRepository(t.db);
    const m = await person("m-f8w@example.com");
    await addMember(app, p3, m, "developer");
    const d = await department([m], ["project.members.manage"]);
    const [code] = await t.db.select({ code: projects.code }).from(projects).where(eq(projects.id, p3));
    const byPerm = await patch(d, { projectPermissions: [] }, adminCookie);
    expect(byPerm.statusCode).toBe(409);
    expect(byPerm.json()).toMatchObject({ code: "last_manager", projectId: p3, projectCode: code!.code });
    expect(await permsOf(d)).toEqual(["project.members.manage"]);
    // Chi non vede il progetto non ne riceve il codice.
    const byMember = await patch(d, { memberIds: [] });
    expect(byMember.statusCode).toBe(409);
    expect((byMember.json() as { projectCode?: string }).projectCode).toBeUndefined();
    expect(await membersOf(d)).toEqual([m]);
    const del = await app.inject({ method: "DELETE", url: `/api/departments/${d}`, headers: { cookie: adminCookie } });
    expect(del.statusCode).toBe(409);
    expect(await t.db.select().from(departments).where(eq(departments.id, d))).toHaveLength(1);
  });
});

describe("area 9, F8: due persone sullo stesso reparto (ifMatch)", () => {
  it("l'elenco dà una versione; un salvataggio da una bozza vecchia è 409 stale e non scrive; senza ifMatch resta l'ultima che vince", async () => {
    const d = await department([a, c], [X]);
    const list = async () => ((await app.inject({ method: "GET", url: "/api/departments", headers: { cookie: mgr.cookie } })).json() as { id: string; version: string }[]).find((x) => x.id === d)!;
    const v1 = (await list()).version;
    expect(v1).toMatch(/^[0-9a-f]{16}$/);
    // Un'altra persona salva prima (toglie c).
    const first = await patch(d, { memberIds: [a], ifMatch: v1 });
    expect(first.statusCode).toBe(200);
    const v2 = (first.json() as { version: string }).version;
    expect(v2).not.toBe(v1);
    expect((await list()).version).toBe(v2);
    // La bozza vecchia (con c, senza permessi) non sovrascrive.
    const stale = await patch(d, { memberIds: [a, c], projectPermissions: [], ifMatch: v1 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "stale", version: v2 });
    expect(await membersOf(d)).toEqual([a]);
    expect(await permsOf(d)).toEqual([X]);
    // Un client di prima, senza ifMatch: l'ultima scrittura vince, come prima.
    expect((await patch(d, { name: `Senza versione ${++n}` })).statusCode).toBe(200);
  });
});

