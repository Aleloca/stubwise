import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { changeLog, claudeProposals, issueChatToolToken, plugins, projectMemberPermissions, projectMembers, roles, users } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { createSession, SESSION_COOKIE } from "../auth/session.js";
import type { SessionUser } from "../auth/session.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";
import { actionLabels } from "./labels.js";

/**
 * Area 9, F7, Task 2: le prime C. Una C si conferma SOLO con la riconferma
 * di chi conferma (403 `reauth_required` altrimenti, e la proposta resta
 * aperta); una C non scelta («Conferma 2 di 3») non la chiede.
 */
let t: TestDb;
let app: ReturnType<typeof buildApp>;
let projectId: string;
type U = Awaited<ReturnType<typeof createUserWithSession>>;
let lead: U;
let n = 0;
let developerRole: string;
let leadRole: string;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40), publicUrl: "https://stubwise.example" });
  await seedUsers(app);
  ({ projectId } = await seedRepository(t.db));
  lead = await createUserWithSession(app, "lead-a9@example.com");
  await addMember(app, projectId, lead.id, "project_lead");
  developerRole = (await t.db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, "developer")))[0]!.id;
  leadRole = (await t.db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, "project_lead")))[0]!.id;
}, 120_000);

afterAll(async () => {
  await app.close();
  await t.stop();
});

async function conversation(cookie = lead.headers.cookie): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/claude/conversations", headers: { cookie }, payload: {} });
  return (res.json() as { id: string }).id;
}
const propose = async (actions: unknown[], who = lead) => {
  const sid = await conversation(who.headers.cookie);
  const tok = await issueChatToolToken(t.db, { sessionId: sid, userId: who.id, ttlMs: 60_000 });
  return app.inject({ method: "POST", url: `/api/claude/conversations/${sid}/proposals`, headers: { authorization: `Bearer ${tok}` }, payload: { toolUseId: `tu-a9-${++n}`, actions } });
};
const confirm = (id: string, cookie: string, body: Record<string, unknown> = {}) =>
  app.inject({ method: "POST", url: `/api/claude/proposals/${id}/confirm`, headers: { cookie }, payload: body });
/** La stessa persona, con una sessione il cui secondo fattore è di 11 minuti fa (fuori dalla finestra). */
async function stale(u: U): Promise<string> {
  const old = await createSession(t.db, u.id, { stage: "full", secondFactorAt: new Date(Date.now() - 11 * 60_000) });
  return `${SESSION_COOKIE}=${encodeURIComponent(app.signCookie(old.id))}`;
}
async function person() {
  const [u] = await t.db.insert(users).values({ email: `p-a9-${++n}@example.com`, passwordHash: "x", role: "member" }).returning({ id: users.id });
  return u!.id;
}
const roleOf = async (userId: string) => (await t.db.select({ roleId: projectMembers.roleId }).from(projectMembers).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId))))[0]?.roleId ?? null;

describe("area 9, F7: le C dei membri si confermano con la riconferma di chi conferma", () => {
  it("addMember: C (anche per azione); senza riconferma 403 e la proposta resta aperta; con la riconferma il membro c'è, con la voce del registro", async () => {
    const userId = await person();
    const res = await propose([{ fn: "addMember", args: { projectId, userId, roleId: developerRole } }]);
    expect(res.json()).toMatchObject({ status: "awaiting_confirmation" });
    const id = (res.json() as { proposalId: string }).proposalId;
    const noReauth = await confirm(id, await stale(lead));
    expect([noReauth.statusCode, (noReauth.json() as { code: string }).code]).toEqual([403, "reauth_required"]);
    expect((await t.db.select().from(claudeProposals).where(eq(claudeProposals.id, id)))[0]!.status).toBe("open");
    expect(await roleOf(userId)).toBeNull();
    const ok = await confirm(id, lead.headers.cookie);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: "confirmed", cls: "C", reauth: true, actions: [{ fn: "addMember", reauth: true }] });
    expect(await roleOf(userId)).toBe(developerRole);
    expect(await t.db.select().from(changeLog).where(and(eq(changeLog.type, "member.added"), eq(changeLog.subjectId, userId)))).toHaveLength(1);
  });

  it("«Conferma 2 di 3»: se la C non è scelta, la riconferma non si chiede; se è scelta, sì", async () => {
    const userId = await person();
    const tk = (await app.inject({ method: "POST", url: "/api/tasks", headers: { cookie: lead.headers.cookie }, payload: { projectId, title: `Task a9 ${++n}`, type: "bug" } })).json() as { id: string };
    const group = [
      { fn: "addMember", args: { projectId, userId, roleId: developerRole } },
      { fn: "addComment", args: { taskId: tk.id, body: "Un commento da Claude" } },
    ];
    const first = await propose(group);
    const firstId = (first.json() as { proposalId: string }).proposalId;
    // Solo la B (indice 1), con una sessione fuori finestra: passa, e il membro non entra.
    const onlyB = await confirm(firstId, await stale(lead), { selected: [1] });
    expect(onlyB.statusCode).toBe(200);
    expect(await roleOf(userId)).toBeNull();
    // La C scelta: la riconferma sì.
    const second = await propose(group);
    const withC = await confirm((second.json() as { proposalId: string }).proposalId, await stale(lead), { selected: [0, 1] });
    expect(withC.statusCode).toBe(403);
    expect(await roleOf(userId)).toBeNull();
  });

  it("setMemberRole e «Annulla»: l'inverso è C anche lui; una modifica a mano DOPO lo rifiuta (changed_after)", async () => {
    const userId = await person();
    await t.db.insert(projectMembers).values({ projectId, userId, roleId: developerRole });
    const res = await propose([{ fn: "setMemberRole", args: { projectId, userId, roleId: leadRole } }]);
    const id = (res.json() as { proposalId: string }).proposalId;
    const done = await confirm(id, lead.headers.cookie);
    expect(await roleOf(userId)).toBe(leadRole);
    const groupId = (done.json() as { groupId: string }).groupId;
    // L'annulla chiede conferma (una C), e la conferma la riconferma.
    const undo = await app.inject({ method: "POST", url: `/api/claude/groups/${groupId}/undo`, headers: { cookie: lead.headers.cookie } });
    expect(undo.json()).toMatchObject({ kind: "needs_confirmation", proposal: { reauth: true } });
    const undoId = (undo.json() as { proposal: { id: string } }).proposal.id;
    expect((await confirm(undoId, await stale(lead))).statusCode).toBe(403);
    expect(await roleOf(userId)).toBe(leadRole);
    expect((await confirm(undoId, lead.headers.cookie)).statusCode).toBe(200);
    expect(await roleOf(userId)).toBe(developerRole);

    // Di nuovo, ma con una modifica a mano dopo Claude: l'annulla non sovrascrive.
    const again = await propose([{ fn: "setMemberRole", args: { projectId, userId, roleId: leadRole } }]);
    const g2 = ((await confirm((again.json() as { proposalId: string }).proposalId, lead.headers.cookie)).json() as { groupId: string }).groupId;
    await new Promise((r) => setTimeout(r, 5));
    const manual = await app.inject({ method: "PUT", url: `/api/projects/${projectId}/members/${userId}`, headers: { cookie: lead.headers.cookie }, payload: { roleId: developerRole } });
    expect(manual.statusCode).toBe(200);
    const undo2 = await app.inject({ method: "POST", url: `/api/claude/groups/${g2}/undo`, headers: { cookie: lead.headers.cookie } });
    const body2 = undo2.json() as { kind?: string; proposal?: { id: string } };
    if (body2.kind === "needs_confirmation") {
      const r = await confirm(body2.proposal!.id, lead.headers.cookie);
      expect(r.statusCode).toBe(409);
    } else {
      expect(undo2.statusCode).toBe(409);
    }
    expect(await roleOf(userId)).toBe(developerRole);
  });

  it("removeMember con permessi personali: si toglie, ma «Annulla» non c'è (Claude non ridà i permessi personali)", async () => {
    const userId = await person();
    await t.db.insert(projectMembers).values({ projectId, userId, roleId: developerRole });
    await t.db.insert(projectMemberPermissions).values({ projectId, userId, permission: "release.merge", grantedByUserId: lead.id });
    const res = await propose([{ fn: "removeMember", args: { projectId, userId } }]);
    const done = await confirm((res.json() as { proposalId: string }).proposalId, lead.headers.cookie);
    expect(done.statusCode).toBe(200);
    expect(await roleOf(userId)).toBeNull();
    const groupId = (done.json() as { groupId: string }).groupId;
    const undo = await app.inject({ method: "POST", url: `/api/claude/groups/${groupId}/undo`, headers: { cookie: lead.headers.cookie } });
    expect(undo.statusCode).toBe(409);
  });

  it("NEGATIVI: chi non gestisce i membri non può proporre addMember; Claude non diventa membro", async () => {
    const dev = await createUserWithSession(app, `dev-a9-${++n}@example.com`);
    await addMember(app, projectId, dev.id, "developer");
    const refused = await propose([{ fn: "addMember", args: { projectId, userId: await person(), roleId: developerRole } }], dev);
    expect(refused.json()).toMatchObject({ status: "refused" });
    const [agent] = await t.db.select({ id: users.id }).from(users).where(eq(users.isAgent, true));
    const agentTry = await propose([{ fn: "addMember", args: { projectId, userId: agent!.id, roleId: developerRole } }]);
    expect(agentTry.json()).toMatchObject({ status: "refused" });
  });
});

describe("area 9, F7: i nomi della scheda dei membri, a lettura coi permessi di chi guarda", () => {
  it("chi vede il progetto legge persona e ruolo (removeMember: il ruolo di adesso); chi non lo vede null; le altre voci null", async () => {
    const userId = await person();
    const email = (await t.db.select({ email: users.email }).from(users).where(eq(users.id, userId)))[0]!.email;
    const [dev] = await t.db.select({ name: roles.name }).from(roles).where(eq(roles.id, developerRole));
    const actions = [
      { fn: "addMember" as const, args: { projectId, userId, roleId: developerRole } },
      { fn: "removeMember" as const, args: { projectId, userId: lead.id } },
      { fn: "pauseQueue" as const, args: { projectId } },
    ];
    const [leadRow] = await t.db.select({ name: roles.name }).from(roles).where(eq(roles.id, leadRole));
    const asLead = await actionLabels(t.db, { id: lead.id, instancePermissions: new Set() } as unknown as SessionUser, actions);
    expect(asLead).toEqual([
      { person: email.split("@")[0], role: dev!.name },
      { person: "lead-a9", role: leadRow!.name },
      { person: null, role: null },
    ]);
    const outsider = await createUserWithSession(app, `out-a9-${++n}@example.com`);
    const asOutsider = await actionLabels(t.db, { id: outsider.id, instancePermissions: new Set() } as unknown as SessionUser, actions);
    expect(asOutsider).toEqual([{ person: null, role: null }, { person: null, role: null }, { person: null, role: null }]);
  });

  it("la proposta porta le etichette per azione", async () => {
    const userId = await person();
    const res = await propose([{ fn: "addMember", args: { projectId, userId, roleId: developerRole } }]);
    const id = (res.json() as { proposalId: string }).proposalId;
    const cancel = await app.inject({ method: "POST", url: `/api/claude/proposals/${id}/cancel`, headers: { cookie: lead.headers.cookie }, payload: {} });
    expect(cancel.json()).toMatchObject({ actions: [{ fn: "addMember", labels: { person: expect.any(String), role: expect.any(String) } }] });
  });
});

describe("area 9, F7: i plugin (M-6 = a)", () => {
  it("registerPlugin senza `trust: true` non è proponibile; con, è C e si registra con la riconferma; non si annulla", async () => {
    const admin = await createUserWithSession(app, `adm-a9-${++n}@example.com`);
    const [adminRole] = await t.db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, "admin"));
    await t.db.update(users).set({ instanceRoleId: adminRole!.id }).where(eq(users.id, admin.id));
    const args = { sourceUrl: "https://github.com/acme/strumenti", ref: "v1" };
    const without = await propose([{ fn: "registerPlugin", args }], admin);
    expect(without.json()).toMatchObject({ status: "refused" });
    const res = await propose([{ fn: "registerPlugin", args: { ...args, trust: true } }], admin);
    const id = (res.json() as { proposalId: string }).proposalId;
    expect((await confirm(id, await stale(admin))).statusCode).toBe(403);
    expect(await t.db.select().from(plugins).where(eq(plugins.sourceUrl, args.sourceUrl))).toEqual([]);
    const ok = await confirm(id, admin.headers.cookie);
    expect(ok.statusCode).toBe(200);
    expect(await t.db.select().from(plugins).where(eq(plugins.sourceUrl, args.sourceUrl))).toHaveLength(1);
    const groupId = (ok.json() as { groupId: string }).groupId;
    expect((await app.inject({ method: "POST", url: `/api/claude/groups/${groupId}/undo`, headers: { cookie: admin.headers.cookie } })).statusCode).toBe(409);
  });
});
