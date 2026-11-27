import { randomUUID } from "node:crypto";
import { projects, users, workspaceMembers, workspaceProjects, workspaces, type Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import {
  projectPermissionsOfUser,
  projectViewerIds,
  projectViewerIdsByProject,
  userIdsWithPermission,
} from "@stubwise/notifications";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { visiblePersonIds } from "../services/people-visibility.js";
import { createUserWithSession, presetRoleId, seedUsers } from "../test/fixtures.js";
import { projectIdsWithPermission, projectPermissionsFor, projectPermissionsMap, visibleProjectIds } from "./access.js";

/**
 * Workspace, lotto 1 (`docs/plans/2026-11-27-workspace-piano.md`): le funzioni
 * centrali della visibilità leggono `project_access`. Ogni prova è a DUE
 * utenti sugli stessi dati: Wanda, persona della workspace (Viewer), e Nino,
 * che non ne fa parte. Senza righe di workspace nulla cambia (le suite di
 * prima restano verdi senza toccarle).
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

const userOf = (id: string) => ({ id, instancePermissions: new Set<never>() });

async function seed() {
  const [p] = await db.insert(projects).values({ name: "Farmacia", slug: `far-${randomUUID().slice(0, 6)}`, ingestionKey: randomUUID() }).returning();
  const [archived] = await db
    .insert(projects)
    .values({ name: "Vecchio", slug: `old-${randomUUID().slice(0, 6)}`, ingestionKey: randomUUID(), archivedAt: new Date() })
    .returning();
  const wanda = await createUserWithSession(app, `wanda-${randomUUID()}@x.test`);
  const nino = await createUserWithSession(app, `nino-${randomUUID()}@x.test`);
  const [w] = await db.insert(workspaces).values({ name: "Clienti", colorToken: "--dept-1" }).returning();
  await db.insert(workspaceProjects).values([
    { workspaceId: w!.id, projectId: p!.id },
    { workspaceId: w!.id, projectId: archived!.id },
  ]);
  await db.insert(workspaceMembers).values({ workspaceId: w!.id, userId: wanda.id, roleId: await presetRoleId(app, "viewer") });
  return { project: p!, archived: archived!, wanda, nino, workspaceId: w!.id };
}

describe("le funzioni centrali leggono anche la workspace", () => {
  it("visibleProjectIds: Wanda vede il progetto della workspace (non l'archiviato), Nino no", async () => {
    const { project, archived, wanda, nino } = await seed();
    const seen = (await visibleProjectIds(db, userOf(wanda.id))) as string[];
    expect(seen).toContain(project.id);
    expect(seen).not.toContain(archived.id);
    expect(await visibleProjectIds(db, userOf(nino.id))).not.toContain(project.id);
  });

  it("projectPermissionsFor: Wanda ha i permessi del Viewer, Nino null; l'archiviato solo leggendolo di proposito", async () => {
    const { project, archived, wanda, nino } = await seed();
    const perms = await projectPermissionsFor(db, userOf(wanda.id), project.id);
    expect(perms?.has("tickets.view_all")).toBe(true);
    expect(perms?.has("tickets.create")).toBe(false);
    expect(await projectPermissionsFor(db, userOf(nino.id), project.id)).toBeNull();
    expect(await projectPermissionsFor(db, userOf(wanda.id), archived.id)).toBeNull();
    expect((await projectPermissionsFor(db, userOf(wanda.id), archived.id, { includeArchived: true }))?.has("docs.view")).toBe(true);
  });

  it("una rotta del progetto: 200 a Wanda, 404 a Nino", async () => {
    const { project, wanda, nino } = await seed();
    expect((await app.inject({ method: "GET", url: `/api/projects/${project.id}`, headers: wanda.headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/projects/${project.id}`, headers: nino.headers })).statusCode).toBe(404);
  });

  it("/api/auth/me e projectPermissionsMap portano il progetto della workspace solo a Wanda", async () => {
    const { project, wanda, nino } = await seed();
    expect((await projectPermissionsMap(db, userOf(wanda.id)))[project.id]).toContain("docs.view");
    expect((await projectPermissionsMap(db, userOf(nino.id)))[project.id]).toBeUndefined();
    const me = (await app.inject({ method: "GET", url: "/api/auth/me", headers: wanda.headers })).json() as { projectPermissions: Record<string, string[]> };
    expect(me.projectPermissions[project.id]).toContain("tickets.view_all");
  });

  it("projectIdsWithPermission e userIdsWithPermission: Wanda ha tickets.view_all, non tickets.create", async () => {
    const { project, wanda, nino } = await seed();
    expect(await projectIdsWithPermission(db, userOf(wanda.id), "tickets.view_all")).toContain(project.id);
    expect(await projectIdsWithPermission(db, userOf(wanda.id), "tickets.create")).not.toContain(project.id);
    expect(await projectIdsWithPermission(db, userOf(nino.id), "tickets.view_all")).not.toContain(project.id);
    const viewAll = await userIdsWithPermission(db, "tickets.view_all", project.id);
    expect(viewAll).toContain(wanda.id);
    expect(viewAll).not.toContain(nino.id);
    expect(await userIdsWithPermission(db, "tickets.create", project.id)).not.toContain(wanda.id);
  });

  it("projectPermissionsOfUser (il worker e l'inbox): Wanda sì, Nino null", async () => {
    const { project, wanda, nino } = await seed();
    expect((await projectPermissionsOfUser(db, wanda.id, project.id))?.has("docs.view")).toBe(true);
    expect(await projectPermissionsOfUser(db, nino.id, project.id)).toBeNull();
  });

  it("projectViewerIds e projectViewerIdsByProject contano Wanda, non Nino né Claude messo in una workspace", async () => {
    const { project, wanda, nino, workspaceId } = await seed();
    const [claude] = await db.select({ id: users.id }).from(users).where(eq(users.isAgent, true));
    await db.insert(workspaceMembers).values({ workspaceId, userId: claude!.id, roleId: await presetRoleId(app, "viewer") });
    const viewers = await projectViewerIds(db, project.id);
    expect(viewers).toContain(wanda.id);
    expect(viewers).not.toContain(nino.id);
    expect(viewers).not.toContain(claude!.id);
    expect((await projectViewerIdsByProject(db, [project.id])).get(project.id)).toEqual(viewers);
  });

  it("visiblePersonIds: Nino, membro esplicito dello stesso progetto, vede Wanda; prima no", async () => {
    const { project, wanda, nino } = await seed();
    expect(await visiblePersonIds(db, userOf(nino.id))).not.toContain(wanda.id);
    const { addMember } = await import("../test/fixtures.js");
    await addMember(app, project.id, nino.id, "viewer");
    expect(await visiblePersonIds(db, userOf(nino.id))).toContain(wanda.id);
    expect(await visiblePersonIds(db, userOf(wanda.id))).toContain(nino.id);
  });

  it("revoca a lettura: tolta Wanda dalla workspace, sparisce ovunque", async () => {
    const { project, wanda, workspaceId } = await seed();
    await db.delete(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId));
    expect(await visibleProjectIds(db, userOf(wanda.id))).not.toContain(project.id);
    expect(await projectViewerIds(db, project.id)).not.toContain(wanda.id);
    expect((await app.inject({ method: "GET", url: `/api/projects/${project.id}`, headers: wanda.headers })).statusCode).toBe(404);
  });
});

describe("un ruolo usato da una workspace", () => {
  it("non si elimina: 409 role_in_use con il conteggio, come per i membri", async () => {
    const { roles } = await import("@stubwise/db");
    const { deleteRole, RoleRuleError } = await import("../services/roles.js");
    const { actorAs } = await import("../test/fixtures.js");
    const [custom] = await db.insert(roles).values({ name: `Ospite ${randomUUID().slice(0, 6)}`, scope: "project", permissions: ["docs.view"] }).returning();
    const [w] = await db.insert(workspaces).values({ name: "Ospiti", colorToken: "--dept-4" }).returning();
    const guest = await createUserWithSession(app, `ospite-${randomUUID()}@x.test`);
    await db.insert(workspaceMembers).values({ workspaceId: w!.id, userId: guest.id, roleId: custom!.id });
    const [admin] = await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.role, "admin")).limit(1);
    const error = await deleteRole(db, { ...actorAs(admin!.id, "admin"), email: admin!.email }, custom!.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RoleRuleError);
    expect(error).toMatchObject({ status: 409, code: "role_in_use", extra: { count: 1 } });
  });
});
