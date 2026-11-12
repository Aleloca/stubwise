import { randomUUID } from "node:crypto";
import { emailMessages, encrypt, googleAccounts, googleWorkspaces, issueChatToolToken, mailDrafts, mailOutgoing } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import type { MailComposeClient } from "../services/mail-drafts.js";
import { createUserWithSession, seedUsers } from "../test/fixtures.js";

// `fillMailBody` (area 6, F3, task 7): Claude PROPONE il corpo di un'email;
// è SEMPRE B, e la conferma salva il testo nella bozza Gmail di chi conferma
// (la sua casella, la sua conversazione). Non manda MAI: Invia resta un gesto.

const KEY = Buffer.alloc(32, 7);
const GMAIL_MODIFY = "https://www.googleapis.com/auth/gmail.modify";
let t: TestDb;
let app: ReturnType<typeof buildApp>;
const gmail: { fn: string; raw?: string; threadId?: string | null }[] = [];
const fake: MailComposeClient = {
  refreshAccessToken: async () => ({ accessToken: "at", expiresInSeconds: 3600, refreshToken: null, scopes: [], tokenType: "Bearer", idToken: null }),
  createDraft: async (input) => {
    gmail.push({ fn: "create", raw: input.raw, threadId: input.threadId ?? null });
    return { id: "gd-1", messageId: "gm-1", threadId: input.threadId ?? null };
  },
  updateDraft: async (input) => {
    gmail.push({ fn: "update", raw: input.raw });
    return { id: input.id, messageId: `gm-${gmail.length}`, threadId: input.threadId ?? null };
  },
  getDraft: async (input) => ({ id: input.id, messageId: "gm-1", threadId: null }),
  deleteDraft: async () => undefined,
  getSendAsSignature: async () => null,
};

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40), encryptionKey: KEY.toString("base64"), mailComposeClient: fake });
  await seedUsers(app);
}, 120_000);
beforeEach(() => {
  gmail.length = 0;
});
afterAll(async () => {
  await app.close();
  await t.stop();
});

async function scenario() {
  const me = await createUserWithSession(app, `ada-${randomUUID()}@acme.com`);
  const other = await createUserWithSession(app, `bruno-${randomUUID()}@acme.com`);
  const [ws] = await t.db.insert(googleWorkspaces).values({ name: "A", domains: ["acme.com"], clientId: "c", clientSecretEncrypted: encrypt("s", KEY) }).returning();
  const [box] = await t.db
    .insert(googleAccounts)
    .values({ userId: me.id, workspaceId: ws!.id, email: `box-${randomUUID().slice(0, 6)}@acme.com`, googleSub: randomUUID(), refreshTokenEncrypted: encrypt("r", KEY), scopes: ["openid", "email", GMAIL_MODIFY], signatureFetchedAt: new Date() })
    .returning();
  const threadId = `t-${randomUUID()}`;
  const [message] = await t.db
    .insert(emailMessages)
    .values({ accountId: box!.id, gmailMessageId: `g-${randomUUID()}`, threadId, fromAddress: "cliente@x.it", fromName: "Cliente", toAddresses: [box!.email], subject: "Export", receivedAt: new Date(), textExcerpt: "Serve l'export.", rfcMessageId: `<${randomUUID()}@x.it>` })
    .returning();
  const conv = await app.inject({ method: "POST", url: "/api/claude/conversations", headers: { cookie: me.headers.cookie }, payload: {} });
  const sessionId = (conv.json() as { id: string }).id;
  const tok = await issueChatToolToken(t.db, { sessionId, userId: me.id, ttlMs: 60_000 });
  return { me, other, box: box!, threadId, message: message!, sessionId, tok };
}
const propose = (sessionId: string, tok: string, actions: unknown[]) =>
  app.inject({ method: "POST", url: `/api/claude/conversations/${sessionId}/proposals`, headers: { authorization: `Bearer ${tok}` }, payload: { toolUseId: `tu-${randomUUID()}`, actions } });
const bodyOf = (raw: string) => {
  const mime = Buffer.from(raw, "base64url").toString("utf8");
  return Buffer.from(mime.split("\r\n\r\n").slice(1).join("").replace(/\r\n/g, ""), "base64").toString("utf8");
};

describe("fillMailBody", () => {
  it("è SEMPRE B: la proposta aspetta, e fino alla conferma Gmail non si tocca (nemmeno a secco)", async () => {
    const s = await scenario();
    const res = await propose(s.sessionId, s.tok, [{ fn: "fillMailBody", args: { accountId: s.box.id, threadId: s.threadId, mode: "reply", text: "Ciao, arriva lunedì." } }]);
    expect(res.json()).toMatchObject({ status: "awaiting_confirmation" });
    expect(gmail).toEqual([]);
    expect(await t.db.select().from(mailDrafts).where(eq(mailDrafts.userId, s.me.id))).toEqual([]);
  });

  it("la conferma salva il testo nella bozza Gmail di chi conferma, già indirizzata, nel thread; nessun invio", async () => {
    const s = await scenario();
    const res = await propose(s.sessionId, s.tok, [{ fn: "fillMailBody", args: { accountId: s.box.id, threadId: s.threadId, mode: "reply", text: "Ciao, arriva lunedì." } }]);
    const proposalId = (res.json() as { proposalId: string }).proposalId;
    const ok = await app.inject({ method: "POST", url: `/api/claude/proposals/${proposalId}/confirm`, headers: { cookie: s.me.headers.cookie }, payload: {} });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(gmail.map((g) => g.fn)).toEqual(["create"]);
    expect(gmail[0]!.threadId).toBe(s.threadId);
    expect(bodyOf(gmail[0]!.raw!)).toContain("Ciao, arriva lunedì.");
    const [draft] = await t.db.select().from(mailDrafts).where(eq(mailDrafts.userId, s.me.id));
    expect(draft).toMatchObject({ body: "Ciao, arriva lunedì.", mode: "reply", threadId: s.threadId, replyToMessageId: s.message.id });
    expect(draft!.toAddresses.map((a) => a.email)).toEqual(["cliente@x.it"]);
    expect(await t.db.select().from(mailOutgoing).where(eq(mailOutgoing.userId, s.me.id))).toEqual([]);
  });

  it("una bozza che c'è già: si sostituisce SOLO il corpo, destinatari e oggetto restano", async () => {
    const s = await scenario();
    await app.inject({ method: "PUT", url: "/api/me/mail/drafts", headers: { cookie: s.me.headers.cookie }, payload: { accountId: s.box.id, threadId: s.threadId, mode: "reply", replyToMessageId: s.message.id, to: [{ email: "altro@x.it" }], subject: "Re: Export (v2)", body: "vecchio" } });
    gmail.length = 0;
    const res = await propose(s.sessionId, s.tok, [{ fn: "fillMailBody", args: { accountId: s.box.id, threadId: s.threadId, mode: "reply", text: "nuovo" } }]);
    const proposalId = (res.json() as { proposalId: string }).proposalId;
    await app.inject({ method: "POST", url: `/api/claude/proposals/${proposalId}/confirm`, headers: { cookie: s.me.headers.cookie }, payload: {} });
    const [draft] = await t.db.select().from(mailDrafts).where(eq(mailDrafts.userId, s.me.id));
    expect(draft).toMatchObject({ body: "nuovo", subject: "Re: Export (v2)" });
    expect(draft!.toAddresses.map((a) => a.email)).toEqual(["altro@x.it"]);
  });

  it("NEGATIVO: la casella di un altro (o una conversazione che non c'è) è rifiutata alla proposta, e Gmail non si tocca", async () => {
    const s = await scenario();
    const theirConv = await app.inject({ method: "POST", url: "/api/claude/conversations", headers: { cookie: s.other.headers.cookie }, payload: {} });
    const theirSid = (theirConv.json() as { id: string }).id;
    const theirTok = await issueChatToolToken(t.db, { sessionId: theirSid, userId: s.other.id, ttlMs: 60_000 });
    const foreign = await propose(theirSid, theirTok, [{ fn: "fillMailBody", args: { accountId: s.box.id, threadId: s.threadId, mode: "reply", text: "x" } }]);
    expect((foreign.json() as { status?: string }).status).not.toBe("awaiting_confirmation");
    const missing = await propose(s.sessionId, s.tok, [{ fn: "fillMailBody", args: { accountId: s.box.id, threadId: "non-esiste", mode: "reply", text: "x" } }]);
    expect((missing.json() as { status?: string }).status).not.toBe("awaiting_confirmation");
    expect(gmail).toEqual([]);
  });
});
