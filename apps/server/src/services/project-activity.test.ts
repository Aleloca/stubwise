import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { aiJobs, backlogItems, projectDecisions, projects, releases, ticketEvents, tickets, widgetConversations, widgetMessages } from "@stubwise/db";
import { seedRepository, seedTicket, startTestDb, type TestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";
import { archiveCandidates, lastActivityByProject } from "./project-activity.js";

/**
 * Area 10, F4 (S4): l'ultima attività di un progetto (`lastActivityOf` del
 * prototipo) e i progetti da archiviare per chi chiede.
 */
let t: TestDb;
let app: ReturnType<typeof buildApp>;
type U = Awaited<ReturnType<typeof createUserWithSession>>;
let lead: U;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40) });
  await seedUsers(app);
  lead = await createUserWithSession(app, "lead-activity@example.com");
}, 120_000);

afterAll(async () => {
  await app.close();
  await t.stop();
});

const daysAgo = (n: number) => sql`now() - make_interval(days => ${n}::int)`;
/** Un progetto con UNA task creata 200 giorni fa (fermo, salvo le sorgenti del caso). */
async function quietProject(): Promise<{ projectId: string; ticketId: string; repositoryId: string }> {
  const seeded = await seedTicket(t.db);
  await t.db.update(tickets).set({ createdAt: daysAgo(200), updatedAt: daysAgo(200) }).where(eq(tickets.id, seeded.ticketId));
  await t.db.delete(ticketEvents).where(eq(ticketEvents.ticketId, seeded.ticketId));
  return seeded;
}
const lastOf = async (projectId: string) => (await lastActivityByProject(t.db, [projectId])).get(projectId) ?? null;
const recent = (d: Date | null) => d !== null && Date.now() - d.getTime() < 86_400_000;

describe("l'ultima attività di un progetto", () => {
  it("un progetto senza niente vale null; una task di 200 giorni fa è la sua data", async () => {
    const { projectId: empty } = await seedRepository(t.db);
    expect(await lastOf(empty)).toBeNull();
    const { projectId } = await quietProject();
    const at = await lastOf(projectId);
    expect(at).not.toBeNull();
    expect(recent(at)).toBe(false);
  });

  it("ogni sorgente da sola la sposta a oggi: un evento della task, una richiesta, una decisione, un messaggio del supporto, un rilascio", async () => {
    const event = await quietProject();
    await t.db.insert(ticketEvents).values({ ticketId: event.ticketId, kind: "status_changed", payload: {} });
    expect(recent(await lastOf(event.projectId))).toBe(true);

    const request = await quietProject();
    await t.db.insert(backlogItems).values({ projectId: request.projectId, title: "Una richiesta", originContent: "o", source: "manual" });
    expect(recent(await lastOf(request.projectId))).toBe(true);

    const decision = await quietProject();
    await t.db.insert(projectDecisions).values({ projectId: decision.projectId, source: "manual", sourceKey: `k-${Date.now()}`, title: "Deciso", decision: "Sì" } as never);
    expect(recent(await lastOf(decision.projectId))).toBe(true);

    const support = await quietProject();
    const [c] = await t.db.insert(widgetConversations).values({ projectId: support.projectId, externalUserId: "v" }).returning();
    await t.db.insert(widgetMessages).values({ conversationId: c!.id, role: "user", content: "Ciao" });
    expect(recent(await lastOf(support.projectId))).toBe(true);

    const release = await quietProject();
    await t.db.insert(releases).values({ code: `R${Date.now()}-V1`, seq: 1, projectId: release.projectId, repositoryId: release.repositoryId, prNumber: 1, prUrl: "u", title: "x", mergeSha: "f".repeat(40), mergedAt: new Date(), viaStubwise: true });
    expect(recent(await lastOf(release.projectId))).toBe(true);
  });
});

describe("GET /api/projects/archive-candidates", () => {
  it("i fermi da più di n giorni: candidati, occupati e non gestibili; un progetto invisibile non compare da nessuna parte; uno attivo neanche", async () => {
    const candidate = await quietProject();
    const busy = await quietProject();
    const notMine = await quietProject();
    const hidden = await quietProject();
    const active = await seedTicket(t.db);
    await addMember(app, candidate.projectId, lead.id, "project_lead");
    await addMember(app, busy.projectId, lead.id, "project_lead");
    await addMember(app, notMine.projectId, lead.id, "developer");
    await addMember(app, active.projectId, lead.id, "project_lead");
    await t.db.insert(aiJobs).values({ ticketId: busy.ticketId, status: "fixing" });
    const code = async (id: string) => (await t.db.select({ code: projects.code }).from(projects).where(eq(projects.id, id)))[0]!.code;
    const res = await app.inject({ method: "GET", url: "/api/projects/archive-candidates?inactiveDays=90", headers: { cookie: lead.headers.cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { candidates: { projectId: string; code: string }[]; busy: { code: string; reasons: { kind: string }[] }[]; notManageable: number; notManageableCodes: string[] };
    expect(body.candidates.map((c) => c.projectId)).toEqual([candidate.projectId]);
    expect(body.busy).toEqual([{ code: await code(busy.projectId), reasons: [expect.objectContaining({ kind: "claude_session" })] }]);
    expect(body).toMatchObject({ notManageable: 1, notManageableCodes: [await code(notMine.projectId)] });
    expect(JSON.stringify(body)).not.toContain(hidden.projectId);
    expect(JSON.stringify(body)).not.toContain(await code(hidden.projectId));
    expect(JSON.stringify(body)).not.toContain(active.projectId);
  });
});

describe("review di F3–F8 (M7): un tetto ai progetti esaminati", () => {
  it("si esaminano i più fermi fino al tetto; gli altri si contano in `more`", async () => {
    const who = await createUserWithSession(app, "lead-cap@example.com");
    const a = await quietProject();
    const b = await quietProject();
    for (const p of [a, b]) await addMember(app, p.projectId, who.id, "project_lead");
    const viewer = { id: who.id, email: "lead-cap@example.com", role: "member" as const, instancePermissions: new Set<string>() };
    const all = await archiveCandidates(t.db, viewer as never, 90);
    expect(all.more).toBe(0);
    const listed = (r: typeof all) => r.candidates.length + r.busy.length + r.notManageable;
    expect(listed(all)).toBe(2);
    const capped = await archiveCandidates(t.db, viewer as never, 90, 1);
    expect(listed(capped)).toBe(1);
    expect(capped.more).toBe(1);
  });
});
