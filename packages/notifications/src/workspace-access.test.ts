import {
  googleAccounts,
  googleWorkspaces,
  notifications,
  projects,
  roles,
  users,
  workspaceMembers,
  workspaceProjects,
  workspaces,
  type Db,
} from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { alertTypeOf } from "@stubwise/shared";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadPlanWorld } from "./automation-world.js";
import { DRIVE_READONLY_SCOPE, folderLinkExpiredSql } from "./drive-folder-link.js";
import { catalogPermissionVisible, notificationVisibleToRecipient } from "./inbox-visibility.js";

/**
 * Workspace, lotto 2, gruppo 1 (`docs/plans/2026-11-27-workspace-piano.md`):
 * le regole condivise fra server e worker che decidevano con
 * `project_members` da sola ora leggono `project_access`. A due utenti sugli
 * stessi dati: Wanda, persona della workspace, e Nino, che non ne fa parte.
 */

let testDb: TestDb;
let db: Db;
beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
}, 120_000);
afterAll(async () => {
  await testDb?.stop();
});

async function roleId(presetKey: string) {
  const [r] = await db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, presetKey));
  return r!.id;
}
async function person(name: string) {
  const [u] = await db.insert(users).values({ email: `${name}-${randomUUID()}@example.com`, passwordHash: "x", role: "member", displayName: name }).returning();
  return u!.id;
}
async function seed(presetKey = "viewer") {
  const [p] = await db.insert(projects).values({ name: "Farmacia", slug: `far-${randomUUID().slice(0, 6)}`, ingestionKey: randomUUID() }).returning();
  const wanda = await person("Wanda");
  const nino = await person("Nino");
  const [w] = await db.insert(workspaces).values({ name: "Clienti", colorToken: "--dept-1" }).returning();
  await db.insert(workspaceProjects).values({ workspaceId: w!.id, projectId: p!.id });
  await db.insert(workspaceMembers).values({ workspaceId: w!.id, userId: wanda, roleId: await roleId(presetKey) });
  return { projectId: p!.id, wanda, nino, workspaceId: w!.id };
}

describe("notificationVisibleToRecipient", () => {
  it("la card di un progetto della workspace la vede Wanda, non Nino; tolta la workspace, nemmeno lei", async () => {
    const { projectId, wanda, nino, workspaceId } = await seed();
    const event = { kind: "ticket.created", title: "x" };
    await db.insert(notifications).values([
      { userId: wanda, projectId, kind: "ticket.created", event, status: "open" },
      { userId: nino, projectId, kind: "ticket.created", event, status: "open" },
    ]);
    const visible = async () =>
      (await db.select({ userId: notifications.userId }).from(notifications).where(and(eq(notifications.projectId, projectId), notificationVisibleToRecipient()))).map((r) => r.userId);
    expect(await visible()).toEqual([wanda]);
    await db.delete(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId));
    expect(await visible()).toEqual([]);
  });
});

describe("catalogPermissionVisible", () => {
  it("una card che vuole repos.view: la vede il Viewer di workspace, non il Contributor di workspace", async () => {
    const viewer = await seed("viewer");
    const contributor = await seed("contributor");
    const event = { kind: "pr.analysis_issues" };
    await db.insert(notifications).values([
      { userId: viewer.wanda, projectId: viewer.projectId, kind: "pr.analysis_issues", event, status: "open" },
      { userId: contributor.wanda, projectId: contributor.projectId, kind: "pr.analysis_issues", event, status: "open" },
    ]);
    const clause = catalogPermissionVisible([alertTypeOf("pr.analysis_issues")!]);
    const seen = (await db.select({ userId: notifications.userId }).from(notifications).where(and(eq(notifications.kind, "pr.analysis_issues"), clause))).map((r) => r.userId);
    expect(seen).toContain(viewer.wanda);
    expect(seen).not.toContain(contributor.wanda);
  });
});

describe("folderLinkExpiredSql", () => {
  it("un collegamento di Drive resta vivo finché chi l'ha fatto ha drive.manage, anche per via di workspace", async () => {
    const lead = await seed("project_lead");
    const viewer = await seed("viewer");
    const [ws] = await db.insert(googleWorkspaces).values({ name: "A", domains: ["example.com"], clientId: "c", clientSecretEncrypted: "s" }).returning();
    const account = async (userId: string) =>
      (
        await db
          .insert(googleAccounts)
          .values({ userId, workspaceId: ws!.id, email: `box-${randomUUID()}@example.com`, googleSub: randomUUID(), refreshTokenEncrypted: "r", scopes: [DRIVE_READONLY_SCOPE] })
          .returning()
      )[0]!.id;
    const expired = async (accountId: string, linkedBy: string, projectId: string) => {
      const [row] = await db.execute<{ e: boolean }>(
        sql`select ${folderLinkExpiredSql({ accountId: sql`${accountId}::uuid`, linkedBy: sql`${linkedBy}::uuid`, projectId: sql`${projectId}::uuid` })} as e`,
      );
      return row!.e;
    };
    expect(await expired(await account(lead.wanda), lead.wanda, lead.projectId)).toBe(false);
    expect(await expired(await account(viewer.wanda), viewer.wanda, viewer.projectId)).toBe(true);
  });
});

describe("loadPlanWorld", () => {
  it("vede il progetto chi è nella workspace, e il ruolo di workspace conta fra chi ha un ruolo", async () => {
    const { projectId, wanda, nino } = await seed("project_lead");
    const world = await loadPlanWorld(db, { ownerId: wanda, projectIds: [projectId], personIds: [nino] });
    expect(world.canSeeProject(wanda, projectId)).toBe(true);
    expect(world.canSeeProject(nino, projectId)).toBe(false);
    expect(world.holdersOfRole(projectId, "project_lead")).toEqual([wanda]);
  });

  it("chi è sia membro esplicito sia di workspace ha ENTRAMBI i ruoli", async () => {
    const { projectId, wanda } = await seed("viewer");
    const { projectMembers } = await import("@stubwise/db");
    await db.insert(projectMembers).values({ projectId, userId: wanda, roleId: await roleId("developer") });
    const world = await loadPlanWorld(db, { ownerId: wanda, projectIds: [projectId] });
    expect(world.holdersOfRole(projectId, "viewer")).toEqual([wanda]);
    expect(world.holdersOfRole(projectId, "developer")).toEqual([wanda]);
  });
});
