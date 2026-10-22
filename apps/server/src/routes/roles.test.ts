import { randomBytes } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeEmbeddingClient } from "@stubwise/embeddings";
import { inviteProjects, projectMembers, projects, roles, users } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { addMember, createUserWithPat, presetRoleId, seedUsers } from "../test/fixtures.js";

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
    await addMember(app, projectId, target.id, "viewer");
  });

  it("assegnare Project Lead senza release.merge → 403 e membri invariati", async () => {
    const viewer = await presetRoleId(app, "viewer");
    const res = await call(manager, "PUT", `/api/projects/${projectId}/members/${target.id}`, {
      roleId: await presetRoleId(app, "project_lead"),
    });
    expect(res.statusCode).toBe(403);
    expect(await memberRole(projectId, target.id)).toBe(viewer);
  });

  it("aggiungere un nuovo membro con un ruolo che eccede → 403 e nessuna riga", async () => {
    const outsider = await createUserWithPat(app, "members-outsider@example.com");
    const res = await call(manager, "PUT", `/api/projects/${projectId}/members/${outsider.id}`, {
      roleId: await presetRoleId(app, "developer"),
    });
    expect(res.statusCode).toBe(403);
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

  it("non crea un ruolo con instance.full_admin né con permessi che non ha → 403, nessuna riga", async () => {
    for (const permissions of [["instance.full_admin"], ["users.manage"]]) {
      const name = `Escalation ${permissions[0]}`;
      const res = await call(rolesManager, "POST", "/api/roles", {
        name,
        scope: "instance",
        permissions,
      });
      expect(res.statusCode).toBe(403);
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
      expect((await roleRow(roleId))!.permissions).toEqual(["users.view_all"]);
    }
  });

  it("non allarga il ruolo che possiede → 403, ruolo invariato", async () => {
    const before = await roleRow(ownRoleId);
    const res = await call(rolesManager, "PATCH", `/api/roles/${ownRoleId}`, {
      permissions: ["roles.manage", "users.view_all", "users.manage"],
    });
    expect(res.statusCode).toBe(403);
    expect(await roleRow(ownRoleId)).toEqual(before);
  });

  it("un ruolo di progetto non prende permessi di progetto che non ha in nessun progetto → 403", async () => {
    const res = await call(rolesManager, "POST", "/api/roles", {
      name: "Project escalation",
      scope: "project",
      permissions: ["release.merge"],
    });
    expect(res.statusCode).toBe(403);
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
    expect((await call(outsider, "GET", "/api/roles")).statusCode).toBe(403);
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

  it("cambiare il ruolo d'istanza dell'unico admin → 409 (anche da sé stesso), ruolo intatto", async () => {
    const userRole = await presetRoleId(app, "user");
    for (const actor of [usersManager, admin]) {
      const res = await call(actor, "PATCH", `/api/users/${admin.id}/instance-role`, {
        roleId: userRole,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "last_full_admin" });
      expect(await instanceRoleOf(admin.id)).toBe(adminRoleId);
    }
  });

  it("la rotta legacy /role passa dalla stessa guardia (codice last_admin)", async () => {
    const res = await call(admin, "PATCH", `/api/users/${admin.id}/role`, { role: "member" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "last_admin" });
    expect(await instanceRoleOf(admin.id)).toBe(adminRoleId);
  });

  it("eliminare l'unico admin → 409, utente ancora lì", async () => {
    const res = await call(usersManager, "DELETE", `/api/users/${admin.id}`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "last_full_admin" });
    expect(await instanceRoleOf(admin.id)).toBe(adminRoleId);
  });

  it("chi non è full admin non assegna Admin (403) né un ruolo con permessi che non ha", async () => {
    const victim = await createUserWithPat(app, "promote-me@example.com");
    const before = await instanceRoleOf(victim.id);
    const res = await call(usersManager, "PATCH", `/api/users/${victim.id}/instance-role`, {
      roleId: adminRoleId,
    });
    expect(res.statusCode).toBe(403);
    expect(await instanceRoleOf(victim.id)).toBe(before);
  });

  it("non ci si elimina da soli (400); un utente qualunque sì (204)", async () => {
    expect((await call(usersManager, "DELETE", `/api/users/${usersManager.id}`)).statusCode).toBe(
      400,
    );
    const victim = await createUserWithPat(app, "delete-me@example.com");
    expect((await call(usersManager, "DELETE", `/api/users/${victim.id}`)).statusCode).toBe(204);
    expect(await instanceRoleOf(victim.id)).toBeUndefined();
  });

  it("con due admin, due declassamenti concorrenti: ne passa uno solo", async () => {
    // Esattamente due full admin (second e third), declassati INSIEME da chi
    // gestisce gli utenti senza esserlo, dalla rotta. L'intreccio che senza
    // lock lascerebbe zero admin qui non è garantito: lo forza a mano
    // `services/roles.test.ts`, che fallisce togliendo il lock.
    const second = await createUserWithPat(app, "second-admin@example.com");
    const third = await createUserWithPat(app, "third-admin@example.com");
    const userRole = await presetRoleId(app, "user");
    await testDb.db
      .update(users)
      .set({ instanceRoleId: adminRoleId })
      .where(inArray(users.id, [second.id, third.id]));
    await testDb.db.update(users).set({ instanceRoleId: userRole }).where(eq(users.id, admin.id));
    try {
      const results = await Promise.all(
        [second, third].map((target) =>
          call(usersManager, "PATCH", `/api/users/${target.id}/instance-role`, {
            roleId: userRole,
          }),
        ),
      );
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      const remaining = await testDb.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.instanceRoleId, adminRoleId));
      expect(remaining).toHaveLength(1);
    } finally {
      // Il primo admin torna Admin: gli altri test lo usano.
      await testDb.db
        .update(users)
        .set({ instanceRoleId: adminRoleId })
        .where(eq(users.id, admin.id));
    }
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
    const pending = (await call(admin, "GET", "/api/auth/invites")).json() as { email: string }[];
    expect(pending.map((i) => i.email)).not.toEqual(expect.arrayContaining(["nope-1@example.com"]));
    expect(pending.some((i) => i.email.startsWith("nope-"))).toBe(false);
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
  it("niente ruoli né cambi di ruolo né eliminazioni", async () => {
    expect(
      (
        await call(plain, "PATCH", `/api/users/${admin.id}/instance-role`, {
          roleId: await presetRoleId(app, "user"),
        })
      ).statusCode,
    ).toBe(403);
    expect((await call(plain, "DELETE", `/api/users/${admin.id}`)).statusCode).toBe(403);
    expect(
      (await call(plain, "DELETE", `/api/roles/${await presetRoleId(app, "viewer")}`)).statusCode,
    ).toBe(403);
  });
});
