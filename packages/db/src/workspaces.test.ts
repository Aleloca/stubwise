import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectAccessPermissionsSql, projectAccessSql } from "./member-permissions.js";
import {
  departmentMembers,
  departmentProjectPermissions,
  departments,
  projectAccess,
  projectMemberPermissions,
  projectMembers,
  projects,
  roles,
  users,
  workspaceMembers,
  workspaceProjects,
  workspaces,
} from "./schema.js";
import { startTestDb, type TestDb } from "./testing.js";

/**
 * Workspace, lotto 1 (`docs/plans/2026-11-27-workspace-piano.md`): la vista
 * `project_access` e la regola dei permessi come UNIONE delle fonti, sul
 * Postgres vero. Le funzioni centrali che la usano si provano nel server.
 */

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t.stop();
});

async function role(key: "viewer" | "developer" | "contributor" | "admin") {
  const name = { viewer: "Viewer", developer: "Developer", contributor: "Contributor", admin: "Admin" }[key];
  const [row] = await t.db.select().from(roles).where(eq(roles.name, name));
  return row!;
}
async function person() {
  const [u] = await t.db.insert(users).values({ email: `p-${randomUUID()}@x.test`, passwordHash: "x", role: "member" }).returning();
  return u!.id;
}
/** L'utente di sistema «Claude», uno solo (`users_single_agent`), seminato dalle migrazioni. */
async function claudeUser() {
  const [u] = await t.db.select({ id: users.id }).from(users).where(eq(users.isAgent, true));
  return u!.id;
}
async function project() {
  const [p] = await t.db.insert(projects).values({ name: `P ${randomUUID().slice(0, 6)}`, slug: `p-${randomUUID()}`, ingestionKey: randomUUID() }).returning();
  return p!.id;
}
async function workspace(projectIds: string[]) {
  const [w] = await t.db.insert(workspaces).values({ name: "Clienti", colorToken: "--dept-1" }).returning();
  for (const projectId of projectIds) await t.db.insert(workspaceProjects).values({ workspaceId: w!.id, projectId });
  return w!.id;
}
async function permissionsOf(projectId: string, userId: string) {
  const [row] = await t.db.execute<{ p: string[] | null; a: boolean }>(
    sql`select ${projectAccessPermissionsSql(sql`${projectId}::uuid`, sql`${userId}::uuid`)} as p, ${projectAccessSql(sql`${projectId}::uuid`, sql`${userId}::uuid`)} as a`,
  );
  return { permissions: row!.p === null ? null : new Set(row!.p), access: row!.a };
}

describe("la vista project_access", () => {
  it("una riga per fonte: membro esplicito e workspace, due righe se è tutte e due", async () => {
    const [p, other] = [await project(), await project()];
    const ada = await person();
    const w = await workspace([p]);
    await t.db.insert(workspaceMembers).values({ workspaceId: w, userId: ada, roleId: (await role("viewer")).id });
    expect(await t.db.select().from(projectAccess).where(eq(projectAccess.userId, ada))).toEqual([
      { projectId: p, userId: ada, roleId: (await role("viewer")).id, source: "workspace", workspaceId: w },
    ]);
    await t.db.insert(projectMembers).values({ projectId: p, userId: ada, roleId: (await role("developer")).id });
    const rows = await t.db.select({ source: projectAccess.source }).from(projectAccess).where(and(eq(projectAccess.userId, ada), eq(projectAccess.projectId, p)));
    expect(rows.map((r) => r.source).sort()).toEqual(["member", "workspace"]);
    // Un progetto fuori dalla workspace non c'è.
    expect(await t.db.select().from(projectAccess).where(and(eq(projectAccess.userId, ada), eq(projectAccess.projectId, other)))).toEqual([]);
  });

  it("D2: un progetto non sta in due workspace", async () => {
    const p = await project();
    await workspace([p]);
    await expect(workspace([p])).rejects.toThrow();
  });

  it("il ruolo di workspace è un ruolo di PROGETTO: un ruolo d'istanza si rifiuta", async () => {
    const w = await workspace([]);
    await expect(t.db.insert(workspaceMembers).values({ workspaceId: w, userId: await person(), roleId: (await role("admin")).id })).rejects.toThrow();
  });

  it("un ruolo usato da una workspace non si elimina", async () => {
    const [custom] = await t.db.insert(roles).values({ name: `R ${randomUUID().slice(0, 6)}`, scope: "project", permissions: ["docs.view"] }).returning();
    const w = await workspace([]);
    await t.db.insert(workspaceMembers).values({ workspaceId: w, userId: await person(), roleId: custom!.id });
    await expect(t.db.delete(roles).where(eq(roles.id, custom!.id))).rejects.toThrow();
  });
});

describe("i permessi: l'UNIONE delle fonti", () => {
  it("Viewer di workspace ∪ Developer esplicito ∪ un permesso di reparto", async () => {
    const p = await project();
    const ada = await person();
    const w = await workspace([p]);
    await t.db.insert(workspaceMembers).values({ workspaceId: w, userId: ada, roleId: (await role("viewer")).id });
    const viewerOnly = await permissionsOf(p, ada);
    expect(viewerOnly.access).toBe(true);
    expect(viewerOnly.permissions!.has("tickets.view_all")).toBe(true);
    expect(viewerOnly.permissions!.has("tickets.create")).toBe(false);
    // D10: il reparto vale anche dove si è membri per workspace.
    const [d] = await t.db.insert(departments).values({ name: `D ${randomUUID().slice(0, 6)}`, colorToken: "--dept-2" }).returning();
    await t.db.insert(departmentMembers).values({ departmentId: d!.id, userId: ada });
    await t.db.insert(departmentProjectPermissions).values({ departmentId: d!.id, permission: "servers.operate" });
    expect((await permissionsOf(p, ada)).permissions!.has("servers.operate")).toBe(true);
    await t.db.insert(projectMembers).values({ projectId: p, userId: ada, roleId: (await role("developer")).id });
    const all = (await permissionsOf(p, ada)).permissions!;
    expect(all.has("tickets.create")).toBe(true);
    expect(all.has("tickets.view_all")).toBe(true);
    expect(all.has("servers.operate")).toBe(true);
  });

  it("D1: un override più basso non toglie niente", async () => {
    const p = await project();
    const ada = await person();
    const w = await workspace([p]);
    await t.db.insert(workspaceMembers).values({ workspaceId: w, userId: ada, roleId: (await role("developer")).id });
    const before = (await permissionsOf(p, ada)).permissions!;
    await t.db.insert(projectMembers).values({ projectId: p, userId: ada, roleId: (await role("viewer")).id });
    const after = (await permissionsOf(p, ada)).permissions!;
    for (const permission of before) expect(after.has(permission)).toBe(true);
  });

  it("i permessi personali valgono solo con la riga del membro esplicito", async () => {
    const p = await project();
    const ada = await person();
    await t.db.insert(projectMembers).values({ projectId: p, userId: ada, roleId: (await role("viewer")).id });
    await t.db.insert(projectMemberPermissions).values({ projectId: p, userId: ada, permission: "servers.operate" });
    expect((await permissionsOf(p, ada)).permissions!.has("servers.operate")).toBe(true);
  });

  it("un reparto non rende membri, e senza righe il risultato è null", async () => {
    const p = await project();
    const ada = await person();
    const [d] = await t.db.insert(departments).values({ name: `D ${randomUUID().slice(0, 6)}`, colorToken: "--dept-3" }).returning();
    await t.db.insert(departmentMembers).values({ departmentId: d!.id, userId: ada });
    await t.db.insert(departmentProjectPermissions).values({ departmentId: d!.id, permission: "docs.view" });
    expect(await permissionsOf(p, ada)).toEqual({ permissions: null, access: false });
  });

  it("un utente di sistema in una workspace non riceve niente, né accesso né permessi", async () => {
    const p = await project();
    const claude = await claudeUser();
    const w = await workspace([p]);
    await t.db.insert(workspaceMembers).values({ workspaceId: w, userId: claude, roleId: (await role("developer")).id });
    expect(await permissionsOf(p, claude)).toEqual({ permissions: null, access: false });
  });

  it("Claude membro esplicito E in una workspace: vale solo il ruolo esplicito", async () => {
    const p = await project();
    const claude = await claudeUser();
    await t.db.insert(projectMembers).values({ projectId: p, userId: claude, roleId: (await role("viewer")).id });
    const w = await workspace([p]);
    await t.db.insert(workspaceMembers).values({ workspaceId: w, userId: claude, roleId: (await role("developer")).id });
    const perms = (await permissionsOf(p, claude)).permissions!;
    expect(perms.has("tickets.view_all")).toBe(true);
    expect(perms.has("tickets.create")).toBe(false);
  });

  it("revoca a lettura: tolta la riga di workspace, l'accesso sparisce", async () => {
    const p = await project();
    const ada = await person();
    const w = await workspace([p]);
    await t.db.insert(workspaceMembers).values({ workspaceId: w, userId: ada, roleId: (await role("viewer")).id });
    expect((await permissionsOf(p, ada)).access).toBe(true);
    await t.db.delete(workspaceProjects).where(eq(workspaceProjects.projectId, p));
    expect(await permissionsOf(p, ada)).toEqual({ permissions: null, access: false });
  });
});
