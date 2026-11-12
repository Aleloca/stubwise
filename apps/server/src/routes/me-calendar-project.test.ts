import { randomUUID } from "node:crypto";
import { calendarEvents, googleAccounts, googleWorkspaces, notifications, projects, type Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession } from "../test/fixtures.js";

/**
 * IL PROGETTO DELL'EVENTO, A MANO (area 6, F4, task 4): `PUT
 * /api/me/calendar/events/:id/project`. Nessuna chiamata a Google: il
 * progetto è di Stubwise. La regola del prototipo: lo fa chi vede l'evento,
 * se è membro del progetto scelto; un progetto attuale che non vede non lo
 * cambia. Vale per TUTTE le righe dello stesso evento (iCalUID, Q1 = a).
 */

let testDb: TestDb;
let db: Db;
let app: FastifyInstance;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  app = buildApp({ db, sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!", encryptionKey: Buffer.alloc(32, 3).toString("base64") });
}, 120_000);
afterEach(async () => {
  await db.delete(calendarEvents);
  await db.delete(googleAccounts);
  await db.delete(googleWorkspaces);
});
afterAll(async () => {
  await app.close();
  await testDb.stop();
});

async function person() {
  const user = await createUserWithSession(app, `p-${randomUUID()}@acme.com`);
  const [ws] = await db.insert(googleWorkspaces).values({ name: "A", domains: ["acme.com"], clientId: "c", clientSecretEncrypted: "x" }).returning();
  const [box] = await db.insert(googleAccounts).values({ userId: user.id, workspaceId: ws!.id, email: `box-${randomUUID().slice(0, 6)}@acme.com`, googleSub: randomUUID(), refreshTokenEncrypted: "x" }).returning();
  return { user, accountId: box!.id };
}

async function project() {
  const [p] = await db.insert(projects).values({ name: `P-${randomUUID().slice(0, 4)}`, slug: `p-${randomUUID()}`, ingestionKey: randomUUID() }).returning();
  return p!.id;
}

async function row(accountId: string, over: Partial<typeof calendarEvents.$inferInsert> = {}) {
  const [r] = await db
    .insert(calendarEvents)
    .values({ accountId, googleEventId: `g-${randomUUID()}`, title: "Revisione", startsAt: new Date(Date.now() + 3 * 86_400_000), status: "confirmed", fingerprint: "x", proposalCandidate: false, icalUid: "uid-1@google.com", ...over })
    .returning();
  return r!;
}

async function openCard(userId: string, projectId: string) {
  const [card] = await db
    .insert(notifications)
    .values({ userId, kind: "google.proposal", projectId, status: "open", event: { kind: "google.proposal", source: "calendar", projectId, actions: [{ type: "create_milestone", projectId, title: "x" }, { type: "ignore" }] } as never })
    .returning();
  return card!;
}

const put = (cookie: { cookie: string }, id: string, projectId: string | null) =>
  app.inject({ method: "PUT", url: `/api/me/calendar/events/${id}/project`, headers: cookie, payload: { projectId } });

describe("PUT /events/:id/project", () => {
  it("un membro mette il progetto: projectBy manual, e la riga di un altro invitato (stesso iCalUID) prende lo stesso", async () => {
    const ada = await person();
    const bruno = await person();
    const p = await project();
    await addMember(app, p, ada.user.id);
    const mine = await row(ada.accountId);
    const his = await row(bruno.accountId);
    const elsewhere = await row(bruno.accountId, { icalUid: "altro@google.com" });
    const res = await put(ada.user.headers, mine.id, p);
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0]).toMatchObject({ id: mine.id, projectId: p, projectBy: "manual" });
    const [hisNow] = await db.select().from(calendarEvents).where(eq(calendarEvents.id, his.id));
    expect(hisNow).toMatchObject({ projectId: p, projectBy: "manual" });
    const [untouched] = await db.select().from(calendarEvents).where(eq(calendarEvents.id, elsewhere.id));
    expect(untouched!.projectId).toBeNull();
  });

  it("un progetto di cui non sono membro: 404, e niente cambia", async () => {
    const ada = await person();
    const p = await project();
    const mine = await row(ada.accountId);
    expect((await put(ada.user.headers, mine.id, p)).statusCode).toBe(404);
    const [now] = await db.select().from(calendarEvents).where(eq(calendarEvents.id, mine.id));
    expect(now!.projectId).toBeNull();
  });

  it("il progetto ATTUALE è uno che non vedo: 403, anche per toglierlo", async () => {
    const ada = await person();
    const hidden = await project();
    const p = await project();
    await addMember(app, p, ada.user.id);
    const mine = await row(ada.accountId, { projectId: hidden, projectBy: "rules" });
    const res = await put(ada.user.headers, mine.id, p);
    expect([res.statusCode, res.json().code]).toEqual([403, "project_hidden"]);
    expect((await put(ada.user.headers, mine.id, null)).statusCode).toBe(403);
    const [now] = await db.select().from(calendarEvents).where(eq(calendarEvents.id, mine.id));
    expect(now!.projectId).toBe(hidden);
  });

  it("l'evento di un altro: 404", async () => {
    const ada = await person();
    const bruno = await person();
    const his = await row(bruno.accountId);
    expect((await put(ada.user.headers, his.id, null)).statusCode).toBe(404);
  });

  it("la proposta APERTA della scadenza segue il progetto; quella di una data di serie no", async () => {
    const ada = await person();
    const from = await project();
    const to = await project();
    await addMember(app, from, ada.user.id);
    await addMember(app, to, ada.user.id);
    const deadlineCard = await openCard(ada.user.id, from);
    const deadline = await row(ada.accountId, { projectId: from, projectBy: "rules", proposalCandidate: true, proposalNotificationId: deadlineCard.id, icalUid: "d@google.com" });
    const seriesCard = await openCard(ada.user.id, from);
    const seriesDate = await row(ada.accountId, { projectId: from, projectBy: "rules", proposalCandidate: true, proposalNotificationId: seriesCard.id, recurringEventId: "s", icalUid: "s@google.com" });
    expect((await put(ada.user.headers, deadline.id, to)).statusCode).toBe(200);
    expect((await put(ada.user.headers, seriesDate.id, to)).statusCode).toBe(200);
    const [d] = await db.select().from(notifications).where(eq(notifications.id, deadlineCard.id));
    expect(d!.projectId).toBe(to);
    expect(d!.event).toMatchObject({ projectId: to, actions: [{ type: "create_milestone", projectId: to }, { type: "ignore" }] });
    const [s] = await db.select().from(notifications).where(eq(notifications.id, seriesCard.id));
    expect(s!.projectId).toBe(from);
    expect(s!.event).toMatchObject({ projectId: from });
  });
});
