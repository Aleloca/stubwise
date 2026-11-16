import { randomUUID } from "node:crypto";
import { projectMemberPermissions, roles, users, type Db } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { effectiveInstancePermissions, projectMemberSchema, type ProjectPermission } from "@stubwise/shared";
import { projectPermissionsOfUser, userIdsWithPermission } from "@stubwise/notifications";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildApp } from "../app.js";
import { projectIdsWithPermission, projectPermissionsFor } from "../auth/access.js";
import { addMember, createUserWithSession, presetRoleId, seedUsers } from "../test/fixtures.js";

/**
 * Area 9, F1, Task 3: i permessi PERSONALI di un membro, oltre al ruolo
 * (docs/invariants/permissions.md, «I permessi effettivi in un progetto sono
 * UNA funzione»). Valgono esattamente come quelli del ruolo, in ogni lettura;
 * si danno solo se chi dà li ha (`escalation`); togliere non chiede niente.
 */

let testDb: TestDb;
let db: Db;
let app: FastifyInstance;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  app = buildApp({ db, sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!", encryptionKey: Buffer.alloc(32, 3).toString("base64") });
  await seedUsers(app);
}, 120_000);
afterAll(async () => {
  await app.close();
  await testDb.stop();
});

type U = { id: string; headers: { cookie: string } };
const person = async (): Promise<U> => createUserWithSession(app, `m-${randomUUID().slice(0, 8)}@acme.com`);
const put = (as: U, projectId: string, userId: string, body: Record<string, unknown>) =>
  app.inject({ method: "PUT", url: `/api/projects/${projectId}/members/${userId}`, headers: as.headers, payload: body });
const members = async (as: U, projectId: string) => {
  const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}/members`, headers: as.headers });
  expect(res.statusCode).toBe(200);
  return z.array(projectMemberSchema).parse(res.json());
};
const permsOf = async (u: U, projectId: string) => {
  const res = await app.inject({ method: "GET", url: "/api/auth/me", headers: u.headers });
  return ((res.json() as { projectPermissions: Record<string, string[]> }).projectPermissions[projectId] ?? []).sort();
};

async function scene() {
  const { projectId } = await seedRepository(db);
  const lead = await person();
  await addMember(app, projectId, lead.id, "project_lead");
  const dev = await person();
  await addMember(app, projectId, dev.id, "developer");
  return { projectId, lead, dev, developer: await presetRoleId(app, "developer"), contributor: await presetRoleId(app, "contributor") };
}

describe("i permessi personali", () => {
  it("un permesso personale APRE la sua rotta e compare in /me; toglierlo la richiude subito", async () => {
    const s = await scene();
    const other = await person();
    // Senza: il developer non gestisce i membri.
    expect((await put(s.dev, s.projectId, other.id, { roleId: s.contributor })).statusCode).toBe(403);
    const granted = await put(s.lead, s.projectId, s.dev.id, { roleId: s.developer, permissions: ["project.members.manage"] });
    expect(granted.statusCode).toBe(200);
    expect(await permsOf(s.dev, s.projectId)).toContain("project.members.manage");
    expect((await put(s.dev, s.projectId, other.id, { roleId: s.contributor })).statusCode).toBe(200);
    // Toglierlo.
    expect((await put(s.lead, s.projectId, s.dev.id, { roleId: s.developer, permissions: [] })).statusCode).toBe(200);
    expect(await permsOf(s.dev, s.projectId)).not.toContain("project.members.manage");
    expect((await put(s.dev, s.projectId, other.id, { roleId: s.contributor })).statusCode).toBe(403);
  });

  it("un corpo SENZA `permissions` lascia i personali com'erano (additivo)", async () => {
    const s = await scene();
    await put(s.lead, s.projectId, s.dev.id, { roleId: s.developer, permissions: ["release.merge"] });
    await put(s.lead, s.projectId, s.dev.id, { roleId: s.contributor });
    expect(await permsOf(s.dev, s.projectId)).toContain("release.merge");
  });

  it("la provenienza di ogni permesso: dal ruolo, o dato da chi e quando", async () => {
    const s = await scene();
    await put(s.lead, s.projectId, s.dev.id, { roleId: s.developer, permissions: ["release.merge"] });
    const row = (await members(s.lead, s.projectId)).find((m) => m.userId === s.dev.id)!;
    const merge = row.permissions.find((p) => p.permission === "release.merge")!;
    expect(merge.sources).toEqual([expect.objectContaining({ kind: "grant", byUserId: s.lead.id, at: expect.any(String) })]);
    const view = row.permissions.find((p) => p.permission === "tickets.view_all")!;
    expect(view.sources).toEqual([expect.objectContaining({ kind: "role", roleId: s.developer })]);
    // Un permesso che arriva da tutte e due le parti le dice entrambe.
    await put(s.lead, s.projectId, s.dev.id, { roleId: s.developer, permissions: ["release.merge", "tickets.view_all"] });
    const both = (await members(s.lead, s.projectId)).find((m) => m.userId === s.dev.id)!.permissions.find((p) => p.permission === "tickets.view_all")!;
    expect(both.sources.map((x) => x.kind).sort()).toEqual(["grant", "role"]);
  });

  it("NEGATIVI: dare un permesso che non si ha è `escalation` (niente scritto); un permesso d'istanza è 422", async () => {
    const s = await scene();
    await put(s.lead, s.projectId, s.dev.id, { roleId: s.developer, permissions: ["project.members.manage"] });
    const other = await person();
    await addMember(app, s.projectId, other.id, "contributor");
    // Il developer gestisce i membri, ma non ha release.merge.
    const esc = await put(s.dev, s.projectId, other.id, { roleId: s.contributor, permissions: ["release.merge"] });
    expect(esc.statusCode).toBe(403);
    expect(esc.json()).toMatchObject({ code: "escalation", permission: "release.merge" });
    expect(await db.select().from(projectMemberPermissions).where(eq(projectMemberPermissions.userId, other.id))).toEqual([]);
    const inst = await put(s.lead, s.projectId, s.dev.id, { roleId: s.developer, permissions: ["users.manage"] });
    expect(inst.statusCode).toBe(422);
  });

  it("l'ultimo gestore dei membri (fuori dai full admin) non si toglie, né col ruolo né col permesso personale", async () => {
    const { projectId } = await seedRepository(db);
    const lead = await person();
    await addMember(app, projectId, lead.id, "project_lead");
    const dev = await person();
    await addMember(app, projectId, dev.id, "developer");
    const developer = await presetRoleId(app, "developer");
    const demote = await put(lead, projectId, lead.id, { roleId: developer });
    expect(demote.statusCode).toBe(409);
    expect(demote.json()).toMatchObject({ code: "last_manager" });
    const remove = await app.inject({ method: "DELETE", url: `/api/projects/${projectId}/members/${lead.id}`, headers: lead.headers });
    expect(remove.statusCode).toBe(409);
    // Con un secondo gestore (per permesso personale), il primo si declassa.
    await put(lead, projectId, dev.id, { roleId: developer, permissions: ["project.members.manage"] });
    expect((await put(lead, projectId, lead.id, { roleId: developer })).statusCode).toBe(200);
    // E ora il permesso personale del secondo è l'ultimo: non si toglie.
    const last = await put(dev, projectId, dev.id, { roleId: developer, permissions: [] });
    expect(last.statusCode).toBe(409);
    expect(last.json()).toMatchObject({ code: "last_manager" });
  });

  it("ACCORDO: i permessi effettivi di ogni membro sono gli stessi in /me, nel servizio, nel filtro degli elenchi e nella vista dei membri", async () => {
    const s = await scene();
    await put(s.lead, s.projectId, s.dev.id, { roleId: s.developer, permissions: ["release.merge", "plans.approve"] });
    for (const u of [s.lead, s.dev]) {
      const fromMe = await permsOf(u, s.projectId);
      const [row] = await db.select({ permissions: roles.permissions }).from(users).innerJoin(roles, eq(roles.id, users.instanceRoleId)).where(eq(users.id, u.id));
      const user = { id: u.id, instancePermissions: effectiveInstancePermissions(row!.permissions) };
      const fromService = [...((await projectPermissionsFor(db, user, s.projectId)) ?? [])].sort();
      const fromNotifications = [...((await projectPermissionsOfUser(db, u.id, s.projectId)) ?? [])].sort();
      const fromView = (await members(s.lead, s.projectId)).find((m) => m.userId === u.id)!.permissions.map((p) => p.permission).sort();
      expect(fromService).toEqual(fromMe);
      expect(fromNotifications).toEqual(fromMe);
      expect(fromView).toEqual(fromMe);
      for (const p of ["release.merge", "plans.approve"] as ProjectPermission[]) {
        const ids = await projectIdsWithPermission(db, user, p);
        expect(ids === "all" || ids.includes(s.projectId)).toBe(fromMe.includes(p));
        // Chi riceve un avviso legato a quel permesso.
        expect((await userIdsWithPermission(db, p, s.projectId)).includes(u.id)).toBe(fromMe.includes(p));
      }
    }
  });

  it("togliere il membro toglie i suoi permessi personali", async () => {
    const s = await scene();
    await put(s.lead, s.projectId, s.dev.id, { roleId: s.developer, permissions: ["release.merge"] });
    await app.inject({ method: "DELETE", url: `/api/projects/${s.projectId}/members/${s.dev.id}`, headers: s.lead.headers });
    expect(await db.select().from(projectMemberPermissions).where(and(eq(projectMemberPermissions.projectId, s.projectId), eq(projectMemberPermissions.userId, s.dev.id)))).toEqual([]);
  });
});
