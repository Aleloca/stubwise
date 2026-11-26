import { randomUUID } from "node:crypto";
import { deviceTokens, personalAccessTokens, sessions, users, type Db } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createSession, SESSION_COOKIE } from "../auth/session.js";
import { generatePat, hashServerKey } from "./shared.js";
import { fullSessionCookie, partialSessionCookie, seedUsers } from "../test/fixtures.js";

/**
 * Area 9, F1, Task 5 (D-9): le mie sessioni, del browser e dei token di
 * desktop e telefono, col «Sign out» di una, mai di quella corrente. Gli id
 * sono OPACHI: un id di sessione vero non esce mai.
 */

let testDb: TestDb;
let db: Db;
let app: FastifyInstance;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  app = buildApp({ db, sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!", encryptionKey: Buffer.alloc(32, 8).toString("base64") });
  await seedUsers(app);
}, 120_000);
afterAll(async () => {
  await app.close();
  await testDb.stop();
});

type Row = { id: string; kind: string; userAgent: string | null; createdAt: string; lastSeenAt: string | null; current: boolean };

async function scene() {
  const [u] = await db.insert(users).values({ email: `s-${randomUUID()}@acme.com`, passwordHash: "x", role: "member" }).returning({ id: users.id });
  const current = await fullSessionCookie(app, u!.id);
  const other = await fullSessionCookie(app, u!.id);
  await partialSessionCookie(app, u!.id, "second_factor");
  const pat = async (kind: "desktop" | "mobile" | "manual") => {
    const token = generatePat();
    const [row] = await db.insert(personalAccessTokens).values({ userId: u!.id, name: `t-${kind}`, tokenHash: hashServerKey(token), kind }).returning({ id: personalAccessTokens.id });
    return { id: row!.id, token };
  };
  const desktop = await pat("desktop");
  await db.insert(deviceTokens).values({ userId: u!.id, patId: desktop.id, platform: "ios", token: `dev-${randomUUID()}` });
  const mobile = await pat("mobile");
  const manual = await pat("manual");
  return { userId: u!.id, current, other, desktop, mobile, manual };
}
const list = async (cookie: string) => {
  const res = await app.inject({ method: "GET", url: "/api/me/sessions", headers: { cookie, "user-agent": "Mozilla/5.0 Test" } });
  expect(res.statusCode).toBe(200);
  return res.json() as Row[];
};
const end = (cookie: string, id: string) => app.inject({ method: "DELETE", url: `/api/me/sessions/${encodeURIComponent(id)}`, headers: { cookie } });
const me = (headers: Record<string, string>) => app.inject({ method: "GET", url: "/api/auth/me", headers });

describe("le mie sessioni", () => {
  it("l'elenco: le sessioni COMPLETE del browser (la corrente segnata) e i token di desktop e telefono; mai una parziale né un PAT a mano; id opachi", async () => {
    const s = await scene();
    const rows = await list(s.current);
    expect(rows.map((r) => r.kind).sort()).toEqual(["browser", "browser", "desktop", "mobile"]);
    expect(rows.filter((r) => r.current)).toHaveLength(1);
    expect(rows.find((r) => r.current)!.kind).toBe("browser");
    const raw = (await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, s.userId))).map((r) => r.id);
    for (const r of rows) {
      expect(raw).not.toContain(r.id);
      for (const id of raw) expect(r.id).not.toContain(id);
    }
    expect(rows.map((r) => r.id)).not.toContain(s.manual.id);
  });

  it("«Sign out» di un'altra sessione del browser la chiude davvero; di un token desktop lo revoca coi suoi device", async () => {
    const s = await scene();
    const rows = await list(s.current);
    const other = rows.find((r) => r.kind === "browser" && !r.current)!;
    expect((await end(s.current, other.id)).statusCode).toBe(204);
    expect((await me({ cookie: s.other })).statusCode).toBe(401);
    expect((await me({ cookie: s.current })).statusCode).toBe(200);
    const desktop = rows.find((r) => r.kind === "desktop")!;
    expect((await end(s.current, desktop.id)).statusCode).toBe(204);
    expect((await me({ authorization: `Bearer ${s.desktop.token}` })).statusCode).toBe(401);
    // Il PAT è cancellato (la FK mette il device a NULL), ma il device è SPENTO prima.
    const devices = await db.select().from(deviceTokens).where(eq(deviceTokens.userId, s.userId));
    expect(devices).toHaveLength(1);
    expect(devices[0]!.disabledAt).not.toBeNull();
  });

  it("NEGATIVI: la corrente (409), una di un altro (404), un id inventato (404), un id di sessione VERO (404)", async () => {
    const s = await scene();
    const t = await scene();
    const mine = await list(s.current);
    expect((await end(s.current, mine.find((r) => r.current)!.id)).json()).toMatchObject({ code: "current_session" });
    const theirs = (await list(t.current)).find((r) => !r.current)!;
    expect((await end(s.current, theirs.id)).statusCode).toBe(404);
    expect((await me({ cookie: t.other })).statusCode).toBe(200);
    expect((await end(s.current, "inventato")).statusCode).toBe(404);
    const [raw] = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, s.userId)).limit(1);
    expect((await end(s.current, raw!.id)).statusCode).toBe(404);
  });

  it("`last_seen_at` e lo user agent: si scrivono all'uso, ma al più ogni 5 minuti", async () => {
    const [u] = await db.insert(users).values({ email: `l-${randomUUID()}@acme.com`, passwordHash: "x", role: "member" }).returning({ id: users.id });
    const created = await createSession(db, u!.id, { stage: "full", secondFactorAt: new Date() });
    const cookie = `${SESSION_COOKIE}=${encodeURIComponent(app.signCookie(created.id))}`;
    const row = async () => (await db.select().from(sessions).where(eq(sessions.id, created.id)))[0]!;
    await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie, "user-agent": "Browser Uno" } });
    const first = await row();
    expect(first.lastSeenAt).not.toBeNull();
    expect(first.userAgent).toBe("Browser Uno");
    // Un minuto fa: non si riscrive.
    await db.update(sessions).set({ lastSeenAt: sql`now() - interval '1 minute'` }).where(eq(sessions.id, created.id));
    const before = (await row()).lastSeenAt!.getTime();
    await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie, "user-agent": "Browser Uno" } });
    expect((await row()).lastSeenAt!.getTime()).toBe(before);
    // Dieci minuti fa: sì.
    await db.update(sessions).set({ lastSeenAt: sql`now() - interval '10 minutes'` }).where(eq(sessions.id, created.id));
    const stale = (await row()).lastSeenAt!.getTime();
    await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect((await row()).lastSeenAt!.getTime()).toBeGreaterThan(stale);
  });
});
