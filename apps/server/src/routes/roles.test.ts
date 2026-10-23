import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeEmbeddingClient } from "@stubwise/embeddings";
import {
  gitIdentities,
  inviteProjects,
  invites,
  passwordResetTokens,
  projectMembers,
  projects,
  roles,
  users,
} from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { PROJECT_PERMISSIONS } from "@stubwise/shared";
import { hashPassword } from "../auth/password.js";
import {
  addMember,
  createUserWithPat,
  presetRoleId,
  seedUsers,
  sessionCookie,
} from "../test/fixtures.js";

/**
 * Gestione di ruoli e membri (Task 9, design
 * `docs/plans/2026-10-22-permessi-progetto-design.md`): anti-escalation,
 * ultimo full admin, ruolo in uso, nomi unici, inviti con progetti, creatore
 * di un progetto come Project Lead.
 *
 * I test negativi asseriscono anche lo STATO (riga invariata, nessuna riga
 * nuova), non solo lo status.
 */

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);

type Headers = { authorization: string } | { cookie: string };
interface TestUser {
  id: string;
  headers: Headers;
}

let testDb: TestDb;
let app: FastifyInstance;
let projectId: string;
let admin: TestUser;
let plain: TestUser;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
    publicUrl: "https://stubwise.example.com",
    embeddingClient: createFakeEmbeddingClient(),
  });
  const seeded = await seedUsers(app);
  admin = { id: seeded.adminId, headers: { cookie: seeded.adminCookie } };
  plain = { id: seeded.memberId, headers: { cookie: seeded.memberCookie } };
  ({ projectId } = await seedRepository(testDb.db));
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

function call(
  user: TestUser,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  payload?: Record<string, unknown>,
) {
  return app.inject({
    method,
    url,
    headers: user.headers,
    ...(payload !== undefined ? { payload } : {}),
  });
}

async function createRole(
  name: string,
  scope: "instance" | "project",
  permissions: string[],
): Promise<string> {
  const [row] = await testDb.db
    .insert(roles)
    .values({ name, scope, permissions })
    .returning({ id: roles.id });
  return row!.id;
}

/** Un utente con PAT e un ruolo d'istanza personalizzato. */
async function userWithInstanceRole(email: string, permissions: string[]): Promise<TestUser> {
  const user = await createUserWithPat(app, email);
  const roleId = await createRole(`inst-${email}`, "instance", permissions);
  await testDb.db.update(users).set({ instanceRoleId: roleId }).where(eq(users.id, user.id));
  return user;
}

async function roleRow(id: string) {
  const [row] = await testDb.db.select().from(roles).where(eq(roles.id, id));
  return row;
}

async function memberRole(pid: string, userId: string): Promise<string | null> {
  const [row] = await testDb.db
    .select({ roleId: projectMembers.roleId })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, pid), eq(projectMembers.userId, userId)));
  return row?.roleId ?? null;
}

async function instanceRoleOf(userId: string): Promise<string | undefined> {
  const [row] = await testDb.db
    .select({ roleId: users.instanceRoleId })
    .from(users)
    .where(eq(users.id, userId));
  return row?.roleId;
}

describe("membri di progetto: anti-escalation", () => {
  let manager: TestUser;
  let target: TestUser;
  let managerRoleId: string;
  let docsReaderId: string;

  beforeAll(async () => {
    manager = await createUserWithPat(app, "members-manager@example.com");
    target = await createUserWithPat(app, "members-target@example.com");
    // Gestisce i membri, ma non può mergiare: non può dare Project Lead.
    managerRoleId = await createRole("Members manager", "project", [
      "project.members.manage",
      "docs.view",
      "tickets.create",
      "tickets.comment",
      "backlog.create",
    ]);
    await testDb.db
      .insert(projectMembers)
      .values({ projectId, userId: manager.id, roleId: managerRoleId });
    // Il ruolo attuale del bersaglio sta dentro quelli del manager (R28).
    docsReaderId = await createRole("Docs reader", "project", ["docs.view"]);
    await testDb.db
      .insert(projectMembers)
      .values({ projectId, userId: target.id, roleId: docsReaderId });
  });

  it("assegnare Project Lead senza release.merge → 403 e membri invariati", async () => {
    const res = await call(manager, "PUT", `/api/projects/${projectId}/members/${target.id}`, {
      roleId: await presetRoleId(app, "project_lead"),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "escalation", permission: expect.any(String) });
    expect(await memberRole(projectId, target.id)).toBe(docsReaderId);
  });

  it("aggiungere un nuovo membro con un ruolo che eccede → 403 e nessuna riga", async () => {
    const outsider = await createUserWithPat(app, "members-outsider@example.com");
    const res = await call(manager, "PUT", `/api/projects/${projectId}/members/${outsider.id}`, {
      roleId: await presetRoleId(app, "developer"),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "escalation" });
    expect(await memberRole(projectId, outsider.id)).toBeNull();
  });

  it("assegnare un ruolo incluso nei propri permessi → 200 (Contributor)", async () => {
    const contributor = await presetRoleId(app, "contributor");
    const res = await call(manager, "PUT", `/api/projects/${projectId}/members/${target.id}`, {
      roleId: contributor,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      userId: target.id,
      roleId: contributor,
      roleName: "Contributor",
    });
    expect(await memberRole(projectId, target.id)).toBe(contributor);
  });

  it("R28: senza release.merge non si cambia né si toglie un Project Lead → 403, invariato", async () => {
    const lead = await createUserWithPat(app, "members-lead@example.com");
    await addMember(app, projectId, lead.id, "project_lead");
    const leadRole = await presetRoleId(app, "project_lead");
    const change = await call(manager, "PUT", `/api/projects/${projectId}/members/${lead.id}`, {
      roleId: await presetRoleId(app, "contributor"),
    });
    expect(change.statusCode).toBe(403);
    expect(change.json()).toMatchObject({ code: "target_above", permission: expect.any(String) });
    expect(await memberRole(projectId, lead.id)).toBe(leadRole);
    const remove = await call(manager, "DELETE", `/api/projects/${projectId}/members/${lead.id}`);
    expect(remove.statusCode).toBe(403);
    expect(remove.json()).toMatchObject({ code: "target_above" });
    expect(await memberRole(projectId, lead.id)).toBe(leadRole);
  });

  it("R28: un Project Lead (non full admin) cambia il ruolo di un Developer → 200", async () => {
    const lead = await createUserWithPat(app, "members-lead-2@example.com");
    const dev = await createUserWithPat(app, "members-dev@example.com");
    await addMember(app, projectId, lead.id, "project_lead");
    await addMember(app, projectId, dev.id, "developer");
    const viewer = await presetRoleId(app, "viewer");
    const res = await call(lead, "PUT", `/api/projects/${projectId}/members/${dev.id}`, {
      roleId: viewer,
    });
    expect(res.statusCode).toBe(200);
    expect(await memberRole(projectId, dev.id)).toBe(viewer);
  });

  it("un ruolo che non esiste → 404 role_not_found, nessuna riga", async () => {
    const res = await call(manager, "PUT", `/api/projects/${projectId}/members/${target.id}`, {
      roleId: "00000000-0000-4000-8000-000000000000",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "role_not_found" });
  });

  it("un ruolo d'istanza non è un ruolo di progetto → 400", async () => {
    const res = await call(manager, "PUT", `/api/projects/${projectId}/members/${target.id}`, {
      roleId: await presetRoleId(app, "user"),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "invalid_role_scope" });
  });

  it("GET dei membri: ogni membro sì, un non membro 404", async () => {
    const ok = await call(target, "GET", `/api/projects/${projectId}/members`);
    expect(ok.statusCode).toBe(200);
    const ids = (ok.json() as { userId: string }[]).map((m) => m.userId);
    expect(ids).toEqual(expect.arrayContaining([manager.id, target.id]));
    const outsider = await createUserWithPat(app, "members-nosy@example.com");
    expect((await call(outsider, "GET", `/api/projects/${projectId}/members`)).statusCode).toBe(
      404,
    );
  });

  it("senza project.members.manage → 403; togliere un membro → 204", async () => {
    const res = await call(target, "DELETE", `/api/projects/${projectId}/members/${manager.id}`);
    expect(res.statusCode).toBe(403);
    expect(await memberRole(projectId, manager.id)).toBe(managerRoleId);

    const removed = await call(
      manager,
      "DELETE",
      `/api/projects/${projectId}/members/${target.id}`,
    );
    expect(removed.statusCode).toBe(204);
    expect(await memberRole(projectId, target.id)).toBeNull();
  });
});

describe("ruoli: anti-escalation di chi ha roles.manage senza full admin", () => {
  let rolesManager: TestUser;
  let ownRoleId: string;

  beforeAll(async () => {
    rolesManager = await userWithInstanceRole("roles-manager@example.com", [
      "roles.manage",
      "users.view_all",
    ]);
    ownRoleId = (await instanceRoleOf(rolesManager.id))!;
  });

  it("R30: non toglie permessi ad Admin né a Project Lead (né li elimina) → 403, invariati", async () => {
    for (const key of ["admin", "project_lead"]) {
      const id = await presetRoleId(app, key);
      const before = await roleRow(id);
      const strip = await call(rolesManager, "PATCH", `/api/roles/${id}`, { permissions: [] });
      expect(strip.statusCode).toBe(403);
      expect(strip.json()).toMatchObject({ code: "target_above" });
      const rename = await call(rolesManager, "PATCH", `/api/roles/${id}`, { name: `${key} x` });
      expect(rename.statusCode).toBe(403);
      expect(rename.json()).toMatchObject({ code: "target_above" });
      const removed = await call(rolesManager, "DELETE", `/api/roles/${id}`);
      expect(removed.statusCode).toBe(403);
      expect(removed.json()).toMatchObject({ code: "target_above" });
      expect(await roleRow(id)).toEqual(before);
    }
  });

  it("un ruolo promesso da un invito pendente conta come assegnato: non lo si allarga oltre i propri permessi lì → 403", async () => {
    // Chi gestisce i ruoli è Project Lead del progetto A, non di B.
    const actor = await userWithInstanceRole("roles-manager-lead@example.com", ["roles.manage"]);
    await addMember(app, projectId, actor.id, "project_lead");
    const { projectId: projectB } = await seedRepository(testDb.db);
    const roleR = await createRole("Promised", "project", ["docs.view"]);
    const invite = await call(admin, "POST", "/api/auth/invites", {
      email: "promised@example.com",
      projects: [{ projectId: projectB, roleId: roleR }],
    });
    expect(invite.statusCode).toBe(201);
    const res = await call(actor, "PATCH", `/api/roles/${roleR}`, {
      permissions: [...PROJECT_PERMISSIONS],
    });
    expect(res.statusCode).toBe(403);
    // Il ruolo, promesso in B, ha già permessi che lì chi agisce non ha (R30).
    expect(res.json()).toMatchObject({ code: "target_above" });
    expect((await roleRow(roleR))!.permissions).toEqual(["docs.view"]);
  });

  it("non crea un ruolo con instance.full_admin né con permessi che non ha → 403, nessuna riga", async () => {
    for (const permissions of [["instance.full_admin"], ["users.manage"]]) {
      const name = `Escalation ${permissions[0]}`;
      const res = await call(rolesManager, "POST", "/api/roles", {
        name,
        scope: "instance",
        permissions,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: "escalation", permission: permissions[0] });
      const rows = await testDb.db.select().from(roles).where(eq(roles.name, name));
      expect(rows).toEqual([]);
    }
  });

  it("crea un ruolo con permessi che ha → 201", async () => {
    const res = await call(rolesManager, "POST", "/api/roles", {
      name: "Directory reader",
      scope: "instance",
      permissions: ["users.view_all"],
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      name: "Directory reader",
      presetKey: null,
      assignmentCount: 0,
    });
  });

  it("non aggiunge instance.full_admin né permessi che non ha a un ruolo esistente → 403, ruolo invariato", async () => {
    const roleId = await createRole("Someone else's", "instance", ["users.view_all"]);
    for (const extra of ["instance.full_admin", "settings.manage"]) {
      const res = await call(rolesManager, "PATCH", `/api/roles/${roleId}`, {
        permissions: ["users.view_all", extra],
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: "escalation", permission: extra });
      expect((await roleRow(roleId))!.permissions).toEqual(["users.view_all"]);
    }
  });

  it("non allarga il ruolo che possiede → 403, ruolo invariato", async () => {
    const before = await roleRow(ownRoleId);
    const res = await call(rolesManager, "PATCH", `/api/roles/${ownRoleId}`, {
      permissions: ["roles.manage", "users.view_all", "users.manage"],
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "escalation", permission: "users.manage" });
    expect(await roleRow(ownRoleId)).toEqual(before);
  });

  it("un ruolo di progetto non prende permessi di progetto che non ha in nessun progetto → 403", async () => {
    const res = await call(rolesManager, "POST", "/api/roles", {
      name: "Project escalation",
      scope: "project",
      permissions: ["release.merge"],
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "escalation", permission: "release.merge" });
  });

  it("chiavi di un altro livello o inesistenti → 400", async () => {
    const res = await call(admin, "POST", "/api/roles", {
      name: "Mixed",
      scope: "instance",
      permissions: ["release.merge"],
    });
    expect(res.statusCode).toBe(400);
    const roleId = await createRole("Patch mixed", "project", ["docs.view"]);
    const patched = await call(admin, "PATCH", `/api/roles/${roleId}`, {
      permissions: ["docs.view", "users.manage"],
    });
    expect(patched.statusCode).toBe(400);
    expect(patched.json()).toMatchObject({ code: "invalid_permissions" });
    expect((await roleRow(roleId))!.permissions).toEqual(["docs.view"]);
  });

  it("senza roles.manage: niente scrittura, e l'elenco solo a chi deve scegliere un ruolo", async () => {
    const outsider = await createUserWithPat(app, "roles-outsider@example.com");
    const denied = await call(outsider, "GET", "/api/roles");
    expect(denied.statusCode).toBe(403);
    // La guardia della rotta resta `forbidden`: non è un'escalation.
    expect(denied.json()).toMatchObject({ code: "forbidden" });
    expect(
      (
        await call(outsider, "POST", "/api/roles", {
          name: "Nope",
          scope: "project",
          permissions: [],
        })
      ).statusCode,
    ).toBe(403);
    // Chi gestisce i membri di un progetto vede il catalogo per scegliere.
    await addMember(app, projectId, outsider.id, "project_lead");
    const list = await call(outsider, "GET", "/api/roles?scope=project");
    expect(list.statusCode).toBe(200);
    const names = (list.json() as { name: string; scope: string }[]).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(["Project Lead", "Viewer"]));
    expect((list.json() as { scope: string }[]).every((r) => r.scope === "project")).toBe(true);
  });
});

describe("ruoli: modifica, duplicazione, nomi, ruolo in uso", () => {
  it("PATCH aggiorna updatedAt", async () => {
    const roleId = await createRole("Stamp", "project", ["docs.view"]);
    const before = (await roleRow(roleId))!.updatedAt;
    const res = await call(admin, "PATCH", `/api/roles/${roleId}`, { name: "Stamped" });
    expect(res.statusCode).toBe(200);
    expect((await roleRow(roleId))!.updatedAt.getTime()).toBeGreaterThan(before.getTime());
  });

  it("nome duplicato nello stesso tipo (anche cambiando le maiuscole) → 409; in un altro tipo va bene", async () => {
    const dup = await call(admin, "POST", "/api/roles", {
      name: "project lead",
      scope: "project",
      permissions: [],
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ code: "role_name_taken" });

    const roleId = await createRole("Rename me", "project", []);
    const renamed = await call(admin, "PATCH", `/api/roles/${roleId}`, { name: "VIEWER" });
    expect(renamed.statusCode).toBe(409);
    expect((await roleRow(roleId))!.name).toBe("Rename me");

    const other = await call(admin, "POST", "/api/roles", {
      name: "Project Lead",
      scope: "instance",
      permissions: [],
    });
    expect(other.statusCode).toBe(201);
  });

  it("duplica un ruolo con «(copy)» e gli stessi permessi", async () => {
    const developer = await presetRoleId(app, "developer");
    const res = await call(admin, "POST", `/api/roles/${developer}/duplicate`, {});
    expect(res.statusCode).toBe(201);
    const copy = res.json() as { name: string; permissions: string[]; presetKey: string | null };
    expect(copy.name).toBe("Developer (copy)");
    expect(copy.presetKey).toBeNull();
    expect(copy.permissions).toEqual((await roleRow(developer))!.permissions);
    // Una seconda copia senza nome collide.
    expect((await call(admin, "POST", `/api/roles/${developer}/duplicate`, {})).statusCode).toBe(
      409,
    );
  });

  it("eliminare un ruolo assegnato → 409 role_in_use col conteggio; libero → 204", async () => {
    const roleId = await createRole("Assigned", "project", ["docs.view"]);
    const someone = await createUserWithPat(app, "assigned@example.com");
    await testDb.db.insert(projectMembers).values({ projectId, userId: someone.id, roleId });
    const res = await call(admin, "DELETE", `/api/roles/${roleId}`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "role_in_use", count: 1 });
    expect(await roleRow(roleId)).toBeDefined();

    const free = await createRole("Free", "project", []);
    expect((await call(admin, "DELETE", `/api/roles/${free}`)).statusCode).toBe(204);
    expect(await roleRow(free)).toBeUndefined();
  });

  it("i preset User e Admin non si eliminano (role_required_by_system), gli altri preset sì", async () => {
    const res = await call(admin, "DELETE", `/api/roles/${await presetRoleId(app, "user")}`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "role_required_by_system" });

    // Un preset qualunque non è speciale: in uso lo protegge role_in_use.
    const holder = await createUserWithPat(app, "viewer-holder@example.com");
    await addMember(app, projectId, holder.id, "viewer");
    const viewer = await presetRoleId(app, "viewer");
    expect((await call(admin, "DELETE", `/api/roles/${viewer}`)).json()).toMatchObject({
      code: "role_in_use",
    });
    // Libero, si elimina come gli altri (qui una copia, per non togliere il
    // preset agli altri test).
    const copy = await call(admin, "POST", `/api/roles/${viewer}/duplicate`, { name: "Viewer 2" });
    expect(
      (await call(admin, "DELETE", `/api/roles/${(copy.json() as { id: string }).id}`)).statusCode,
    ).toBe(204);
  });
});

describe("ultimo full admin", () => {
  let usersManager: TestUser;
  let adminRoleId: string;

  beforeAll(async () => {
    usersManager = await userWithInstanceRole("users-manager@example.com", [
      "users.manage",
      "monitor.view",
      "users.view_all",
      "git_accounts.view",
      "mail_admission.view",
    ]);
    adminRoleId = await presetRoleId(app, "admin");
  });

  it("eliminare il ruolo Admin → 409 last_full_admin, ruolo intatto", async () => {
    const res = await call(admin, "DELETE", `/api/roles/${adminRoleId}`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "last_full_admin" });
    expect((await roleRow(adminRoleId))!.permissions).toEqual(["instance.full_admin"]);
  });

  it("togliere instance.full_admin al ruolo Admin → 409, permessi intatti", async () => {
    const res = await call(admin, "PATCH", `/api/roles/${adminRoleId}`, {
      permissions: ["users.manage"],
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "last_full_admin" });
    expect((await roleRow(adminRoleId))!.permissions).toEqual(["instance.full_admin"]);
    const [row] = await testDb.db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, admin.id));
    expect(row!.role).toBe("admin");
  });

  it("cambiare il ruolo d'istanza dell'unico admin (da sé stesso) → 409, ruolo intatto", async () => {
    const res = await call(admin, "PATCH", `/api/users/${admin.id}/instance-role`, {
      roleId: await presetRoleId(app, "user"),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "last_full_admin" });
    expect(await instanceRoleOf(admin.id)).toBe(adminRoleId);
  });

  it("R28: chi ha solo users.manage non declassa un full admin → 403, ruolo intatto", async () => {
    const res = await call(usersManager, "PATCH", `/api/users/${admin.id}/instance-role`, {
      roleId: await presetRoleId(app, "user"),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "target_above", permission: "instance.full_admin" });
    expect(await instanceRoleOf(admin.id)).toBe(adminRoleId);
  });

  it("R28: chi ha users.manage cambia il ruolo di un utente che non gli sta sopra → 200", async () => {
    const someone = await createUserWithPat(app, "plain-user@example.com");
    const managerRole = (await instanceRoleOf(usersManager.id))!;
    const res = await call(usersManager, "PATCH", `/api/users/${someone.id}/instance-role`, {
      roleId: managerRole,
    });
    expect(res.statusCode).toBe(200);
    expect(await instanceRoleOf(someone.id)).toBe(managerRole);
  });

  it("la rotta legacy /role passa dalla stessa guardia (codice last_admin)", async () => {
    const res = await call(admin, "PATCH", `/api/users/${admin.id}/role`, { role: "member" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "last_admin" });
    expect(await instanceRoleOf(admin.id)).toBe(adminRoleId);
  });

  it("R31: chi ha solo users.manage non crea un link di reset per un full admin → 403, nessun token", async () => {
    const res = await call(usersManager, "POST", `/api/users/${admin.id}/password-reset`);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "target_above" });
    const tokens = await testDb.db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, admin.id));
    expect(tokens).toEqual([]);
  });

  it("R31: né collega un'identità git a un full admin → 403, nessuna riga", async () => {
    const res = await call(usersManager, "POST", `/api/users/${admin.id}/git-identities`, {
      email: "someone@git.example.com",
    });
    expect(res.statusCode).toBe(403);
    // `permission` arriva: la rotta dichiara lo schema degli errori di regola.
    expect(res.json()).toMatchObject({ code: "target_above", permission: "instance.full_admin" });
    const rows = await testDb.db
      .select()
      .from(gitIdentities)
      .where(eq(gitIdentities.userId, admin.id));
    expect(rows).toEqual([]);
  });

  it("R50: users.manage d'istanza non resetta la password di un Project Lead di un progetto dove non ha nulla → 403, nessun token", async () => {
    const { projectId: leadProject } = await seedRepository(testDb.db);
    // Stessi permessi d'istanza del manager: la regola d'istanza (R31) passa,
    // a fermarlo è solo il progetto.
    const lead = await createUserWithPat(app, "r50-lead@example.com");
    await testDb.db
      .update(users)
      .set({ instanceRoleId: (await instanceRoleOf(usersManager.id))! })
      .where(eq(users.id, lead.id));
    await addMember(app, leadProject, lead.id, "project_lead");
    // Il reset vuole una sessione del browser: il manager fa login.
    await testDb.db
      .update(users)
      .set({ passwordHash: await hashPassword("password-manager") })
      .where(eq(users.id, usersManager.id));
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "users-manager@example.com", password: "password-manager" },
    });
    expect(login.statusCode).toBe(200);
    const browser = { id: usersManager.id, headers: { cookie: sessionCookie(login) } };
    const res = await call(browser, "POST", `/api/users/${lead.id}/password-reset`);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "target_above" });
    const tokens = await testDb.db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, lead.id));
    expect(tokens).toEqual([]);
    // Né gli cambia il ruolo d'istanza.
    const before = await instanceRoleOf(lead.id);
    const role = await call(usersManager, "PATCH", `/api/users/${lead.id}/instance-role`, {
      roleId: before!,
    });
    expect(role.statusCode).toBe(403);
    expect(role.json()).toMatchObject({ code: "target_above" });
    // Con lo stesso ruolo nel progetto, invece, il reset passa.
    await addMember(app, leadProject, usersManager.id, "project_lead");
    const ok = await call(browser, "POST", `/api/users/${lead.id}/password-reset`);
    expect(ok.statusCode).toBe(201);
  });

  it("chi non è full admin non assegna Admin (403) né un ruolo con permessi che non ha", async () => {
    const victim = await createUserWithPat(app, "promote-me@example.com");
    const before = await instanceRoleOf(victim.id);
    const res = await call(usersManager, "PATCH", `/api/users/${victim.id}/instance-role`, {
      roleId: adminRoleId,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "escalation", permission: "instance.full_admin" });
    expect(await instanceRoleOf(victim.id)).toBe(before);
  });
});

describe("inviti con ruolo d'istanza e progetti", () => {
  it("all'accettazione l'utente ha il ruolo d'istanza e i progetti dell'invito", async () => {
    const { projectId: otherProject } = await seedRepository(testDb.db);
    const readerRole = await createRole("Invite reader", "instance", ["users.view_all"]);
    const viewer = await presetRoleId(app, "viewer");
    const developer = await presetRoleId(app, "developer");
    const invite = await call(admin, "POST", "/api/auth/invites", {
      email: "invited-projects@example.com",
      instanceRoleId: readerRole,
      projects: [
        { projectId, roleId: viewer },
        { projectId: otherProject, roleId: developer },
      ],
    });
    expect(invite.statusCode).toBe(201);
    const token = (invite.json() as { token: string }).token;
    expect(
      await testDb.db.select().from(inviteProjects).where(eq(inviteProjects.inviteToken, token)),
    ).toHaveLength(2);

    const register = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { token, email: "invited-projects@example.com", password: "password-invitato" },
    });
    expect(register.statusCode).toBe(201);
    const userId = (register.json() as { user: { id: string } }).user.id;
    expect(await instanceRoleOf(userId)).toBe(readerRole);
    expect(await memberRole(projectId, userId)).toBe(viewer);
    expect(await memberRole(otherProject, userId)).toBe(developer);
  });

  it("senza ruolo né progetti: User, nessun progetto (come prima)", async () => {
    const invite = await call(admin, "POST", "/api/auth/invites", {
      email: "plain-invite@example.com",
    });
    const register = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        token: (invite.json() as { token: string }).token,
        email: "plain-invite@example.com",
        password: "password-invitato",
      },
    });
    const userId = (register.json() as { user: { id: string } }).user.id;
    expect(await instanceRoleOf(userId)).toBe(await presetRoleId(app, "user"));
    expect(
      await testDb.db.select().from(projectMembers).where(eq(projectMembers.userId, userId)),
    ).toEqual([]);
  });

  it("chi invita senza project.members.manage nel progetto → 403; progetto invisibile → 404; nessun invito", async () => {
    const inviter = await userWithInstanceRole("inviter@example.com", ["users.invite"]);
    await addMember(app, projectId, inviter.id, "developer");
    const { projectId: hidden } = await seedRepository(testDb.db);
    const viewer = await presetRoleId(app, "viewer");
    const forbidden = await call(inviter, "POST", "/api/auth/invites", {
      email: "nope-1@example.com",
      projects: [{ projectId, roleId: viewer }],
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({ code: "forbidden" });
    const invisible = await call(inviter, "POST", "/api/auth/invites", {
      email: "nope-2@example.com",
      projects: [{ projectId: hidden, roleId: viewer }],
    });
    expect(invisible.statusCode).toBe(404);
    // Ruolo d'istanza con permessi che non ha → 403.
    const escalation = await call(inviter, "POST", "/api/auth/invites", {
      email: "nope-3@example.com",
      instanceRoleId: await presetRoleId(app, "admin"),
    });
    expect(escalation.statusCode).toBe(403);
    expect(escalation.json()).toMatchObject({
      code: "escalation",
      permission: "instance.full_admin",
    });
    // Anche un ruolo d'istanza qualunque con un permesso che chi invita non ha.
    const wider = await createRole("Wider than inviter", "instance", [
      "users.invite",
      "settings.manage",
    ]);
    const widerInvite = await call(inviter, "POST", "/api/auth/invites", {
      email: "nope-4@example.com",
      instanceRoleId: wider,
    });
    expect(widerInvite.statusCode).toBe(403);
    expect(widerInvite.json()).toMatchObject({ code: "escalation", permission: "settings.manage" });
    const pending = (await call(admin, "GET", "/api/auth/invites")).json() as { email: string }[];
    expect(pending.map((i) => i.email)).not.toEqual(expect.arrayContaining(["nope-1@example.com"]));
    expect(pending.some((i) => i.email.startsWith("nope-"))).toBe(false);
  });
});

describe("inviti: ruling R51", () => {
  it("senza instanceRoleId si verifica il preset User: chi ha solo users.invite → 403 escalation, nessun invito", async () => {
    const inviter = await userWithInstanceRole("r51-only-invite@example.com", ["users.invite"]);
    const res = await call(inviter, "POST", "/api/auth/invites", {
      email: "r51-nope@example.com",
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "escalation", permission: expect.any(String) });
    const pending = (await call(admin, "GET", "/api/auth/invites")).json() as { email: string }[];
    expect(pending.some((i) => i.email === "r51-nope@example.com")).toBe(false);
  });

  it("senza instanceRoleId, con i permessi di User: l'invito salva il preset User e chi l'ha creato", async () => {
    const user = (await roleRow(await presetRoleId(app, "user")))!;
    const inviter = await userWithInstanceRole("r51-user-plus@example.com", [
      ...user.permissions,
      "users.invite",
    ]);
    const res = await call(inviter, "POST", "/api/auth/invites", {
      email: "r51-ok@example.com",
    });
    expect(res.statusCode).toBe(201);
    const token = (res.json() as { token: string }).token;
    const [row] = await testDb.db.select().from(invites).where(eq(invites.token, token));
    expect(row?.instanceRoleId).toBe(user.id);
    expect(row?.invitedByUserId).toBe(inviter.id);
  });

  it("all'accettazione un progetto si scarta se chi ha invitato ha perso project.members.manage", async () => {
    const user = (await roleRow(await presetRoleId(app, "user")))!;
    const inviter = await userWithInstanceRole("r51-lead@example.com", [
      ...user.permissions,
      "users.invite",
    ]);
    const { projectId: kept } = await seedRepository(testDb.db);
    const { projectId: lost } = await seedRepository(testDb.db);
    await addMember(app, kept, inviter.id, "project_lead");
    await addMember(app, lost, inviter.id, "project_lead");
    const viewer = await presetRoleId(app, "viewer");
    const invite = await call(inviter, "POST", "/api/auth/invites", {
      email: "r51-invited@example.com",
      projects: [
        { projectId: kept, roleId: viewer },
        { projectId: lost, roleId: viewer },
      ],
    });
    expect(invite.statusCode).toBe(201);
    // Fra l'invito e l'accettazione l'invitante diventa Contributor in `lost`.
    await testDb.db
      .update(projectMembers)
      .set({ roleId: await presetRoleId(app, "contributor") })
      .where(and(eq(projectMembers.projectId, lost), eq(projectMembers.userId, inviter.id)));

    const register = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        token: (invite.json() as { token: string }).token,
        email: "r51-invited@example.com",
        password: "password-invitato",
      },
    });
    expect(register.statusCode).toBe(201);
    const userId = (register.json() as { user: { id: string } }).user.id;
    expect(await memberRole(kept, userId)).toBe(viewer);
    expect(await memberRole(lost, userId)).toBeNull();
  });
});

describe("chi crea un progetto ne diventa Project Lead", () => {
  it("un creatore non full admin diventa membro Project Lead e vede il progetto", async () => {
    const creator = await userWithInstanceRole("creator@example.com", ["projects.create"]);
    const res = await call(creator, "POST", "/api/projects", { name: "Creato da un lead" });
    expect(res.statusCode).toBe(201);
    const created = (res.json() as { id: string }).id;
    expect(await memberRole(created, creator.id)).toBe(await presetRoleId(app, "project_lead"));
    expect((await call(creator, "GET", `/api/projects/${created}`)).statusCode).toBe(200);
  });

  it("senza un ruolo con tutti i permessi di progetto: 409 no_lead_role e nessun progetto", async () => {
    const creator = await userWithInstanceRole("creator-2@example.com", ["projects.create"]);
    const lead = await presetRoleId(app, "project_lead");
    const original = (await roleRow(lead))!;
    // Il preset «sparisce» e nessun altro ruolo ha tutti i permessi.
    await testDb.db
      .update(roles)
      .set({ presetKey: null, permissions: original.permissions.filter((p) => p !== "prs.adopt") })
      .where(eq(roles.id, lead));
    try {
      const res = await call(creator, "POST", "/api/projects", { name: "Senza lead" });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "no_lead_role" });
      expect(
        await testDb.db.select().from(projects).where(eq(projects.name, "Senza lead")),
      ).toEqual([]);
      // Un full admin lo crea lo stesso (vede ogni progetto senza esserne membro).
      expect(
        (await call(admin, "POST", "/api/projects", { name: "Admin senza lead" })).statusCode,
      ).toBe(201);
    } finally {
      await testDb.db
        .update(roles)
        .set({ presetKey: "project_lead", permissions: original.permissions })
        .where(eq(roles.id, lead));
    }
  });
});

// `plain` (il member del seed) resta un utente senza permessi di gestione.
describe("superficie per un utente senza permessi", () => {
  it("niente ruoli né cambi di ruolo", async () => {
    expect(
      (
        await call(plain, "PATCH", `/api/users/${admin.id}/instance-role`, {
          roleId: await presetRoleId(app, "user"),
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await call(plain, "DELETE", `/api/roles/${await presetRoleId(app, "viewer")}`)).statusCode,
    ).toBe(403);
  });
});
