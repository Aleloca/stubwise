import { randomUUID } from "node:crypto";
import {
  calendarEvents,
  calendarSeries,
  googleAccounts,
  googleWorkspaces,
  projects,
  type Db,
} from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { seedUsers } from "../test/fixtures.js";

/**
 * SEZIONE CALENDARIO (fase 7b): `GET /api/me/calendar` (appuntamenti visti),
 * `GET /api/me/calendar/series` (serie riconosciute), `PUT`/`DELETE
 * /api/me/calendar/series/:recurringEventId` (attiva/spegne).
 *
 * Filo conduttore, identico a `me-mail.test.ts`: **`user_id` è nel WHERE di
 * ogni rotta**, verificato guardando che l'admin — NON solo un membro
 * qualunque — non veda né tocchi il calendario del member.
 */

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";

let testDb: TestDb;
let db: Db;
let app: FastifyInstance;
let adminCookie: string;
let memberCookie: string;
let memberId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  app = buildApp({ db, sessionSecret: SESSION_SECRET, encryptionKey: Buffer.alloc(32, 7).toString("base64") });
  ({ adminCookie, memberCookie, memberId } = await seedUsers(app));
}, 120_000);

afterEach(async () => {
  await db.delete(calendarSeries);
  await db.delete(calendarEvents);
  await db.delete(googleAccounts);
  await db.delete(googleWorkspaces);
});

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

async function seedAccount(userId: string): Promise<{ accountId: string; email: string }> {
  const [workspace] = await db
    .insert(googleWorkspaces)
    .values({ name: "Acme", domains: ["acme.test"], clientId: "client-id", clientSecretEncrypted: "blob" })
    .returning({ id: googleWorkspaces.id });
  const email = `mailbox-${randomUUID()}@acme.test`;
  const [account] = await db
    .insert(googleAccounts)
    .values({
      userId,
      workspaceId: workspace!.id,
      email,
      googleSub: `sub-${randomUUID()}`,
      refreshTokenEncrypted: "blob",
    })
    .returning({ id: googleAccounts.id });
  return { accountId: account!.id, email };
}

async function seedProject(name = "Progetto di test"): Promise<string> {
  const [row] = await db
    .insert(projects)
    .values({ name, slug: `slug-${randomUUID()}`, ingestionKey: randomUUID() })
    .returning({ id: projects.id });
  return row!.id;
}

async function seedCalendarEvent(
  accountId: string,
  overrides: Partial<typeof calendarEvents.$inferInsert> = {},
): Promise<string> {
  const startsAt = overrides.startsAt ?? new Date("2026-09-20T10:00:00.000Z");
  const [row] = await db
    .insert(calendarEvents)
    .values({
      accountId,
      googleEventId: `e-${randomUUID()}`,
      title: "Demo col cliente",
      startsAt,
      status: "confirmed",
      fingerprint: `${(startsAt as Date).toISOString().slice(0, 10)} demo col cliente`,
      ...overrides,
    })
    .returning({ id: calendarEvents.id });
  return row!.id;
}

function getCalendar(cookie: string, query = "") {
  return app.inject({ method: "GET", url: `/api/me/calendar${query}`, headers: { cookie } });
}

function getSeries(cookie: string, query = "") {
  return app.inject({ method: "GET", url: `/api/me/calendar/series${query}`, headers: { cookie } });
}

function putSeries(cookie: string, recurringEventId: string, body: Record<string, unknown>) {
  return app.inject({
    method: "PUT",
    url: `/api/me/calendar/series/${encodeURIComponent(recurringEventId)}`,
    headers: { cookie },
    payload: body,
  });
}

function deleteSeries(cookie: string, recurringEventId: string, account: string) {
  return app.inject({
    method: "DELETE",
    url: `/api/me/calendar/series/${encodeURIComponent(recurringEventId)}?account=${account}`,
    headers: { cookie },
  });
}

describe("GET /api/me/calendar", () => {
  it("senza sessione: 401", async () => {
    expect((await getCalendar("")).statusCode).toBe(401);
  });

  it("elenca gli appuntamenti dell'utente, ordinati per data desc", async () => {
    const { accountId } = await seedAccount(memberId);
    await seedCalendarEvent(accountId, { title: "Primo", startsAt: new Date("2026-09-15T09:00:00.000Z") });
    await seedCalendarEvent(accountId, { title: "Secondo", startsAt: new Date("2026-09-20T09:00:00.000Z") });

    const res = await getCalendar(memberCookie);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.map((item: { title: string }) => item.title)).toEqual(["Secondo", "Primo"]);
  });

  it("ACL: un admin non vede il calendario di un member (pagina vuota, non 403)", async () => {
    const { accountId } = await seedAccount(memberId);
    await seedCalendarEvent(accountId);

    const res = await getCalendar(adminCookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([]);
  });

  it("porta recurringEventId quando l'occorrenza appartiene a una serie", async () => {
    const { accountId } = await seedAccount(memberId);
    await seedCalendarEvent(accountId, { recurringEventId: "serie-1" });
    const res = await getCalendar(memberCookie);
    expect(res.json().items[0].recurringEventId).toBe("serie-1");
  });
});

describe("GET /api/me/calendar/series", () => {
  it("senza sessione: 401", async () => {
    expect((await getSeries("")).statusCode).toBe(401);
  });

  it("raggruppa le occorrenze per serie e mostra i default quando non configurata (spenta)", async () => {
    const { accountId } = await seedAccount(memberId);
    await seedCalendarEvent(accountId, {
      recurringEventId: "serie-1",
      title: "Pianificazione task",
      startsAt: new Date("2026-09-10T09:00:00.000Z"),
    });
    await seedCalendarEvent(accountId, {
      recurringEventId: "serie-1",
      title: "Pianificazione task",
      startsAt: new Date("2026-09-17T09:00:00.000Z"),
    });
    // Un evento singolo, senza serie: non deve comparire nell'elenco.
    await seedCalendarEvent(accountId, { title: "Singolo" });

    const res = await getSeries(memberCookie);
    expect(res.statusCode).toBe(200);
    const items = res.json().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      recurringEventId: "serie-1",
      occurrenceCount: 2,
      enabled: false,
      projectId: null,
      action: "milestone",
      leadDays: 2,
      auto: false,
    });
  });

  it("le occorrenze passate producono una serie con nextOccurrenceAt null, ma restano visibili", async () => {
    const { accountId } = await seedAccount(memberId);
    await seedCalendarEvent(accountId, {
      recurringEventId: "serie-passata",
      startsAt: new Date("2020-01-06T09:00:00.000Z"),
    });
    const res = await getSeries(memberCookie);
    const item = res.json().items.find((row: { recurringEventId: string }) => row.recurringEventId === "serie-passata");
    expect(item.nextOccurrenceAt).toBeNull();
    expect(item.enabled).toBe(false);
  });

  it("ACL: un admin non vede le serie di un member", async () => {
    const { accountId } = await seedAccount(memberId);
    await seedCalendarEvent(accountId, { recurringEventId: "serie-1" });
    const res = await getSeries(adminCookie);
    expect(res.json().items).toEqual([]);
  });
});

describe("PUT /api/me/calendar/series/:recurringEventId", () => {
  it("senza sessione: 401", async () => {
    const res = await putSeries("", "serie-1", { accountId: randomUUID(), enabled: false, projectId: null });
    expect(res.statusCode).toBe(401);
  });

  it("400 se enabled:true senza projectId — il progetto si fissa, non si ri-deduce", async () => {
    const { accountId } = await seedAccount(memberId);
    await seedCalendarEvent(accountId, { recurringEventId: "serie-1" });
    const res = await putSeries(memberCookie, "serie-1", { accountId, enabled: true, projectId: null });
    expect(res.statusCode).toBe(400);
  });

  it("404 se la serie non è mai stata vista (nessuna occorrenza sotto questo id)", async () => {
    const { accountId } = await seedAccount(memberId);
    const projectId = await seedProject();
    const res = await putSeries(memberCookie, "mai-vista", { accountId, enabled: true, projectId });
    expect(res.statusCode).toBe(404);
  });

  it("configura e accende la serie; GET /series riflette la configurazione", async () => {
    const { accountId } = await seedAccount(memberId);
    const projectId = await seedProject("Progetto Acme");
    await seedCalendarEvent(accountId, { recurringEventId: "serie-1" });

    const put = await putSeries(memberCookie, "serie-1", {
      accountId,
      enabled: true,
      projectId,
      action: "reminder",
      leadDays: 5,
      auto: false,
    });
    expect(put.statusCode).toBe(200);

    const res = await getSeries(memberCookie);
    const item = res.json().items[0];
    expect(item).toMatchObject({
      enabled: true,
      projectId,
      projectName: "Progetto Acme",
      action: "reminder",
      leadDays: 5,
      auto: false,
    });
  });

  it("una seconda PUT sostituisce la configurazione (upsert, non due righe)", async () => {
    const { accountId } = await seedAccount(memberId);
    const projectId = await seedProject();
    await seedCalendarEvent(accountId, { recurringEventId: "serie-1" });

    await putSeries(memberCookie, "serie-1", { accountId, enabled: true, projectId, leadDays: 2 });
    await putSeries(memberCookie, "serie-1", { accountId, enabled: true, projectId, leadDays: 7 });

    const res = await getSeries(memberCookie);
    expect(res.json().items).toHaveLength(1);
    expect(res.json().items[0].leadDays).toBe(7);
  });

  it("ACL: un admin non può configurare la serie di un member (404, la casella non è sua)", async () => {
    const { accountId } = await seedAccount(memberId);
    const projectId = await seedProject();
    await seedCalendarEvent(accountId, { recurringEventId: "serie-1" });

    const res = await putSeries(adminCookie, "serie-1", { accountId, enabled: true, projectId });
    expect(res.statusCode).toBe(404);
    // Non deve aver scritto nulla.
    const check = await getSeries(memberCookie);
    expect(check.json().items[0].enabled).toBe(false);
  });
});

describe("DELETE /api/me/calendar/series/:recurringEventId", () => {
  it("senza sessione: 401", async () => {
    expect((await deleteSeries("", "serie-1", randomUUID())).statusCode).toBe(401);
  });

  it("spegne la serie: la riga sparisce e la serie torna ai default", async () => {
    const { accountId } = await seedAccount(memberId);
    const projectId = await seedProject();
    await seedCalendarEvent(accountId, { recurringEventId: "serie-1" });
    await putSeries(memberCookie, "serie-1", { accountId, enabled: true, projectId });

    const del = await deleteSeries(memberCookie, "serie-1", accountId);
    expect(del.statusCode).toBe(200);

    const res = await getSeries(memberCookie);
    expect(res.json().items[0].enabled).toBe(false);
    expect(res.json().items[0].projectId).toBeNull();

    const rows = await db.select().from(calendarSeries);
    expect(rows).toHaveLength(0);
  });

  it("ACL: un admin non può spegnere la serie di un member (404, la casella non è sua)", async () => {
    const { accountId } = await seedAccount(memberId);
    const projectId = await seedProject();
    await seedCalendarEvent(accountId, { recurringEventId: "serie-1" });
    await putSeries(memberCookie, "serie-1", { accountId, enabled: true, projectId });

    const res = await deleteSeries(adminCookie, "serie-1", accountId);
    expect(res.statusCode).toBe(404);
    const rows = await db.select().from(calendarSeries);
    expect(rows).toHaveLength(1);
  });
});
