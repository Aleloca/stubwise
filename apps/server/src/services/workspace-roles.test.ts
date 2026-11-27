import { randomUUID } from "node:crypto";
import { departmentMembers, departments, departmentProjectPermissions, projects, roles, workspaceMembers, workspaceProjects, workspaces, type Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { actorAs, addMember, createUserWithSession, presetRoleId, seedUsers } from "../test/fixtures.js";
import { viewerLosesIf, whoCan } from "./access-query.js";
import { judgeDepartmentDraft } from "./department-access.js";
import { actorProjectPermissions, lastManagerProjectOf } from "./roles.js";

/**
 * Workspace, lotto 2, gruppo 3 (`docs/plans/2026-11-27-workspace-piano.md`):
 * ruoli, permessi e gestori leggono `project_access`. Wanda è nella workspace
 * «Clienti» (che contiene Farmacia) col ruolo dato da ogni test; Nino non c'entra.
 */

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
let testDb: TestDb;
let db: Db;
let app: FastifyInstance;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  app = buildApp({ db, sessionSecret: SESSION_SECRET, encryptionKey: Buffer.alloc(32, 7).toString("base64") });
  await seedUsers(app);
}, 120_000);
afterAll(async () => {
  await app.close();
  await testDb.stop();
});

const member = (id: string) => ({ ...actorAs(id, "member"), email: `${id}@x.test` });

async function seed(roleIdOrPreset: string) {
  const [p] = await db.insert(projects).values({ name: "Farmacia", slug: `far-${randomUUID().slice(0, 6)}`, ingestionKey: randomUUID() }).returning();
  const wanda = await createUserWithSession(app, `wanda-${randomUUID()}@x.test`);
  const nino = await createUserWithSession(app, `nino-${randomUUID()}@x.test`);
  const [w] = await db.insert(workspaces).values({ name: "Clienti", colorToken: "--dept-1" }).returning();
  await db.insert(workspaceProjects).values({ workspaceId: w!.id, projectId: p!.id });
  const roleId = roleIdOrPreset.includes("-") ? roleIdOrPreset : await presetRoleId(app, roleIdOrPreset);
  await db.insert(workspaceMembers).values({ workspaceId: w!.id, userId: wanda.id, roleId });
  return { projectId: p!.id, wanda, nino };
}

describe("i permessi di chi agisce e i gestori", () => {
  it("actorProjectPermissions: il Project Lead di workspace ha release.merge nel progetto, Nino niente", async () => {
    const { projectId, wanda, nino } = await seed("project_lead");
    expect((await actorProjectPermissions(db, member(wanda.id))).get(projectId)?.has("release.merge")).toBe(true);
    expect((await actorProjectPermissions(db, member(nino.id))).has(projectId)).toBe(false);
  });

  it("D18 last_manager: il solo gestore è il Project Lead di workspace, e conta", async () => {
    const { projectId, wanda } = await seed("project_lead");
    expect(await lastManagerProjectOf(db, wanda.id)).toBe(projectId);
  });
});

describe("«Chi può farlo?»", () => {
  it("whoCan: il Viewer di workspace è fra chi ha tickets.view_all, Nino no", async () => {
    const { projectId, wanda, nino } = await seed("viewer");
    const { adminId } = { adminId: (await db.select({ id: (await import("@stubwise/db")).users.id }).from((await import("@stubwise/db")).users).where((await import("drizzle-orm")).eq((await import("@stubwise/db")).users.role, "admin")).limit(1))[0]!.id };
    const people = (await whoCan(db, actorAs(adminId, "admin"), "tickets.view_all", projectId)).people.map((p) => p.userId);
    expect(people).toContain(wanda.id);
    expect(people).not.toContain(nino.id);
  });

  it("viewerLosesIf: cambiare il ruolo di workspace dice cosa perde chi guarda", async () => {
    const [custom] = await db.insert(roles).values({ name: `Ospite ${randomUUID().slice(0, 6)}`, scope: "project", permissions: ["docs.view", "tickets.create"] }).returning();
    const { wanda } = await seed(custom!.id);
    expect(await viewerLosesIf(db, actorAs(wanda.id, "member"), custom!.id, ["docs.view"])).toEqual(["tickets.create"]);
  });
});

describe("i reparti arrivano anche nei progetti visti per workspace (D10)", () => {
  it("judgeDepartmentDraft: mettere Wanda in un reparto che dà release.merge vuole quel permesso in Farmacia", async () => {
    const { projectId, wanda, nino } = await seed("viewer");
    await addMember(app, projectId, nino.id, "developer");
    const [d] = await db.insert(departments).values({ name: `Vendite ${randomUUID().slice(0, 6)}`, colorToken: "--dept-3" }).returning();
    await db.insert(departmentProjectPermissions).values({ departmentId: d!.id, permission: "release.merge" });
    const saved = { memberIds: [], projectPermissions: ["release.merge"] };
    const draft = { memberIds: [wanda.id], projectPermissions: ["release.merge"] };
    // Nino è Developer in Farmacia: non ha release.merge lì, quindi non può farla entrare.
    const judgement = await judgeDepartmentDraft(db, member(nino.id), saved, draft);
    expect(judgement.reach).toBe("projects");
    expect(judgement.missing).toContain("release.merge");
    void departmentMembers;
  });
});

describe("revisione del lotto 2: le viste dicono quello che la scrittura farà", () => {
  it("I-1: Amministrazione → Ruoli giudica un ruolo usato solo da una workspace sui SUOI progetti", async () => {
    const { adminRoleViews } = await import("./admin-roles.js");
    const [custom] = await db.insert(roles).values({ name: `Solo ws ${randomUUID().slice(0, 6)}`, scope: "project", permissions: ["docs.view"] }).returning();
    const { projectId, wanda, nino } = await seed(custom!.id);
    // Nino è Project Lead in un ALTRO progetto, e niente in Farmacia.
    const [other] = await db.insert(projects).values({ name: "Altro", slug: `alt-${randomUUID().slice(0, 6)}`, ingestionKey: randomUUID() }).returning();
    await addMember(app, other!.id, nino.id, "project_lead");
    const view = (await adminRoleViews(db, actorAs(nino.id, "member"))).find((r) => r.id === custom!.id)!;
    expect(view.reach).toBe("projects");
    expect(view.affectedCount).toBe(1);
    expect(view.notGivable).toContain("release.merge");
    void projectId;
    void wanda;
  });

  it("I-2: togliere il membro esplicito non è bloccato se resta gestore per via di workspace", async () => {
    const { previewMember } = await import("./admin-roles.js");
    const { projectId, wanda } = await seed("project_lead");
    await addMember(app, projectId, wanda.id, "project_lead");
    const { adminId } = { adminId: (await db.select({ id: (await import("@stubwise/db")).users.id }).from((await import("@stubwise/db")).users).where((await import("drizzle-orm")).eq((await import("@stubwise/db")).users.role, "admin")).limit(1))[0]!.id };
    const preview = await previewMember(db, actorAs(adminId, "admin"), projectId, wanda.id, { roleId: await presetRoleId(app, "project_lead"), granted: [] });
    expect(preview.removeBlock).toBeNull();
  });

  it("M-3: chi accede già per workspace porta già i suoi reparti: aggiungerlo come membro esplicito non li ricontrolla", async () => {
    const { putProjectMember } = await import("./roles.js");
    const { projectId, wanda, nino } = await seed("viewer");
    await addMember(app, projectId, nino.id, "project_lead");
    const [d] = await db.insert(departments).values({ name: `Ops ${randomUUID().slice(0, 6)}`, colorToken: "--dept-4" }).returning();
    await db.insert(departmentProjectPermissions).values({ departmentId: d!.id, permission: "servers.operate" });
    await db.insert(departmentMembers).values({ departmentId: d!.id, userId: wanda.id });
    // Nino (Project Lead, senza servers.operate) la rende membro esplicito Viewer: niente di nuovo arriva.
    const { projectPermissionsFor } = await import("../auth/access.js");
    const held = (await projectPermissionsFor(db, member(nino.id), projectId))!;
    await expect(putProjectMember(db, member(nino.id), held, projectId, wanda.id, await presetRoleId(app, "viewer"))).resolves.toBeDefined();
  });
});

describe("lotto 3 (46): last_manager anche su updateRole e deleteUser", () => {
  async function adminActor() {
    const { users } = await import("@stubwise/db");
    const { eq } = await import("drizzle-orm");
    const [a] = await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.role, "admin")).limit(1);
    return { ...actorAs(a!.id, "admin"), email: a!.email };
  }

  it("un ruolo modificato che toglie project.members.manage all'ultimo gestore (di workspace, D18): 409, ruolo invariato, anteprima d'accordo", async () => {
    const { updateRole, RoleRuleError, roleEditLastManager } = await import("./roles.js");
    const { PROJECT_PERMISSIONS } = await import("@stubwise/shared");
    const { eq } = await import("drizzle-orm");
    const all = [...PROJECT_PERMISSIONS];
    const [custom] = await db.insert(roles).values({ name: `Gestore ${randomUUID().slice(0, 6)}`, scope: "project", permissions: all }).returning();
    const { projectId } = await seed(custom!.id);
    const without = all.filter((p) => p !== "project.members.manage");
    expect(await roleEditLastManager(db, custom!.id, without)).toBe(projectId);
    expect(await roleEditLastManager(db, custom!.id, all)).toBeNull();
    const error = await updateRole(db, await adminActor(), custom!.id, { permissions: without }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RoleRuleError);
    expect(error).toMatchObject({ status: 409, code: "last_manager", extra: { projectId } });
    const [after] = await db.select({ permissions: roles.permissions }).from(roles).where(eq(roles.id, custom!.id));
    expect(after!.permissions).toContain("project.members.manage");
  });

  it("lo stesso per un membro ESPLICITO", async () => {
    const { updateRole } = await import("./roles.js");
    const { PROJECT_PERMISSIONS } = await import("@stubwise/shared");
    const all = [...PROJECT_PERMISSIONS];
    const [custom] = await db.insert(roles).values({ name: `Esplicito ${randomUUID().slice(0, 6)}`, scope: "project", permissions: all }).returning();
    const [p] = await db.insert(projects).values({ name: "Solo", slug: `solo-${randomUUID().slice(0, 6)}`, ingestionKey: randomUUID() }).returning();
    const u = await createUserWithSession(app, `m-${randomUUID()}@x.test`);
    const { projectMembers } = await import("@stubwise/db");
    await db.insert(projectMembers).values({ projectId: p!.id, userId: u.id, roleId: custom!.id });
    await expect(updateRole(db, await adminActor(), custom!.id, { permissions: all.filter((x) => x !== "project.members.manage") })).rejects.toMatchObject({ code: "last_manager" });
  });

  it("un utente eliminato che era l'ultimo gestore: 409 last_manager, l'utente resta", async () => {
    const { deleteUser } = await import("./roles.js");
    const { users } = await import("@stubwise/db");
    const { eq } = await import("drizzle-orm");
    const { projectId, wanda } = await seed("project_lead");
    await expect(deleteUser(db, await adminActor(), wanda.id)).rejects.toMatchObject({ status: 409, code: "last_manager", extra: { projectId } });
    expect(await db.select({ id: users.id }).from(users).where(eq(users.id, wanda.id))).toHaveLength(1);
  });
});

describe("lotto 3: l'anteprima del ruolo dice last_manager (POST /api/roles/:id/viewer-loses)", () => {
  it("chi vede il progetto ne riceve id e codice; chi ha roles.manage ma non lo vede, solo `blocked`", async () => {
    const { PROJECT_PERMISSIONS } = await import("@stubwise/shared");
    const { fullSessionCookie } = await import("../test/fixtures.js");
    const { users } = await import("@stubwise/db");
    const { eq } = await import("drizzle-orm");
    const all = [...PROJECT_PERMISSIONS];
    const [custom] = await db.insert(roles).values({ name: `Anteprima ${randomUUID().slice(0, 6)}`, scope: "project", permissions: all }).returning();
    const { projectId } = await seed(custom!.id);
    const [admin] = await db.select({ id: users.id }).from(users).where(eq(users.role, "admin")).limit(1);
    const [manager] = await db.insert(roles).values({ name: `Ruoli ${randomUUID().slice(0, 6)}`, scope: "instance", permissions: ["roles.manage"] }).returning();
    const outsider = await createUserWithSession(app, `r-${randomUUID()}@x.test`);
    await db.update(users).set({ instanceRoleId: manager!.id }).where(eq(users.id, outsider.id));
    const body = { permissions: all.filter((p) => p !== "project.members.manage") };
    const ask = async (cookie: string) =>
      (await app.inject({ method: "POST", url: `/api/roles/${custom!.id}/viewer-loses`, headers: { cookie }, payload: body })).json() as {
        lastManager: { blocked: boolean; projectId: string | null };
      };
    expect((await ask(await fullSessionCookie(app, admin!.id))).lastManager).toMatchObject({ blocked: true, projectId });
    expect((await ask(outsider.headers.cookie)).lastManager).toEqual({ blocked: true, projectId: null, projectCode: null });
  });
});

describe("lotto 4: «Chi può farlo?» dice da dove si vede (la fonte `workspace`)", () => {
  it("whoCan e whatCan: un permesso del ruolo di workspace ha il motivo `workspace`, col nome della workspace e del ruolo", async () => {
    const { users } = await import("@stubwise/db");
    const { eq } = await import("drizzle-orm");
    const { whatCan } = await import("./access-query.js");
    const { projectId, wanda } = await seed("viewer");
    const [admin] = await db.select({ id: users.id }).from(users).where(eq(users.role, "admin")).limit(1);
    const viewer = actorAs(admin!.id, "admin");
    const person = (await whoCan(db, viewer, "tickets.view_all", projectId)).people.find((p) => p.userId === wanda.id)!;
    expect(person.reasons).toEqual([expect.objectContaining({ kind: "workspace", workspaceName: "Clienti", roleName: "Viewer" })]);
    const perms = (await whatCan(db, viewer, wanda.id, projectId)).projects[0]!.permissions;
    expect(perms.find((p) => p.permission === "tickets.view_all")!.reasons).toEqual([expect.objectContaining({ kind: "workspace", workspaceName: "Clienti" })]);
  });
});

describe("lotto 4: Members, la persona e l'anteprima dicono la workspace", () => {
  async function admin() {
    const { users } = await import("@stubwise/db");
    const { eq } = await import("drizzle-orm");
    const [a] = await db.select({ id: users.id }).from(users).where(eq(users.role, "admin")).limit(1);
    return actorAs(a!.id, "admin");
  }

  it("Members: chi vede il progetto SOLO per workspace c'è (explicit false, il ruolo di workspace); un membro esplicito ha explicit true", async () => {
    const { projectMembersView } = await import("./admin-roles.js");
    const { projectId, wanda, nino } = await seed("viewer");
    await addMember(app, projectId, nino.id, "developer");
    const view = await projectMembersView(db, await admin(), projectId);
    expect(view.members.find((m) => m.personId === wanda.id)).toMatchObject({ explicit: false, role: { name: "Viewer" }, workspace: { workspaceName: "Clienti", roleName: "Viewer" } });
    expect(view.members.find((m) => m.personId === nino.id)).toMatchObject({ explicit: true, role: { name: "Developer" }, workspace: null });
  });

  it("la pagina della persona: le sue workspace col ruolo", async () => {
    const { personDetail } = await import("./admin-people.js");
    const { wanda } = await seed("viewer");
    const detail = await personDetail(db, await admin(), wanda.id);
    expect(detail.workspaces).toEqual([expect.objectContaining({ name: "Clienti", roleName: "Viewer" })]);
    expect(detail.projects).toEqual([expect.objectContaining({ workspaceOnly: true, workspace: { name: "Clienti", roleName: "Viewer" } })]);
  });

  it("l'anteprima del membro: un permesso del ruolo di workspace ha la fonte `workspace`", async () => {
    const { previewMember } = await import("./admin-roles.js");
    const { projectId, wanda } = await seed("viewer");
    const preview = await previewMember(db, await admin(), projectId, wanda.id, { roleId: await presetRoleId(app, "contributor"), granted: [] });
    const viewAll = preview.permissions.find((p) => p.permission === "tickets.view_all");
    expect(viewAll?.sources).toEqual([expect.objectContaining({ kind: "workspace", workspaceName: "Clienti", roleName: "Viewer" })]);
  });
});
