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
