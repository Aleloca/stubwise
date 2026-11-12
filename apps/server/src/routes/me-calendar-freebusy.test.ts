import { randomUUID } from "node:crypto";
import { calendarEvents, googleAccounts, googleWorkspaces, type Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import type { CalendarWriteClient } from "../services/calendar-writes.js";
import { createUserWithSession } from "../test/fixtures.js";

/**
 * IL LIBERO/OCCUPATO DEI COLLEGHI (area 6, F4, task 5): un'ECCEZIONE
 * DICHIARATA a «Posta e Calendario personali». Chiunque nell'istanza lo
 * legge *(O)*, ma esce SOLO chi, se è collegato e gli intervalli: i test
 * guardano le chiavi esatte della risposta, e un evento privato con titolo e
 * luogo non lascia niente oltre le sue due date. Dalle righe salvate (Q3 =
 * a): nessuna chiamata a Google — il client delle scritture qui esplode.
 */

const explode = () => {
  throw new Error("il libero/occupato non chiama Google");
};
const noGoogle = new Proxy({}, { get: () => explode }) as CalendarWriteClient;

let testDb: TestDb;
let db: Db;
let app: FastifyInstance;
const DAY = 24 * 3600_000;
const at = (days: number, hour: number) => {
  const d = new Date(Date.now() + days * DAY);
  d.setUTCHours(hour, 0, 0, 0);
  return d;
};

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  app = buildApp({ db, sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!", encryptionKey: Buffer.alloc(32, 4).toString("base64"), calendarWriteClient: noGoogle });
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

async function colleague(options: { disabled?: boolean; mailbox?: boolean } = {}) {
  const user = await createUserWithSession(app, `c-${randomUUID()}@acme.com`);
  if (options.mailbox === false) return { user, accountId: null as string | null, email: "" };
  const [ws] = await db.insert(googleWorkspaces).values({ name: "A", domains: ["acme.com"], clientId: "c", clientSecretEncrypted: "x" }).returning();
  const email = `box-${randomUUID().slice(0, 6)}@acme.com`;
  const [box] = await db
    .insert(googleAccounts)
    .values({ userId: user.id, workspaceId: ws!.id, email, googleSub: randomUUID(), refreshTokenEncrypted: "x", ...(options.disabled ? { disabledAt: new Date(), disabledReason: "invalid_grant" } : {}) })
    .returning();
  return { user, accountId: box!.id as string | null, email };
}

async function busyRow(accountId: string, from: Date, to: Date, over: Partial<typeof calendarEvents.$inferInsert> = {}) {
  await db.insert(calendarEvents).values({ accountId, googleEventId: `g-${randomUUID()}`, title: "Segreto", startsAt: from, endsAt: to, status: "confirmed", fingerprint: "x", proposalCandidate: false, ...over });
}

const get = (cookie: { cookie: string }, personIds: string[], from = at(1, 0), to = at(2, 0)) =>
  app.inject({ method: "GET", url: `/api/me/calendar/freebusy?personIds=${personIds.join(",")}&from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`, headers: cookie });

describe("GET /api/me/calendar/freebusy", () => {
  it("SOLO intervalli: le chiavi esatte, e un evento privato con titolo e luogo non lascia nient'altro", async () => {
    const me = await colleague();
    const bob = await colleague();
    await busyRow(bob.accountId!, at(1, 9), at(1, 10), { visibility: "private", title: "Colloquio riservato", location: "Studio legale", description: "dettagli", organizer: "x@y.it", attendees: [{ email: "z@y.it", responseStatus: "accepted" }] });
    const res = await get(me.user.headers, [bob.user.id]);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body)).toEqual(["items"]);
    expect(Object.keys(body.items[0]).sort()).toEqual(["availability", "busy", "personId"]);
    expect(body.items[0]).toEqual({ personId: bob.user.id, availability: "connected", busy: [{ startsAt: at(1, 9).toISOString(), endsAt: at(1, 10).toISOString() }] });
    expect(Object.keys(body.items[0].busy[0]).sort()).toEqual(["endsAt", "startsAt"]);
    for (const leak of ["Colloquio", "Studio", "dettagli", "x@y.it", "z@y.it", bob.email, bob.accountId!]) expect(res.body).not.toContain(leak);
  });

  it("non occupano: un rifiutato, un libero (transparent), un tutto il giorno, un cancellato; un fuori ufficio sì", async () => {
    const me = await colleague();
    const bob = await colleague();
    await busyRow(bob.accountId!, at(1, 8), at(1, 9), { attendees: [{ email: bob.email, responseStatus: "declined" }] });
    await busyRow(bob.accountId!, at(1, 10), at(1, 11), { transparency: "transparent" });
    await busyRow(bob.accountId!, at(1, 0), at(2, 0), { allDay: true });
    await busyRow(bob.accountId!, at(1, 12), at(1, 13), { status: "cancelled" });
    await busyRow(bob.accountId!, at(1, 14), at(1, 18), { eventType: "outOfOffice" });
    // Rifiutato da un alias della casella (`self`): non occupa (review F4, punto 7).
    await busyRow(bob.accountId!, at(1, 19), at(1, 20), { attendees: [{ email: "alias@acme.com", responseStatus: "declined", self: true }] });
    const res = await get(me.user.headers, [bob.user.id]);
    expect(res.json().items[0].busy).toEqual([{ startsAt: at(1, 14).toISOString(), endsAt: at(1, 18).toISOString() }]);
  });

  it("gli intervalli che si toccano si fondono, e si tagliano all'intervallo chiesto", async () => {
    const me = await colleague();
    const bob = await colleague();
    await busyRow(bob.accountId!, at(0, 23), at(1, 2));
    await busyRow(bob.accountId!, at(1, 9), at(1, 10));
    await busyRow(bob.accountId!, at(1, 10), at(1, 11));
    await busyRow(bob.accountId!, at(1, 10), at(1, 10));
    // Lungo zero, da solo: non è un intervallo.
    await busyRow(bob.accountId!, at(1, 15), at(1, 15));
    const res = await get(me.user.headers, [bob.user.id]);
    expect(res.json().items[0].busy).toEqual([
      { startsAt: at(1, 0).toISOString(), endsAt: at(1, 2).toISOString() },
      { startsAt: at(1, 9).toISOString(), endsAt: at(1, 11).toISOString() },
    ]);
  });

  it("chi non ha una casella è not_connected, chi l'ha scaduta expired: senza intervalli", async () => {
    const me = await colleague();
    const none = await colleague({ mailbox: false });
    const expired = await colleague({ disabled: true });
    await busyRow(expired.accountId!, at(1, 9), at(1, 10));
    const items = (await get(me.user.headers, [none.user.id, expired.user.id])).json().items;
    expect(items).toEqual([
      { personId: none.user.id, availability: "not_connected", busy: [] },
      { personId: expired.user.id, availability: "expired", busy: [] },
    ]);
  });

  it("con due caselle, quella disattivata non conta: le sue righe sono vecchie", async () => {
    const me = await colleague();
    const bob = await colleague();
    const [ws] = await db.insert(googleWorkspaces).values({ name: "B", domains: ["acme.com"], clientId: "c", clientSecretEncrypted: "x" }).returning();
    const [old] = await db.insert(googleAccounts).values({ userId: bob.user.id, workspaceId: ws!.id, email: `old-${randomUUID().slice(0, 6)}@acme.com`, googleSub: randomUUID(), refreshTokenEncrypted: "x", disabledAt: new Date(), disabledReason: "invalid_grant" }).returning();
    await busyRow(old!.id, at(1, 9), at(1, 10));
    await busyRow(bob.accountId!, at(1, 14), at(1, 15));
    expect((await get(me.user.headers, [bob.user.id])).json().items[0]).toEqual({ personId: bob.user.id, availability: "connected", busy: [{ startsAt: at(1, 14).toISOString(), endsAt: at(1, 15).toISOString() }] });
  });

  it("chiunque nell'istanza lo legge; senza sessione 401; un intervallo storto o troppe persone 400", async () => {
    const me = await colleague();
    const bob = await colleague();
    expect((await get(me.user.headers, [bob.user.id])).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/me/calendar/freebusy?personIds=${bob.user.id}&from=${at(1, 0).toISOString()}&to=${at(2, 0).toISOString()}` })).statusCode).toBe(401);
    expect((await get(me.user.headers, [bob.user.id], at(2, 0), at(1, 0))).statusCode).toBe(400);
    expect((await get(me.user.headers, [bob.user.id], at(1, 0), at(40, 0))).statusCode).toBe(400);
    expect((await get(me.user.headers, Array.from({ length: 51 }, () => randomUUID()))).statusCode).toBe(400);
  });
});
