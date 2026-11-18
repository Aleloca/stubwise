import { randomUUID } from "node:crypto";
import { invites, projectMemberPermissions, projectMembers, roles, users, type Db } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import type { AdminRoleView, InviteChoices, InviteView, MemberPreview, ProjectMembersView } from "@stubwise/shared";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { addMember, fullSessionCookie, seedUsers } from "../test/fixtures.js";

/**
 * Area 9, F1 (aggiunta per R7 e R8): ruoli, inviti, membri e l'anteprima di
 * una bozza. Il test d'ACCORDO: un `missing` vuoto ⇒ la scrittura riesce, un
 * `missing` pieno ⇒ 403 `escalation`; i blocchi ⇒ il 409 della scrittura.
 */

let testDb: TestDb;
let db: Db;
let app: FastifyInstance;
let adminCookie: string;
let adminId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  app = buildApp({ db, sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!", encryptionKey: Buffer.alloc(32, 3).toString("base64") });
  ({ adminCookie } = await seedUsers(app));
  adminId = (await db.select({ id: users.id }).from(users).where(eq(users.email, "admin@example.com")))[0]!.id;
}, 120_000);
afterAll(async () => {
  await app.close();
  await testDb.stop();
});

async function person(prefix = "p") {
  const [u] = await db.insert(users).values({ email: `${prefix}-${randomUUID().slice(0, 6)}@acme.com`, passwordHash: "x", role: "member" }).returning({ id: users.id });
  return { id: u!.id, cookie: await fullSessionCookie(app, u!.id) };
}
const preset = async (key: string) => (await db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, key)))[0]!.id;
async function projectRole(permissions: string[]) {
  const [r] = await db.insert(roles).values({ name: `P ${randomUUID().slice(0, 6)}`, scope: "project", permissions }).returning({ id: roles.id });
  return r!.id;
}
const get = async <T>(cookie: string, url: string) => (await app.inject({ method: "GET", url, headers: { cookie } })).json() as T;

describe("Members: la vista e l'anteprima d'accordo con putProjectMember", () => {
  it("roleChoices: `missing` vuoto ⇒ il PUT riesce, pieno ⇒ 403 escalation; grantable segue i permessi di chi guarda", async () => {
    const { projectId } = await seedRepository(db);
    const lead = await person("lead");
    await addMember(app, projectId, lead.id, "project_lead");
    const view = await get<ProjectMembersView>(lead.cookie, `/api/projects/${projectId}/members/view`);
    expect(view.canManage).toBe(true);
    const target = await person();
    const put = (roleId: string) => app.inject({ method: "PUT", url: `/api/projects/${projectId}/members/${target.id}`, headers: { cookie: lead.cookie }, payload: { roleId } });
    // Un ruolo con un permesso che il Project Lead non ha (se ce n'è uno): manca.
    const leadPerms = view.roleChoices.find((c) => c.name === "Project Lead")!;
    expect(leadPerms.missing).toEqual([]);
    const notHeld = view.grantable.find((g) => !g.allowed);
    if (notHeld) {
      const wide = await projectRole([notHeld.permission]);
      const choices = (await get<ProjectMembersView>(lead.cookie, `/api/projects/${projectId}/members/view`)).roleChoices;
      expect(choices.find((c) => c.roleId === wide)!.missing).toEqual([notHeld.permission]);
      expect((await put(wide)).statusCode).toBe(403);
    }
    expect((await put(await preset("developer"))).statusCode).toBe(200);
    expect(view.addable).not.toContain(adminId);
  });

  it("chi non gestisce: canManage falso, niente scelte; l'anteprima gli è negata", async () => {
    const { projectId } = await seedRepository(db);
    const dev = await person("dev");
    await addMember(app, projectId, dev.id, "developer");
    const view = await get<ProjectMembersView>(dev.cookie, `/api/projects/${projectId}/members/view`);
    expect(view).toMatchObject({ canManage: false, roleChoices: [], addable: [] });
    expect(view.grantable.every((g) => !g.allowed)).toBe(true);
    const res = await app.inject({ method: "POST", url: `/api/projects/${projectId}/members/${dev.id}/preview`, headers: { cookie: dev.cookie }, payload: { roleId: await preset("developer"), granted: [] } });
    expect(res.statusCode).toBe(403);
  });

  it("l'anteprima: i permessi con le fonti, ciò che toglie, `missing` sugli AGGIUNTI, e il blocco dell'ultimo gestore ⇔ 409", async () => {
    const { projectId } = await seedRepository(db);
    const lead = await person("lead");
    await addMember(app, projectId, lead.id, "project_lead");
    const dev = await person("dev");
    await addMember(app, projectId, dev.id, "developer");
    await db.insert(projectMemberPermissions).values({ projectId, userId: dev.id, permission: "release.merge", grantedByUserId: adminId });
    const preview = async (cookie: string, userId: string, roleId: string, granted: string[]) =>
      (await app.inject({ method: "POST", url: `/api/projects/${projectId}/members/${userId}/preview`, headers: { cookie }, payload: { roleId, granted } })).json() as MemberPreview;
    const p = await preview(adminCookie, dev.id, await preset("developer"), ["plans.approve"]);
    expect(p.removing.map((r) => r.permission)).toEqual(["release.merge"]);
    expect(p.permissions.find((x) => x.permission === "plans.approve")!.sources[0]).toMatchObject({ kind: "grant", origin: "draft" });
    expect(p.missing).toEqual([]);
    // Un gestore con MENO permessi: dare nella bozza ciò che non ha è `missing`, e il PUT dà 403.
    const narrow = await projectRole(["project.members.manage", "tickets.view_all"]);
    const small = await person("small");
    await addMember(app, projectId, small.id, "developer");
    await db.update(projectMembers).set({ roleId: narrow }).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, small.id)));
    const esc = await preview(small.cookie, dev.id, await preset("viewer"), ["release.merge", "plans.approve"]);
    expect(esc.missing).toEqual(expect.arrayContaining(["plans.approve"]));
    const escPut = await app.inject({ method: "PUT", url: `/api/projects/${projectId}/members/${dev.id}`, headers: { cookie: small.cookie }, payload: { roleId: await preset("viewer"), permissions: ["release.merge", "plans.approve"] } });
    expect(escPut.statusCode).toBe(403);
    // Fuori dal progetto: sennò sarebbe un secondo gestore, e il lead non sarebbe più l'ultimo.
    await db.delete(projectMembers).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, small.id)));
    // L'ultimo gestore che perderebbe la gestione: bloccato, e il PUT dà 409.
    const last = await preview(adminCookie, lead.id, await preset("developer"), []);
    expect(last.block).toBe("last_manager");
    expect(last.removeBlock).toBe("last_manager");
    const putRes = await app.inject({ method: "PUT", url: `/api/projects/${projectId}/members/${lead.id}`, headers: { cookie: adminCookie }, payload: { roleId: await preset("developer") } });
    expect(putRes.statusCode).toBe(409);
  });
});

describe("Roles, inviti, scelte", () => {
  it("i ruoli: `missing` e `copyMissing` d'accordo con updateRole e duplicate; deleteBlock d'accordo con il delete", async () => {
    const [mgrRole] = await db.insert(roles).values({ name: `Ruoli ${randomUUID().slice(0, 4)}`, scope: "instance", permissions: ["roles.manage", "users.view_all"] }).returning({ id: roles.id });
    const m = await person("roles");
    await db.update(users).set({ instanceRoleId: mgrRole!.id }).where(eq(users.id, m.id));
    const views = await get<AdminRoleView[]>(m.cookie, "/api/admin/roles");
    const admin = views.find((v) => v.presetKey === "admin")!;
    expect(admin).toMatchObject({ deleteBlock: "preset", reach: "instance" });
    expect(admin.copyMissing).toContain("instance.full_admin");
    expect((await app.inject({ method: "POST", url: `/api/roles/${admin.id}/duplicate`, headers: { cookie: m.cookie }, payload: {} })).statusCode).toBe(403);
    const [free] = await db.insert(roles).values({ name: `Libero ${randomUUID().slice(0, 4)}`, scope: "instance", permissions: ["users.view_all"] }).returning({ id: roles.id });
    const freeView = (await get<AdminRoleView[]>(m.cookie, "/api/admin/roles")).find((v) => v.id === free!.id)!;
    expect(freeView).toMatchObject({ missing: [], copyMissing: [], deleteBlock: null });
    expect(freeView.notGivable).toContain("users.manage");
    const patch = (permissions: string[]) => app.inject({ method: "PATCH", url: `/api/roles/${free!.id}`, headers: { cookie: m.cookie }, payload: { permissions } });
    expect((await patch(["users.view_all", "roles.manage"])).statusCode).toBe(200);
    expect((await patch(["users.view_all", "users.manage"])).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: `/api/roles/${free!.id}`, headers: { cookie: m.cookie } })).statusCode).toBe(204);
    const dev = views.find((v) => v.presetKey === "developer")!;
    expect(dev.deleteBlock === "in_use" || dev.deleteBlock === null).toBe(true);
  });

  it("gli inviti: id opaco, mai il token; la revoca per id; le scelte coi `missing` d'accordo con la creazione", async () => {
    const token = `tok-${randomUUID()}`;
    await db.insert(invites).values({ token, email: `i-${randomUUID().slice(0, 6)}@acme.com`, expiresAt: new Date(Date.now() + 86_400_000), invitedByUserId: adminId });
    const res = await app.inject({ method: "GET", url: "/api/admin/invites", headers: { cookie: adminCookie } });
    expect(res.body).not.toContain(token);
    const mine = (res.json() as InviteView[]).find((i) => i.invitedById === adminId && !i.expired)!;
    expect(mine.id).toMatch(/^i_[0-9a-f]{32}$/);
    expect((await app.inject({ method: "DELETE", url: `/api/admin/invites/${mine.id}`, headers: { cookie: adminCookie } })).statusCode).toBe(204);
    expect(await db.select().from(invites).where(eq(invites.token, token))).toHaveLength(0);
    expect((await app.inject({ method: "DELETE", url: `/api/admin/invites/${mine.id}`, headers: { cookie: adminCookie } })).statusCode).toBe(404);
    // Le scelte di chi ha solo users.invite: l'Admin gli manca, User no.
    const [inviterRole] = await db.insert(roles).values({ name: `Inv ${randomUUID().slice(0, 4)}`, scope: "instance", permissions: ["users.invite", "users.view_all"] }).returning({ id: roles.id });
    const inviter = await person("inv");
    await db.update(users).set({ instanceRoleId: inviterRole!.id }).where(eq(users.id, inviter.id));
    const choices = await get<InviteChoices>(inviter.cookie, "/api/admin/invite-choices");
    expect(choices.instanceRoles.find((r) => r.name === "Admin")!.missing).toContain("instance.full_admin");
    const create = (instanceRoleId: string) =>
      app.inject({ method: "POST", url: "/api/auth/invites", headers: { cookie: inviter.cookie }, payload: { email: `n-${randomUUID().slice(0, 6)}@acme.com`, instanceRoleId } });
    const adminChoice = choices.instanceRoles.find((r) => r.name === "Admin")!;
    expect((await create(adminChoice.roleId)).statusCode).toBe(403);
    const ok = choices.instanceRoles.find((r) => r.missing.length === 0);
    if (ok) expect((await create(ok.roleId)).statusCode).toBe(201);
    expect(choices.projects).toEqual([]);
  });
});

describe("Roles e anteprima: i rilievi della review", () => {
  it("M4: un ruolo d'istanza col full admin conta i permessi EFFETTIVI (missing pieno, notGivable vuoto)", async () => {
    const [mgrRole] = await db.insert(roles).values({ name: `M4 ${randomUUID().slice(0, 4)}`, scope: "instance", permissions: ["roles.manage"] }).returning({ id: roles.id });
    const m = await person("m4");
    await db.update(users).set({ instanceRoleId: mgrRole!.id }).where(eq(users.id, m.id));
    const admin = (await get<AdminRoleView[]>(m.cookie, "/api/admin/roles")).find((v) => v.presetKey === "admin")!;
    expect(admin.missing).toEqual(expect.arrayContaining(["instance.full_admin", "settings.manage", "users.manage"]));
    expect(admin.notGivable).toEqual([]);
  });

  it("M1: l'anteprima rifiuta come il salvataggio — disattivato (blocco e 422), Claude (404), permesso sconosciuto (422)", async () => {
    const { projectId } = await seedRepository(db);
    const gone = await person("gone");
    await db.update(users).set({ deactivatedAt: new Date() }).where(eq(users.id, gone.id));
    const draft = { roleId: await preset("developer"), granted: [] as string[] };
    const preview = (userId: string, body = draft) => app.inject({ method: "POST", url: `/api/projects/${projectId}/members/${userId}/preview`, headers: { cookie: adminCookie }, payload: body });
    expect(((await preview(gone.id)).json() as MemberPreview).block).toBe("user_deactivated");
    expect((await app.inject({ method: "PUT", url: `/api/projects/${projectId}/members/${gone.id}`, headers: { cookie: adminCookie }, payload: { roleId: draft.roleId } })).statusCode).toBe(422);
    const [claude] = await db.select({ id: users.id }).from(users).where(eq(users.isAgent, true));
    expect((await preview(claude!.id)).statusCode).toBe(404);
    expect((await app.inject({ method: "PUT", url: `/api/projects/${projectId}/members/${claude!.id}`, headers: { cookie: adminCookie }, payload: { roleId: draft.roleId } })).statusCode).toBe(404);
    const someone = await person("x");
    const bad = await preview(someone.id, { roleId: draft.roleId, granted: ["non.esiste"] });
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toMatchObject({ code: "unknown_permission" });
  });
});
