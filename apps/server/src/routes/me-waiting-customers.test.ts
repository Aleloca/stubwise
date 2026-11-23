import { randomUUID } from "node:crypto";
import { emailMessages, emailProposals, googleAccounts, googleWorkspaces, mailOutgoing, projects, type Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { waitingCustomersResponseSchema } from "@stubwise/shared";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

/**
 * Area 8, «Clienti in attesa» (W2): `GET /api/me/waiting-customers`. È la MIA
 * posta: solo le mie caselle, mai quelle di un collega (nemmeno a un full
 * admin, la regola `mailbox_owner`). I NEGATIVI sono il punto.
 */

let testDb: TestDb;
let db: Db;
let app: FastifyInstance;
let adminCookie: string;
let adminId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  app = buildApp({ db, sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!", encryptionKey: Buffer.alloc(32, 6).toString("base64") });
  ({ adminCookie, adminId } = await seedUsers(app));
}, 120_000);
afterAll(async () => {
  await app.close();
  await testDb.stop();
});

const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR);

let ws: string | null = null;
async function box(userId: string, email = `b-${randomUUID().slice(0, 8)}@acme.com`) {
  if (!ws) ws = (await db.insert(googleWorkspaces).values({ name: "A", domains: ["acme.com"], clientId: "c", clientSecretEncrypted: "x" }).returning())[0]!.id;
  const [a] = await db.insert(googleAccounts).values({ userId, workspaceId: ws, email, googleSub: randomUUID(), refreshTokenEncrypted: "x" }).returning();
  return a!;
}
async function person() {
  const user = await createUserWithSession(app, `p-${randomUUID().slice(0, 8)}@acme.com`);
  return { ...user, box: await box(user.id) };
}
async function project(name = "Audin") {
  const code = Array.from({ length: 5 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("");
  return (await db.insert(projects).values({ name, code, slug: `p-${randomUUID()}`, ingestionKey: randomUUID() }).returning())[0]!;
}
async function msg(accountId: string, threadId: string, over: Partial<typeof emailMessages.$inferInsert>) {
  return (
    await db
      .insert(emailMessages)
      .values({ accountId, gmailMessageId: randomUUID(), threadId, fromAddress: "cliente@cliente.it", fromName: "Rossi", subject: "Preventivo", receivedAt: ago(30), status: "classified", ...over })
      .returning()
  )[0]!;
}
/** Un thread che aspetta: il cliente, ammesso nel progetto, 30 ore fa. */
async function waiting(accountId: string, projectId: string, over: Partial<typeof emailMessages.$inferInsert> = {}) {
  const threadId = `th-${randomUUID()}`;
  const message = await msg(accountId, threadId, { admitted: true, projectId, ...over });
  return { threadId, message };
}
const eqId = (id: string) => eq(emailMessages.id, id);
const eqLastOf = (accountId: string, threadId: string) =>
  sql`${emailMessages.id} = (select id from email_messages where account_id = ${accountId}::uuid and thread_id = ${threadId} order by received_at desc limit 1)`;
const read = async (headers: { cookie: string }) => {
  const res = await app.inject({ method: "GET", url: "/api/me/waiting-customers", headers });
  expect(res.statusCode).toBe(200);
  return waitingCustomersResponseSchema.parse(res.json());
};

describe("GET /api/me/waiting-customers", () => {
  it("un thread che aspetta: la riga col cliente, il progetto, «da valutare» senza giudizio; col sì la ragione; col no sparisce", async () => {
    const me = await person();
    const p = await project();
    await addMember(app, p.id, me.id);
    const { threadId, message } = await waiting(me.box.id, p.id);
    await db.insert(emailProposals).values({ emailMessageId: message.id, projectId: p.id, status: "classified", classification: { signal: "request", recommendedIndex: 0, proposals: [] } });

    let page = await read(me.headers);
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({
      threadId,
      accountId: me.box.id,
      accountEmail: me.box.email,
      customer: { name: "Rossi", email: "cliente@cliente.it" },
      subject: "Preventivo",
      project: { id: p.id, code: p.code, name: "Audin" },
      signal: "request",
      judgment: "pending",
      reason: null,
    });
    expect(new Date(page.items[0]!.waitingSince).getTime()).toBe(message.receivedAt.getTime());

    await db.update(emailMessages).set({ replyJudgment: { needsMyReply: true, reason: "Chiede il preventivo.", model: "haiku", at: new Date().toISOString() } }).where(eqId(message.id));
    page = await read(me.headers);
    expect(page.items[0]).toMatchObject({ judgment: "yes", reason: "Chiede il preventivo." });

    await db.update(emailMessages).set({ replyJudgment: { error: "invalid_or_failed", at: new Date().toISOString() } }).where(eqId(message.id));
    expect((await read(me.headers)).items[0]).toMatchObject({ judgment: "pending", reason: null });

    await db.update(emailMessages).set({ replyJudgment: { needsMyReply: false, reason: "Ringrazia.", at: new Date().toISOString() } }).where(eqId(message.id));
    expect(await read(me.headers)).toEqual({ items: [], total: 0 });
  });

  it("il giudizio di un messaggio che non è più l'ultimo non conta", async () => {
    const me = await person();
    const p = await project();
    await addMember(app, p.id, me.id);
    const { threadId, message } = await waiting(me.box.id, p.id, { receivedAt: ago(40) });
    await db.update(emailMessages).set({ replyJudgment: { needsMyReply: false, reason: "Ringrazia.", at: new Date().toISOString() } }).where(eqId(message.id));
    await msg(me.box.id, threadId, { admitted: true, projectId: p.id, receivedAt: ago(30) });
    expect((await read(me.headers)).items.map((i) => i.judgment)).toEqual(["pending"]);
  });

  it("NEGATIVI: meno di 24 ore; l'ultimo è mio; l'ultimo è di un COLLEGA; un invio mandato dopo; solo contesto; progetto non visibile; rumore", async () => {
    const me = await person();
    const colleague = await person();
    const p = await project();
    const hidden = await project("Nascosto");
    await addMember(app, p.id, me.id);

    await waiting(me.box.id, p.id, { receivedAt: ago(5) });
    const mine = await waiting(me.box.id, p.id);
    await msg(me.box.id, mine.threadId, { fromAddress: me.box.email, receivedAt: ago(20), admitted: false });
    const byColleague = await waiting(me.box.id, p.id);
    await msg(me.box.id, byColleague.threadId, { fromAddress: colleague.box.email, receivedAt: ago(20), admitted: false });
    await db.update(emailMessages).set({ replyJudgment: { needsMyReply: false, reason: "Ha risposto il collega.", at: new Date().toISOString() } }).where(eqLastOf(me.box.id, byColleague.threadId));
    const replied = await waiting(me.box.id, p.id);
    await db.insert(mailOutgoing).values({ userId: me.id, accountId: me.box.id, gmailDraftId: "d", sendAt: ago(10), state: "sent", gmailThreadId: replied.threadId, sentAt: ago(10) });
    await msg(me.box.id, `th-${randomUUID()}`, { admitted: false });
    await waiting(me.box.id, hidden.id);
    await waiting(me.box.id, p.id, { status: "ignored", importance: "normal" });

    expect(await read(me.headers)).toEqual({ items: [], total: 0 });
  });

  it("un invio ancora in coda NON conta: il cliente aspetta ancora", async () => {
    const me = await person();
    const p = await project();
    await addMember(app, p.id, me.id);
    const { threadId } = await waiting(me.box.id, p.id);
    await db.insert(mailOutgoing).values({ userId: me.id, accountId: me.box.id, gmailDraftId: "d", sendAt: ago(-1), state: "queued", gmailThreadId: threadId });
    expect((await read(me.headers)).items.map((i) => i.threadId)).toEqual([threadId]);
  });

  it("la casella di un collega non compare mai, nemmeno a un full admin; senza caselle la lista è vuota", async () => {
    const colleague = await person();
    const p = await project();
    await addMember(app, p.id, colleague.id);
    await waiting(colleague.box.id, p.id);
    expect((await read(colleague.headers)).total).toBe(1);
    expect(await read({ cookie: adminCookie })).toEqual({ items: [], total: 0 });
    const adminBox = await box(adminId);
    const own = await waiting(adminBox.id, p.id);
    expect((await read({ cookie: adminCookie })).items.map((i) => i.threadId)).toEqual([own.threadId]);
  });

  it("dall'attesa più vecchia, al più 20 righe, `total` le conta tutte", async () => {
    const me = await person();
    const p = await project();
    await addMember(app, p.id, me.id);
    for (let i = 0; i < 22; i++) await waiting(me.box.id, p.id, { receivedAt: ago(30 + i) });
    const page = await read(me.headers);
    expect(page.total).toBe(22);
    expect(page.items).toHaveLength(20);
    const times = page.items.map((i) => new Date(i.waitingSince).getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(times[0]).toBeLessThan(ago(50).getTime());
  });

  it("registro, A8 «Clienti in attesa»: una riga il cui progetto non c'è più si salta, e `total` non la conta", async () => {
    const adminBox = await box(adminId);
    const before = await read({ cookie: adminCookie });
    // Un progetto del perimetro che non esiste più (`scope_project_ids` non ha chiave esterna).
    await waiting(adminBox.id, null as never, { projectId: null, scopeProjectIds: [randomUUID()] } as never);
    const after = await read({ cookie: adminCookie });
    expect(after.items).toHaveLength(before.items.length);
    expect(after.total).toBe(before.total);
  });

  it("senza sessione: 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/me/waiting-customers" });
    expect(res.statusCode).toBe(401);
  });
});

