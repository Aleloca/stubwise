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
