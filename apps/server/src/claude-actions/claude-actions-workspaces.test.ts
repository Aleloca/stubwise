import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { changeLog, issueChatToolToken, roles, users, workspaceMembers, workspaceProjects, workspaces } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

/**
 * Workspace, lotto 3 (D14): Claude propone di far entrare una persona in una
 * workspace e di metterci un progetto; sono C (le rotte chiedono la
 * riconferma), e «Annulla» le disfa coi servizi di sempre. Una modifica a mano
 * DOPO Claude rifiuta l'annulla (changed_after).
 */
let t: TestDb;
let app: ReturnType<typeof buildApp>;
let projectId: string;
type U = Awaited<ReturnType<typeof createUserWithSession>>;
let lea: U;
let n = 0;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40), publicUrl: "https://stubwise.example" });
  await seedUsers(app);
  ({ projectId } = await seedRepository(t.db));
  lea = await createUserWithSession(app, "lea-ws@example.com");
  await addMember(app, projectId, lea.id, "project_lead");
  const [manager] = await t.db.insert(roles).values({ name: "Workspace manager", scope: "instance", permissions: ["users.view_all", "workspaces.manage"] }).returning();
  await t.db.update(users).set({ instanceRoleId: manager!.id }).where(eq(users.id, lea.id));
}, 120_000);

afterAll(async () => {
  await app.close();
  await t.stop();
});

async function conversation(): Promise<string> {
  return ((await app.inject({ method: "POST", url: "/api/claude/conversations", headers: { cookie: lea.headers.cookie }, payload: {} })).json() as { id: string }).id;
}
const propose = async (actions: unknown[]) => {
  const sid = await conversation();
  const tok = await issueChatToolToken(t.db, { sessionId: sid, userId: lea.id, ttlMs: 60_000 });
  return app.inject({ method: "POST", url: `/api/claude/conversations/${sid}/proposals`, headers: { authorization: `Bearer ${tok}` }, payload: { toolUseId: `tu-ws-${++n}`, actions } });
};
const confirm = (id: string) => app.inject({ method: "POST", url: `/api/claude/proposals/${id}/confirm`, headers: { cookie: lea.headers.cookie }, payload: {} });
const undo = async (groupId: string) => {
  const res = await app.inject({ method: "POST", url: `/api/claude/groups/${groupId}/undo`, headers: { cookie: lea.headers.cookie } });
  const body = res.json() as { kind?: string; proposal?: { id: string } };
  return body.kind === "needs_confirmation" ? confirm(body.proposal!.id) : res;
};
async function person() {
  const [u] = await t.db.insert(users).values({ email: `p-ws-${++n}@example.com`, passwordHash: "x", role: "member" }).returning({ id: users.id });
  return u!.id;
}
async function workspace(projectIds: string[] = []) {
  const [w] = await t.db.insert(workspaces).values({ name: `Clienti ${++n}`, colorToken: "--dept-1" }).returning();
  for (const id of projectIds) {
    // D2: un progetto sta in una workspace sola, e i test lo riusano.
    await t.db.delete(workspaceProjects).where(eq(workspaceProjects.projectId, id));
    await t.db.insert(workspaceProjects).values({ workspaceId: w!.id, projectId: id });
  }
  return w!.id;
}
const inWorkspace = async (workspaceId: string, userId: string) =>
  (await t.db.select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))).length > 0;
const workspaceOf = async (id: string) => (await t.db.select({ w: workspaceProjects.workspaceId }).from(workspaceProjects).where(eq(workspaceProjects.projectId, id)))[0]?.w ?? null;

describe("D14: le azioni di Claude sulle workspace", () => {
  it("addWorkspaceMember: C; confermata la persona entra, con la voce del registro; «Annulla» la toglie", async () => {
    const w = await workspace([projectId]);
    const userId = await person();
    const res = await propose([{ fn: "addWorkspaceMember", args: { workspaceId: w, userId } }]);
    expect(res.json()).toMatchObject({ status: "awaiting_confirmation" });
    const done = await confirm((res.json() as { proposalId: string }).proposalId);
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toMatchObject({ status: "confirmed", cls: "C" });
    expect(await inWorkspace(w, userId)).toBe(true);
    expect(await t.db.select().from(changeLog).where(and(eq(changeLog.type, "workspace.member_added"), eq(changeLog.subjectId, userId)))).toHaveLength(1);
    const undone = await undo((done.json() as { groupId: string }).groupId);
    expect(undone.statusCode, undone.body).toBe(200);
    expect(await inWorkspace(w, userId)).toBe(false);
  });

  it("una modifica a mano DOPO Claude (il ruolo cambiato) rifiuta l'annulla, e la persona resta", async () => {
    const w = await workspace([projectId]);
    const userId = await person();
    const res = await propose([{ fn: "addWorkspaceMember", args: { workspaceId: w, userId } }]);
    const groupId = ((await confirm((res.json() as { proposalId: string }).proposalId)).json() as { groupId: string }).groupId;
    await new Promise((r) => setTimeout(r, 5));
    const developer = (await t.db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, "developer")))[0]!.id;
    expect((await app.inject({ method: "PUT", url: `/api/workspaces/${w}/members/${userId}`, headers: { cookie: lea.headers.cookie }, payload: { roleId: developer } })).statusCode).toBe(200);
    expect((await undo(groupId)).statusCode).toBe(409);
    expect(await inWorkspace(w, userId)).toBe(true);
  });

  it("addWorkspaceProject: lo sposta nella workspace; «Annulla» lo rimette dov'era (o lo toglie)", async () => {
    const from = await workspace([projectId]);
    const to = await workspace();
    const res = await propose([{ fn: "addWorkspaceProject", args: { workspaceId: to, projectId } }]);
    const done = await confirm((res.json() as { proposalId: string }).proposalId);
    expect(done.statusCode, done.body).toBe(200);
    expect(await workspaceOf(projectId)).toBe(to);
    const undone = await undo((done.json() as { groupId: string }).groupId);
    expect(undone.statusCode, undone.body).toBe(200);
    expect(await workspaceOf(projectId)).toBe(from);
    // Fuori da ogni workspace: l'annulla lo toglie.
    await t.db.delete(workspaceProjects).where(eq(workspaceProjects.projectId, projectId));
    const again = await confirm(((await propose([{ fn: "addWorkspaceProject", args: { workspaceId: to, projectId } }])).json() as { proposalId: string }).proposalId);
    expect(await workspaceOf(projectId)).toBe(to);
    await undo((again.json() as { groupId: string }).groupId);
    expect(await workspaceOf(projectId)).toBeNull();
  });

  it("le remove esistono solo come inversi: non sono fra le firme che Claude vede (come deleteTask)", async () => {
    const { claudeActionSignatures } = await import("@stubwise/shared");
    const signatures = claudeActionSignatures(new Set(["workspaces.manage"]));
    expect(signatures).toContain("addWorkspaceMember(");
    expect(signatures).toContain("addWorkspaceProject(");
    expect(signatures).not.toContain("removeWorkspaceMember(");
    expect(signatures).not.toContain("removeWorkspaceProject(");
    // Senza workspaces.manage, mettere un progetto non compare.
    expect(claudeActionSignatures(new Set())).not.toContain("addWorkspaceProject(");
  });
});
