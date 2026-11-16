import { randomUUID } from "node:crypto";
import { notifications, users, type Db } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { fullSessionCookie, seedUsers } from "../test/fixtures.js";

/**
 * Area 9, F1, Task 10 (design 1.8): «Restore», «Move to New», «segna non
 * letta». Solo le card di chi chiama; uno stato da cui il passaggio non ha
 * senso dà 409 `invalid_state`.
 */

let testDb: TestDb;
let db: Db;
let app: FastifyInstance;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  app = buildApp({ db, sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!", encryptionKey: Buffer.alloc(32, 4).toString("base64") });
  await seedUsers(app);
}, 120_000);
afterAll(async () => {
  await app.close();
  await testDb.stop();
});

async function person() {
  const [u] = await db.insert(users).values({ email: `i-${randomUUID()}@acme.com`, passwordHash: "x", role: "member" }).returning({ id: users.id });
  return { id: u!.id, cookie: await fullSessionCookie(app, u!.id) };
}
type Status = "open" | "handled" | "snoozed";
async function card(userId: string, status: Status) {
  const [row] = await db
    .insert(notifications)
    .values({
      userId,
      kind: "security.alert",
      event: { kind: "security.alert", subject: "passkey_added", actorEmail: null },
      projectId: null,
      status,
      ...(status === "handled" ? { handledAt: new Date(), handledByUserId: userId, handledAction: "archive" as const } : {}),
      ...(status === "snoozed" ? { snoozedUntil: new Date(Date.now() + 3_600_000) } : {}),
      readAt: new Date(),
    })
    .returning({ id: notifications.id });
  return row!.id;
}
const post = (cookie: string, id: string, what: string) => app.inject({ method: "POST", url: `/api/inbox/${id}/${what}`, headers: { cookie } });
const count = async (cookie: string) => (await app.inject({ method: "GET", url: "/api/inbox/unread-count", headers: { cookie } })).json().count as number;
const row = async (id: string) => (await db.select().from(notifications).where(eq(notifications.id, id)))[0]!;

describe("Inbox: ripristinare, rimettere fra le nuove, segnare non letta", () => {
  it("Restore: da handled a open, senza più chiusura; il conteggio sale", async () => {
    const p = await person();
    const id = await card(p.id, "handled");
    const before = await count(p.cookie);
    expect((await post(p.cookie, id, "restore")).statusCode).toBe(204);
    const r = await row(id);
    expect(r.status).toBe("open");
    expect(r.handledAt).toBeNull();
    expect(r.handledByUserId).toBeNull();
    expect(await count(p.cookie)).toBe(before + 1);
  });

  it("Move to New: da snoozed a open, senza più rinvio; il conteggio sale", async () => {
    const p = await person();
    const id = await card(p.id, "snoozed");
    const before = await count(p.cookie);
    expect((await post(p.cookie, id, "move-to-new")).statusCode).toBe(204);
    const r = await row(id);
    expect(r.status).toBe("open");
    expect(r.snoozedUntil).toBeNull();
    expect(await count(p.cookie)).toBe(before + 1);
  });

  it("non letta: read_at torna null, in qualunque stato, e rifarlo è innocuo", async () => {
    const p = await person();
    const id = await card(p.id, "open");
    expect((await post(p.cookie, id, "unread")).statusCode).toBe(204);
    expect((await row(id)).readAt).toBeNull();
    expect((await post(p.cookie, id, "unread")).statusCode).toBe(204);
  });

  it("NEGATIVI: la card di un altro (404, invariata), uno stato sbagliato (409 invalid_state)", async () => {
    const p = await person();
    const other = await person();
    const theirs = await card(other.id, "handled");
    for (const what of ["restore", "move-to-new", "unread"]) {
      expect((await post(p.cookie, theirs, what)).statusCode).toBe(404);
    }
    const r = await row(theirs);
    expect(r.status).toBe("handled");
    expect(r.readAt).not.toBeNull();
    const open = await card(p.id, "open");
    expect((await post(p.cookie, open, "restore")).json()).toMatchObject({ code: "invalid_state" });
    expect((await post(p.cookie, open, "move-to-new")).statusCode).toBe(409);
    // Chiusa da una decisione (o prima della 0186): non si ripristina.
    const decided = await card(p.id, "handled");
    await db.update(notifications).set({ handledAction: "decision" }).where(eq(notifications.id, decided));
    expect((await post(p.cookie, decided, "restore")).statusCode).toBe(409);
    const legacy = await card(p.id, "handled");
    await db.update(notifications).set({ handledAction: null }).where(eq(notifications.id, legacy));
    expect((await post(p.cookie, legacy, "restore")).statusCode).toBe(409);
    const snoozed = await card(p.id, "snoozed");
    expect((await post(p.cookie, snoozed, "restore")).statusCode).toBe(409);
    expect((await row(snoozed)).status).toBe("snoozed");
  });
});
