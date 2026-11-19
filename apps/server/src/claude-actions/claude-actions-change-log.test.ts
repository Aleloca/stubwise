import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { changeLog, issueChatToolToken } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import type { ChangeEntry, ChangeLogFilters, ChangeLogPage } from "@stubwise/shared";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

/**
 * Area 9, F7, Task 5 (0195, M-5 = a): il registro sa che una voce l'ha
 * scritta Claude («By Claude», `via`) e quale voce annulla un «Annulla»
 * (`undoOf`, `undoneEntry`), DERIVATI a lettura coi permessi di chi guarda.
 * L'id dell'azione di Claude non esce.
 */
let t: TestDb;
let app: ReturnType<typeof buildApp>;
type U = Awaited<ReturnType<typeof createUserWithSession>>;
let lead: U;
let projectId: string;
let n = 0;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40), publicUrl: "https://stubwise.example" });
  await seedUsers(app);
  ({ projectId } = await seedRepository(t.db));
  lead = await createUserWithSession(app, "lead-a9cl@example.com");
  await addMember(app, projectId, lead.id, "project_lead");
}, 120_000);

afterAll(async () => {
  await app.close();
  await t.stop();
});

async function run(actions: unknown[]) {
  const c = await app.inject({ method: "POST", url: "/api/claude/conversations", headers: { cookie: lead.headers.cookie }, payload: {} });
  const sid = (c.json() as { id: string }).id;
  const tok = await issueChatToolToken(t.db, { sessionId: sid, userId: lead.id, ttlMs: 60_000 });
  const p = await app.inject({ method: "POST", url: `/api/claude/conversations/${sid}/proposals`, headers: { authorization: `Bearer ${tok}` }, payload: { toolUseId: `tu-a9cl-${++n}`, actions } });
  const done = await app.inject({ method: "POST", url: `/api/claude/proposals/${(p.json() as { proposalId: string }).proposalId}/confirm`, headers: { cookie: lead.headers.cookie }, payload: {} });
  return (done.json() as { groupId: string }).groupId;
}
const read = async (cookie: string, query = "") =>
  (await app.inject({ method: "GET", url: `/api/projects/${projectId}/change-log${query}`, headers: { cookie } })).json() as ChangeLogPage;

describe("area 9, F7: «By Claude» e «Undid…» nel registro", () => {
  it("una voce di Claude ha via claude, una a mano no; l'annulla porta la voce annullata", async () => {
    const before = await read(lead.headers.cookie);
    expect(before.entries.every((e) => e.via === null)).toBe(true);
    const groupId = await run([{ fn: "updateProjectGeneral", args: { projectId, name: "Da Claude" } }]);
    await app.inject({ method: "PATCH", url: `/api/projects/${projectId}`, headers: { cookie: lead.headers.cookie }, payload: { pulseEveryDays: 11 } });
    expect((await app.inject({ method: "POST", url: `/api/claude/groups/${groupId}/undo`, headers: { cookie: lead.headers.cookie } })).statusCode).toBe(200);
    const page = await read(lead.headers.cookie);
    const renames = page.entries.filter((e) => e.type === "project.renamed");
    const [undo, byClaude] = renames as [ChangeEntry, ChangeEntry];
    expect(byClaude).toMatchObject({ via: "claude", undoOf: null, undoneEntry: null });
    expect(undo).toMatchObject({ via: "claude", undoOf: byClaude.id, undoneEntry: { id: byClaude.id, via: "claude", undoOf: null } });
    expect(page.entries.find((e) => e.type === "project.pulse_interval_changed")).toMatchObject({ via: null, undoOf: null });
    // L'id dell'azione di Claude non esce.
    expect(JSON.stringify(page)).not.toMatch(/claudeActionId|viaClaudeActionId|undoOfActionId/);
    // Il filtro «By Claude» e la sua scelta fra i filtri.
    const onlyClaude = await read(lead.headers.cookie, "?via=claude");
    expect(onlyClaude.entries.length).toBeGreaterThanOrEqual(2);
    expect(onlyClaude.entries.every((e) => e.via === "claude")).toBe(true);
    const filters = (await app.inject({ method: "GET", url: `/api/change-log/filters?project=${projectId}`, headers: { cookie: lead.headers.cookie } })).json() as ChangeLogFilters;
    expect(filters.claude).toBe(true);
  });

  it("la voce annullata non arriva a chi non la legge: undoOf null, undoneEntry null", async () => {
    // La voce «annullata» sta in un progetto che chi guarda non vede.
    const { projectId: other } = await seedRepository(t.db);
    const action = randomUUID();
    const subjectId = randomUUID();
    await t.db.insert(changeLog).values({ actorEmail: "x@example.com", actorKind: "user", type: "project.renamed", projectId: other, subjectKind: "project", subjectId, data: { object: { type: "project", id: subjectId, label: "OTH" }, before: "a", after: "b" }, viaClaudeActionId: action });
    const [undo] = await t.db
      .insert(changeLog)
      .values({ actorEmail: "x@example.com", actorKind: "user", type: "project.renamed", projectId, subjectKind: "project", subjectId, data: { object: { type: "project", id: subjectId, label: "OTH" }, before: "b", after: "a" }, viaClaudeActionId: randomUUID(), undoOfActionId: action })
      .returning();
    const entry = (await read(lead.headers.cookie)).entries.find((e) => e.id === undo!.id);
    expect(entry).toMatchObject({ via: "claude", undoOf: null, undoneEntry: null });
  });

  it("un'azione che ha scritto su DUE oggetti: l'annulla di uno porta la voce di QUELLO, non la più recente", async () => {
    const action = randomUUID();
    const [s1, s2] = [randomUUID(), randomUUID()];
    const row = (subjectId: string, extra: Record<string, unknown>) => ({
      actorEmail: "x@example.com",
      actorKind: "user" as const,
      type: "project.renamed",
      projectId,
      subjectKind: "project",
      subjectId,
      data: { object: { type: "project", id: subjectId, label: "P" }, before: "a", after: "b" },
      ...extra,
    });
    const [onS2] = await t.db.insert(changeLog).values(row(s2, { viaClaudeActionId: action })).returning();
    await t.db.insert(changeLog).values(row(s1, { viaClaudeActionId: action, at: new Date(Date.now() + 1000) }));
    const [undo] = await t.db.insert(changeLog).values(row(s2, { viaClaudeActionId: randomUUID(), undoOfActionId: action, at: new Date(Date.now() + 2000) })).returning();
    const entry = (await read(lead.headers.cookie)).entries.find((e) => e.id === undo!.id);
    expect(entry).toMatchObject({ undoOf: onS2!.id, undoneEntry: { id: onS2!.id } });
  });

  it("«By Claude» fra i filtri solo se chi guarda ne legge almeno una", async () => {
    const outsider = await createUserWithSession(app, `out-a9cl-${++n}@example.com`);
    const { projectId: mine } = await seedRepository(t.db);
    await addMember(app, mine, outsider.id, "project_lead");
    const filters = (await app.inject({ method: "GET", url: `/api/change-log/filters?project=${mine}`, headers: { cookie: outsider.headers.cookie } })).json() as ChangeLogFilters;
    expect(filters.claude).toBe(false);
  });
});
