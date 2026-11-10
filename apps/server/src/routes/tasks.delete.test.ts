import { randomBytes } from "node:crypto";
import {
  agentRuns,
  aiJobs,
  attachments,
  backlogItemTickets,
  comments,
  deletedTickets,
  notifications,
  prCorrections,
  projectDecisions,
  ticketEvents,
  ticketFollowers,
  ticketLinks,
  ticketRepositories,
  tickets,
} from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedBacklogItem, seedRepository, startTestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

/**
 * «Elimina task» (chat con Claude, fetta 3.0): un'eliminazione VERA. Chi può
 * lo decide il server (l'autore con `tickets.edit`, o `tickets.moderate`);
 * una task occupata (lavoro di Claude, PR aperta, correzione aperta) no; ciò
 * che la nomina resta e lo dice; una task eliminata non riappare in nessuna
 * lettura; il codice non si riusa.
 */

let testDb: TestDb;
let app: FastifyInstance;
let projectId: string;
let repositoryId: string;
type U = { id: string; headers: { cookie: string } };
let legacy: U;
let legacyOther: U;
let contributor: U;
let developer: U;
let outsider: U;
let u: Awaited<ReturnType<typeof seedUsers>>;
let n = 0;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({ db: testDb.db, sessionSecret: "x".repeat(40), encryptionKey: randomBytes(32).toString("base64") });
  u = await seedUsers(app);
  ({ projectId, repositoryId } = await seedRepository(testDb.db));
  legacy = await createUserWithSession(app, "legacy-d@example.com");
  legacyOther = await createUserWithSession(app, "legacy2-d@example.com");
  contributor = await createUserWithSession(app, "contrib-d@example.com");
  developer = await createUserWithSession(app, "dev-d@example.com");
  outsider = await createUserWithSession(app, "out-d@example.com");
  await addMember(app, projectId, legacy.id, "legacy_member");
  await addMember(app, projectId, legacyOther.id, "legacy_member");
  await addMember(app, projectId, contributor.id, "contributor");
  await addMember(app, projectId, developer.id, "developer");
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

async function task(author: string | null, extra: Partial<typeof tickets.$inferInsert> = {}) {
  n += 1;
  const [t] = await testDb.db
    .insert(tickets)
    .values({
      projectId,
      number: 7000 + n,
      title: `Da eliminare ${n}`,
      type: "bug",
      priority: "medium",
      source: "manual",
      requestedByUserId: author,
      ...extra,
    })
    .returning({ id: tickets.id, number: tickets.number });
  return { id: t!.id, number: t!.number, code: `${await projectCode()}-${t!.number}` };
}

let codeCache: string | null = null;
async function projectCode(): Promise<string> {
  if (codeCache) return codeCache;
  const res = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie: u.adminCookie } });
  codeCache = (res.json() as { id: string; code: string }[]).find((p) => p.id === projectId)!.code;
  return codeCache;
}

const del = (id: string, cookie: string) => app.inject({ method: "DELETE", url: `/api/tasks/${id}`, headers: { cookie } });
const preview = (id: string, cookie: string) =>
  app.inject({ method: "GET", url: `/api/tasks/${id}/deletion`, headers: { cookie } });
const exists = async (id: string) => (await testDb.db.select().from(tickets).where(eq(tickets.id, id))).length > 0;

describe("chi può eliminare una task (lo decide il server)", () => {
  it("l'autore con tickets.edit sì; un altro senza tickets.moderate no (deleteTasks)", async () => {
    const t = await task(legacy.id);
    const p = (await preview(t.id, legacyOther.headers.cookie)).json();
    expect(p).toMatchObject({ canDelete: false, whoAction: "deleteTasks", code: t.code });
    const refused = await del(t.id, legacyOther.headers.cookie);
    expect(refused.statusCode).toBe(403);
    expect(await exists(t.id)).toBe(true);
    expect((await preview(t.id, legacy.headers.cookie)).json()).toMatchObject({ canDelete: true, whoAction: null });
    expect((await del(t.id, legacy.headers.cookie)).statusCode).toBe(204);
    expect(await exists(t.id)).toBe(false);
  });

  it("l'autore SENZA tickets.edit no (editTasks); chi ha tickets.moderate sì, anche se non è sua; il full admin sì", async () => {
    const own = await task(contributor.id);
    expect((await preview(own.id, contributor.headers.cookie)).json()).toMatchObject({ canDelete: false, whoAction: "editTasks" });
    expect((await del(own.id, contributor.headers.cookie)).statusCode).toBe(403);
    expect(await exists(own.id)).toBe(true);
    expect((await del(own.id, developer.headers.cookie)).statusCode).toBe(204);
    const other = await task(legacy.id);
    expect((await del(other.id, u.adminCookie)).statusCode).toBe(204);
  });

  it("invisibile = inesistente: 404 per chi non vede il progetto, anche nell'anteprima", async () => {
    const t = await task(legacy.id);
    expect((await preview(t.id, outsider.headers.cookie)).statusCode).toBe(404);
    expect((await del(t.id, outsider.headers.cookie)).statusCode).toBe(404);
    expect(await exists(t.id)).toBe(true);
  });
});

describe("una task occupata non si elimina (busy)", () => {
  it.each(["queued", "fixing", "held", "awaiting_plan_approval", "awaiting_input"] as const)(
    "lavoro di Claude %s: 409 busy claude_session, niente cambia",
    async (status) => {
      const t = await task(legacy.id);
      await testDb.db.insert(aiJobs).values({ ticketId: t.id, status });
      const res = await del(t.id, legacy.headers.cookie);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "busy", reasons: [{ kind: "claude_session", code: t.code }] });
      expect(await exists(t.id)).toBe(true);
    },
  );

  it("una PR aperta e una correzione aperta: busy; un job concluso non la occupa", async () => {
    const pr = await task(legacy.id);
    await testDb.db.insert(ticketRepositories).values({
      ticketId: pr.id,
      repositoryId,
      branch: "stubwise/ticket-pr",
      prState: "open",
      prNumber: 42,
      prUrl: "https://github.com/acme/audin-web/pull/42",
    } as typeof ticketRepositories.$inferInsert);
    const res = await del(pr.id, legacy.headers.cookie);
    expect(res.statusCode).toBe(409);
    expect(res.json().reasons).toEqual([{ kind: "open_pr", repo: "audin-web", number: 42 }]);
    expect((await preview(pr.id, legacy.headers.cookie)).json().busy).toEqual([{ kind: "open_pr", repo: "audin-web", number: 42 }]);

    const corr = await task(legacy.id);
    await testDb.db.insert(prCorrections).values({
      ticketId: corr.id,
      repositoryId,
      prNumber: 7,
      status: "pending",
      trigger: "stubwise",
    } as typeof prCorrections.$inferInsert);
    expect((await del(corr.id, legacy.headers.cookie)).json().reasons).toEqual([{ kind: "open_correction" }]);

    const done = await task(legacy.id);
    await testDb.db.insert(aiJobs).values({ ticketId: done.id, status: "skipped" });
    expect((await del(done.id, legacy.headers.cookie)).statusCode).toBe(204);
  });
});

describe("cosa se ne va, cosa resta", () => {
  it("le figlie restano senza madre; i collegamenti spariscono da entrambe le parti; commenti e storia se ne vanno", async () => {
    const parent = await task(legacy.id);
    const child = await task(legacy.id);
    const other = await task(legacy.id);
    await testDb.db.insert(ticketLinks).values([
      { sourceTicketId: parent.id, targetTicketId: child.id, kind: "parent" },
      { sourceTicketId: other.id, targetTicketId: parent.id, kind: "blocks" },
    ] as (typeof ticketLinks.$inferInsert)[]);
    await testDb.db.insert(comments).values({ ticketId: parent.id, authorType: "user", authorId: legacy.id, body: "ciao" } as typeof comments.$inferInsert);
    await testDb.db.insert(ticketEvents).values({ ticketId: parent.id, actorId: legacy.id, kind: "title_changed", payload: {} } as typeof ticketEvents.$inferInsert);
    expect((await preview(parent.id, legacy.headers.cookie)).json().children).toEqual([
      { code: child.code, title: `Da eliminare ${child.number - 7000}` },
    ]);
    expect((await del(parent.id, legacy.headers.cookie)).statusCode).toBe(204);
    expect(await exists(child.id)).toBe(true);
    expect(await exists(other.id)).toBe(true);
    expect(await testDb.db.select().from(ticketLinks).where(eq(ticketLinks.sourceTicketId, other.id))).toEqual([]);
    expect(await testDb.db.select().from(ticketLinks).where(eq(ticketLinks.targetTicketId, child.id))).toEqual([]);
    expect(await testDb.db.select().from(comments).where(eq(comments.ticketId, parent.id))).toEqual([]);
    expect(await testDb.db.select().from(ticketEvents).where(eq(ticketEvents.ticketId, parent.id))).toEqual([]);
  });

  it("la lapide: codice, titolo, chi, richiesta d'origine — niente descrizione; il numero non si riusa", async () => {
    const { itemId } = await seedBacklogItem(testDb.db, { projectId });
    const t = await task(legacy.id, { body: "descrizione segreta" });
    await testDb.db.insert(backlogItemTickets).values({ itemId, ticketId: t.id });
    expect((await del(t.id, legacy.headers.cookie)).statusCode).toBe(204);
    const [stone] = await testDb.db.select().from(deletedTickets).where(eq(deletedTickets.id, t.id));
    expect(stone).toMatchObject({ projectId, number: t.number, deletedBy: legacy.id, originBacklogItemId: itemId });
    expect(JSON.stringify(stone)).not.toContain("descrizione segreta");
    // La richiesta d'origine dice che la task è stata eliminata.
    const request = (await app.inject({ method: "GET", url: `/api/requests/${itemId}`, headers: { cookie: u.adminCookie } })).json();
    expect(request.deletedTaskCodes).toEqual([t.code]);
    expect(request.taskIds).not.toContain(t.id);
    // Una task nuova non riprende il numero (il contatore del progetto non scende).
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { cookie: u.adminCookie },
      payload: { projectId, title: "Nuova dopo l'eliminazione", type: "bug" },
    });
    expect(created.statusCode).toBeLessThan(300);
    expect((created.json() as { code: string }).code).not.toBe(t.code);
  });

  it("non riappare in nessuna lettura: per codice, nell'elenco, nei ticket del web vecchio", async () => {
    const t = await task(legacy.id);
    expect((await del(t.id, legacy.headers.cookie)).statusCode).toBe(204);
    const cookie = u.adminCookie;
    expect((await app.inject({ method: "GET", url: `/api/tasks/by-code/${t.code}`, headers: { cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/tasks/${t.id}`, headers: { cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/tickets/${t.id}`, headers: { cookie } })).statusCode).toBe(404);
    const list = (await app.inject({ method: "GET", url: `/api/tasks?projectIds=${projectId}`, headers: { cookie } })).json() as {
      items: { id: string }[];
    };
    expect(list.items.map((i) => i.id)).not.toContain(t.id);
  });

  it("i follower ricevono «task eliminata»; le notifiche restano senza link, con objectGone; consumi e registro decisioni restano", async () => {
    const t = await task(legacy.id);
    await testDb.db.insert(ticketFollowers).values({ ticketId: t.id, userId: legacyOther.id } as typeof ticketFollowers.$inferInsert);
    const [job] = await testDb.db.insert(aiJobs).values({ ticketId: t.id, status: "skipped" }).returning({ id: aiJobs.id });
    await testDb.db.insert(agentRuns).values({
      jobId: job!.id,
      phase: "fix",
      operation: "fix_execute",
      model: "claude-sonnet-5-5",
      costUsd: "1.5",
    } as typeof agentRuns.$inferInsert);
    const [decision] = await testDb.db
      .insert(projectDecisions)
      .values({ projectId, ticketId: t.id, title: "Scelta", decision: "CSV", source: "manual", sourceKey: `t:${t.id}` } as typeof projectDecisions.$inferInsert)
      .returning({ id: projectDecisions.id });
    await testDb.db.insert(attachments).values({
      ticketId: t.id,
      uploaderId: legacy.id,
      filename: "a.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
      storageKey: `k/${t.id}`,
    } as typeof attachments.$inferInsert);
    expect((await del(t.id, legacy.headers.cookie)).statusCode).toBe(204);

    const cards = await testDb.db.select().from(notifications).where(eq(notifications.userId, legacyOther.id));
    const deleted = cards.find((c) => (c.event as { change?: string }).change === "task_deleted");
    expect(deleted).toBeDefined();
    expect(deleted!.ticketId).toBeNull();
    const inbox = (await app.inject({ method: "GET", url: "/api/inbox", headers: { cookie: legacyOther.headers.cookie } })).json() as {
      items: { id: string; objectGone: boolean; url?: string; ticketId: string | null }[];
    };
    const card = inbox.items.find((i) => i.id === deleted!.id)!;
    expect(card).toMatchObject({ objectGone: true, ticketId: null });
    expect(card.url).toBeUndefined();

    const runs = await testDb.db.select().from(agentRuns).where(eq(agentRuns.costUsd, "1.5"));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.jobId).toBeNull();
    const [kept] = await testDb.db.select().from(projectDecisions).where(eq(projectDecisions.id, decision!.id));
    expect(kept).toMatchObject({ ticketId: null, decision: "CSV" });
    expect(await testDb.db.select().from(attachments).where(eq(attachments.ticketId, t.id))).toEqual([]);
  });

  it("lo standup del giorno elenca la task eliminata, a chi l'ha eliminata", async () => {
    const t = await task(legacy.id);
    expect((await del(t.id, legacy.headers.cookie)).statusCode).toBe(204);
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Rome" });
    const res = await app.inject({ method: "GET", url: `/api/people/activity?date=${today}`, headers: { cookie: u.adminCookie } });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as { personId: string | null; tasksDeleted: { code: string }[] }[];
    expect(rows.find((r) => r.personId === legacy.id)?.tasksDeleted.map((d) => d.code)).toContain(t.code);
  });
});
