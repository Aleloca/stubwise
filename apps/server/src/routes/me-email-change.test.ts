import { randomUUID } from "node:crypto";
import { emailChanges, invites, notifications, securityEvents, sessions, userTotp, users, type Db } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { hashPassword } from "../auth/password.js";
import type { MailMessage, MailTransport } from "../mail/transport.js";
import { fullSessionCookie, seedUsers } from "../test/fixtures.js";

/**
 * Area 9, F1, Task 8 (D-13, E-1 = a; docs/invariants/identity.md, «L'email di
 * login cambia solo dopo il clic sul link mandato alla NUOVA»).
 */

const sent: MailMessage[] = [];
const fakeTransport: MailTransport = { isConfigured: () => true, async send(m) { sent.push(m); } };

let testDb: TestDb;
let db: Db;
let app: FastifyInstance;
let noMail: FastifyInstance;
let adminCookie: string;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  const base = { db, sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!", encryptionKey: Buffer.alloc(32, 1).toString("base64"), publicUrl: "https://stubwise.example.com" };
  app = buildApp({ ...base, mailTransport: fakeTransport });
  noMail = buildApp(base);
  ({ adminCookie } = await seedUsers(app));
}, 120_000);
afterAll(async () => {
  await app.close();
  await noMail.close();
  await testDb.stop();
});

const PASSWORD = "password-della-persona";
async function person() {
  const email = `old-${randomUUID().slice(0, 8)}@acme.com`;
  const [u] = await db.insert(users).values({ email, passwordHash: await hashPassword(PASSWORD), role: "member" }).returning({ id: users.id });
  return { id: u!.id, email, cookie: await fullSessionCookie(app, u!.id) };
}
const request = (on: FastifyInstance, cookie: string, newEmail: string) =>
  on.inject({ method: "POST", url: "/api/me/email-change", headers: { cookie }, payload: { newEmail } });
// Le rotte pubbliche hanno il tetto dei tentativi del login, per IP: ogni chiamata
// del test arriva da un indirizzo suo, così il tetto non decide l'esito.
let ip = 0;
const fromNewIp = () => `10.9.${Math.floor(++ip / 250)}.${ip % 250}`;
const confirm = (token: string) => app.inject({ method: "POST", url: "/api/auth/email-change/confirm", payload: { token }, remoteAddress: fromNewIp() });
const peekLink = (token: string) => app.inject({ method: "GET", url: `/api/auth/email-change/${token}`, remoteAddress: fromNewIp() });
const tokenFrom = (m: MailMessage) => /#\/email-change\/([A-Za-z0-9_-]+)/.exec(m.text)![1]!;
const emailOf = async (id: string) => (await db.select({ e: users.email }).from(users).where(eq(users.id, id)))[0]!.e;

describe("il cambio dell'email di login", () => {
  it("il link va alla NUOVA, l'avviso alla vecchia; l'email cambia SOLO al clic; sessioni e secondo fattore intatti; avviso e registro", async () => {
    const p = await person();
    const newEmail = `new-${randomUUID().slice(0, 8)}@acme.com`;
    sent.length = 0;
    const res = await request(app, p.cookie, newEmail);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ pending: { newEmail } });
    const toNew = sent.find((m) => m.to === newEmail)!;
    expect(toNew.text).toContain("https://stubwise.example.com/#/email-change/");
    expect(sent.some((m) => m.to === p.email)).toBe(true);
    expect(sent.find((m) => m.to === p.email)!.text).not.toMatch(/#\/email-change\//);
    // Prima del clic: ancora la vecchia.
    expect(await emailOf(p.id)).toBe(p.email);
    const status = (await app.inject({ method: "GET", url: "/api/me/email-change", headers: { cookie: p.cookie } })).json();
    expect(status).toMatchObject({ available: true, pending: { newEmail } });
    // La lettura del link NON conferma: dice la nuova email e basta.
    const peek = await peekLink(tokenFrom(toNew));
    expect(peek.json()).toEqual({ status: "valid", newEmail });
    expect(await emailOf(p.id)).toBe(p.email);
    const sessionsBefore = (await db.select().from(sessions).where(eq(sessions.userId, p.id))).length;
    const ok = await confirm(tokenFrom(toNew));
    expect(ok.statusCode).toBe(200);
    expect(await emailOf(p.id)).toBe(newEmail);
    expect((await db.select().from(sessions).where(eq(sessions.userId, p.id))).length).toBe(sessionsBefore);
    expect(await db.select().from(userTotp).where(eq(userTotp.userId, p.id))).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: p.cookie } })).statusCode).toBe(200);
    const [event] = await db.select().from(securityEvents).where(and(eq(securityEvents.userId, p.id), eq(securityEvents.kind, "email_changed")));
    expect(event).toBeDefined();
    const alerts = await db.select().from(notifications).where(and(eq(notifications.userId, p.id), sql`${notifications.event}->>'subject' = 'email_changed'`));
    expect(alerts).toHaveLength(1);
    // Il login: con la nuova sì, con la vecchia no.
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: newEmail, password: PASSWORD } })).statusCode).not.toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: p.email, password: PASSWORD } })).statusCode).toBe(401);
  });

  it("il link è MONOUSO, scade, si annulla; una seconda richiesta sostituisce la prima; un token sbagliato dà lo stesso 400", async () => {
    const p = await person();
    sent.length = 0;
    await request(app, p.cookie, `a-${randomUUID().slice(0, 6)}@acme.com`);
    const first = tokenFrom(sent.find((m) => /#\/email-change\//.test(m.text))!);
    sent.length = 0;
    const second = `b-${randomUUID().slice(0, 6)}@acme.com`;
    await request(app, p.cookie, second);
    const secondToken = tokenFrom(sent.find((m) => m.to === second)!);
    const bodies = new Set<string>();
    const stale = await confirm(first);
    expect(stale.statusCode).toBe(400);
    bodies.add(stale.body);
    const wrong = await confirm("token-inventato");
    bodies.add(wrong.body);
    expect((await confirm(secondToken)).statusCode).toBe(200);
    const reused = await confirm(secondToken);
    expect(reused.statusCode).toBe(400);
    bodies.add(reused.body);
    // Scaduto.
    sent.length = 0;
    const third = `c-${randomUUID().slice(0, 6)}@acme.com`;
    await request(app, p.cookie, third);
    await db.update(emailChanges).set({ expiresAt: sql`now() - interval '1 minute'` }).where(eq(emailChanges.newEmail, third));
    const expired = await confirm(tokenFrom(sent.find((m) => m.to === third)!));
    expect(expired.statusCode).toBe(400);
    bodies.add(expired.body);
    // Annullato.
    sent.length = 0;
    const fourth = `d-${randomUUID().slice(0, 6)}@acme.com`;
    await request(app, p.cookie, fourth);
    expect((await app.inject({ method: "DELETE", url: "/api/me/email-change", headers: { cookie: p.cookie } })).statusCode).toBe(204);
    const cancelled = await confirm(tokenFrom(sent.find((m) => m.to === fourth)!));
    expect(cancelled.statusCode).toBe(400);
    bodies.add(cancelled.body);
    expect([...bodies]).toHaveLength(1);
    // La lettura: lo stesso «invalid» per sbagliato, usato, scaduto, annullato.
    for (const t of ["token-inventato", first, secondToken]) {
      expect((await peekLink(t)).json()).toEqual({ status: "invalid" });
    }
    expect(await emailOf(p.id)).toBe(second);
  });

  it("NEGATIVI: un'email già di un'altra persona o di un invito pendente (lo stesso 409); il token non si salva in chiaro", async () => {
    const p = await person();
    const other = await person();
    const taken = await request(app, p.cookie, other.email.toUpperCase());
    expect(taken.statusCode).toBe(409);
    const invited = `inv-${randomUUID().slice(0, 6)}@acme.com`;
    await db.insert(invites).values({ token: `t-${randomUUID()}`, email: invited, expiresAt: new Date(Date.now() + 86_400_000) });
    const byInvite = await request(app, p.cookie, invited);
    expect(byInvite.statusCode).toBe(409);
    expect(byInvite.body).toBe(taken.body);
    sent.length = 0;
    await request(app, p.cookie, `e-${randomUUID().slice(0, 6)}@acme.com`);
    const token = tokenFrom(sent.find((m) => /#\/email-change\//.test(m.text))!);
    const [row] = await db.select().from(emailChanges).where(eq(emailChanges.userId, p.id));
    expect(row!.tokenHash).not.toContain(token);
  });

  it("senza trasporto: 409 email_transport_unavailable, e lo stato dice «non disponibile»; il cambio fatto da un admin resta", async () => {
    const p = await person();
    const cookie = await fullSessionCookie(noMail, p.id);
    const res = await request(noMail, cookie, `x-${randomUUID().slice(0, 6)}@acme.com`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "email_transport_unavailable" });
    expect((await noMail.inject({ method: "GET", url: "/api/me/email-change", headers: { cookie } })).json()).toMatchObject({ available: false, pending: null });
  });

  it("il cambio fatto da un admin: subito, sessioni intatte, annulla la pendente, l'avviso nomina l'admin; mai su sé stessi", async () => {
    const p = await person();
    sent.length = 0;
    await request(app, p.cookie, `pend-${randomUUID().slice(0, 6)}@acme.com`);
    const pendingToken = tokenFrom(sent.find((m) => /#\/email-change\//.test(m.text))!);
    const target = `adm-${randomUUID().slice(0, 6)}@acme.com`;
    const res = await app.inject({ method: "PATCH", url: `/api/users/${p.id}/email`, headers: { cookie: adminCookie }, payload: { email: target } });
    expect(res.statusCode).toBe(200);
    expect(await emailOf(p.id)).toBe(target);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: p.cookie } })).statusCode).toBe(200);
    expect((await confirm(pendingToken)).statusCode).toBe(400);
    const [alert] = await db.select().from(notifications).where(and(eq(notifications.userId, p.id), sql`${notifications.event}->>'subject' = 'email_changed'`));
    expect((alert!.event as { actorEmail: string | null }).actorEmail).toBe("admin@example.com");
    const [adminRow] = await db.select({ id: users.id }).from(users).where(eq(users.email, "admin@example.com"));
    const self = await app.inject({ method: "PATCH", url: `/api/users/${adminRow!.id}/email`, headers: { cookie: adminCookie }, payload: { email: `self-${randomUUID()}@acme.com` } });
    expect(self.statusCode).toBe(400);
    const plain = await person();
    expect((await app.inject({ method: "PATCH", url: `/api/users/${p.id}/email`, headers: { cookie: plain.cookie }, payload: { email: "z@acme.com" } })).statusCode).toBe(403);
  });

  it("review I/m7: un invito SCADUTO non blocca l'indirizzo; due conferme sullo stesso indirizzo danno 200 e 409, mai 500", async () => {
    const p = await person();
    const expiredInvite = `exp-${randomUUID().slice(0, 6)}@acme.com`;
    await db.insert(invites).values({ token: `t-${randomUUID()}`, email: expiredInvite, expiresAt: new Date(Date.now() - 60_000) });
    expect((await request(app, p.cookie, expiredInvite)).statusCode).toBe(202);
    const a = await person();
    const b = await person();
    const same = `same-${randomUUID().slice(0, 6)}@acme.com`;
    sent.length = 0;
    await request(app, a.cookie, same);
    const tokenA = tokenFrom(sent.find((m) => m.to === same)!);
    sent.length = 0;
    await request(app, b.cookie, same);
    const tokenB = tokenFrom(sent.find((m) => m.to === same)!);
    const statuses = (await Promise.all([confirm(tokenA), confirm(tokenB)])).map((r) => r.statusCode).sort();
    expect(statuses).toEqual([200, 409]);
  });
});
