import { randomUUID } from "node:crypto";
import { emailMessages, encrypt, googleAccounts, googleWorkspaces, mailDrafts, type Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { GoogleApiError } from "@stubwise/google";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import type { MailComposeClient } from "../services/mail-drafts.js";
import { createUserWithSession } from "../test/fixtures.js";

/**
 * LE BOZZE (area 6, F3, task 3): bozze di Gmail. Le letture non chiamano
 * Google; Salva ed Elimina sì, col token della casella di chi scrive; una
 * bozza cambiata da Gmail non si sovrascrive in silenzio.
 */

const KEY = Buffer.alloc(32, 5);
const GMAIL_MODIFY = "https://www.googleapis.com/auth/gmail.modify";
let testDb: TestDb;
let db: Db;
let app: FastifyInstance;
const calls: { fn: string; input: Record<string, unknown> }[] = [];
let current: { id: string; messageId: string | null; threadId: string | null } | null = null;
let getError: unknown = null;
const fake: MailComposeClient = {
  refreshAccessToken: async () => ({ accessToken: "at-casella", expiresInSeconds: 3600, refreshToken: null, scopes: [], tokenType: "Bearer", idToken: null }),
  createDraft: async (input) => {
    calls.push({ fn: "create", input });
    current = { id: "g-draft-1", messageId: "g-msg-1", threadId: input.threadId ?? null };
    return current;
  },
  updateDraft: async (input) => {
    calls.push({ fn: "update", input });
    current = { id: input.id, messageId: `g-msg-${calls.length}`, threadId: input.threadId ?? null };
    return current;
  },
  getDraft: async (input) => {
    calls.push({ fn: "get", input });
    if (getError) throw getError;
    return current!;
  },
  deleteDraft: async (input) => {
    calls.push({ fn: "delete", input });
  },
};

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  app = buildApp({ db, sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!", encryptionKey: KEY.toString("base64"), mailComposeClient: fake });
}, 120_000);
beforeEach(() => {
  calls.length = 0;
  current = null;
  getError = null;
});
afterEach(async () => {
  const { mailOutgoing } = await import("@stubwise/db");
  await db.delete(mailOutgoing);
  await db.delete(mailDrafts);
  await db.delete(emailMessages);
  await db.delete(googleAccounts);
  await db.delete(googleWorkspaces);
});
afterAll(async () => {
  await app.close();
  await testDb.stop();
});

async function scenario(scopes = ["openid", "email", GMAIL_MODIFY]) {
  const me = await createUserWithSession(app, `ada-${randomUUID()}@acme.com`);
  const other = await createUserWithSession(app, `bruno-${randomUUID()}@acme.com`);
  const [ws] = await db.insert(googleWorkspaces).values({ name: "A", domains: ["acme.com"], clientId: "c", clientSecretEncrypted: encrypt("s", KEY) }).returning();
  const boxEmail = `ada-box-${randomUUID().slice(0, 6)}@acme.com`;
  const [box] = await db
    .insert(googleAccounts)
    .values({ userId: me.id, workspaceId: ws!.id, email: boxEmail, googleSub: randomUUID(), refreshTokenEncrypted: encrypt("r", KEY), scopes })
    .returning();
  const [message] = await db
    .insert(emailMessages)
    .values({
      accountId: box!.id,
      gmailMessageId: "g1",
      threadId: "t1",
      fromAddress: "cliente@x.it",
      fromName: "Cliente",
      toAddresses: [boxEmail, "collega@acme.com"],
      ccAddresses: ["capo@acme.com", boxEmail],
      subject: "Export",
      receivedAt: new Date("2026-11-10T09:00:00.000Z"),
      textExcerpt: "Ci serve l'export.\nGrazie",
      rfcMessageId: "<m1@x.it>",
    })
    .returning();
  return { me, other, box: box!, message: message! };
}

const compose = (headers: { cookie: string }, q: string) => app.inject({ method: "GET", url: `/api/me/mail/drafts/compose?${q}`, headers });
const save = (headers: { cookie: string }, payload: Record<string, unknown>) => app.inject({ method: "PUT", url: "/api/me/mail/drafts", headers, payload });

describe("la bozza di una conversazione: indirizzata dal server, senza chiamare Google", () => {
  it("Rispondi: al mittente, «Re:»; Rispondi a tutti: più to e cc, meno le mie caselle; Inoltra: nessuno, «Fwd:»", async () => {
    const { me, box } = await scenario();
    const reply = (await compose(me.headers, `account=${box.id}&thread=t1&mode=reply`)).json() as { to: { email: string }[]; cc: unknown[]; subject: string; id: null; quote: boolean };
    expect(reply).toMatchObject({ id: null, subject: "Re: Export", quote: true, cc: [] });
    expect(reply.to.map((a) => a.email)).toEqual(["cliente@x.it"]);
    const all = (await compose(me.headers, `account=${box.id}&thread=t1&mode=replyAll`)).json() as { to: { email: string }[]; cc: { email: string }[] };
    expect(all.to.map((a) => a.email)).toEqual(["cliente@x.it", "collega@acme.com"]);
    expect(all.cc.map((a) => a.email)).toEqual(["capo@acme.com"]);
    const fwd = (await compose(me.headers, `account=${box.id}&thread=t1&mode=forward`)).json() as { to: unknown[]; subject: string };
    expect(fwd).toMatchObject({ to: [], subject: "Fwd: Export" });
    expect(calls).toEqual([]);
  });

  it("NEGATIVO: la casella di un altro è 404", async () => {
    const { other, box } = await scenario();
    expect((await compose(other.headers, `account=${box.id}&thread=t1&mode=reply`)).statusCode).toBe(404);
  });
});

describe("salvare ed eliminare una bozza (scritture verso Gmail)", () => {
  it("la prima volta la crea su Gmail nel thread, col token della casella, la risposta e la citazione; la seconda la aggiorna", async () => {
    const { me, box, message } = await scenario();
    const body = { accountId: box.id, threadId: "t1", mode: "reply", replyToMessageId: message.id, to: [{ email: "cliente@x.it", name: "Cliente" }], subject: "Re: Export", body: "Fatto.", quote: true };
    const first = await save(me.headers, body);
    expect(first.statusCode).toBe(200);
    expect(calls[0]!.fn).toBe("create");
    expect(calls[0]!.input).toMatchObject({ accessToken: "at-casella", threadId: "t1" });
    const mime = Buffer.from(String(calls[0]!.input.raw), "base64url").toString("utf8");
    expect(mime).toContain("To: \"Cliente\" <cliente@x.it>");
    expect(mime).toContain("In-Reply-To: <m1@x.it>");
    const text = Buffer.from(mime.split("\r\n\r\n").slice(1).join("").replace(/\r\n/g, ""), "base64").toString("utf8");
    expect(text).toContain("Fatto.");
    expect(text).toContain("> Ci serve l'export.");
    const second = await save(me.headers, { ...body, body: "Fatto, davvero." });
    expect(second.statusCode).toBe(200);
    expect(calls.map((c) => c.fn)).toEqual(["create", "get", "update"]);
    const list = (await app.inject({ method: "GET", url: "/api/me/mail/drafts", headers: me.headers })).json() as { items: { body: string; to: unknown[] }[] };
    expect(list.items).toHaveLength(1);
    expect(list.items[0]!.body).toBe("Fatto, davvero.");
  });

  it("una bozza modificata da Gmail nel frattempo: 409 draft_changed, e non la si sovrascrive", async () => {
    const { me, box } = await scenario();
    const body = { accountId: box.id, threadId: null, mode: "new", to: [{ email: "x@y.it" }], subject: "Ciao", body: "a" };
    await save(me.headers, body);
    current = { id: "g-draft-1", messageId: "cambiata-da-gmail", threadId: null };
    const res = await save(me.headers, { ...body, body: "b" });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("draft_changed");
    expect(calls.map((c) => c.fn)).toEqual(["create", "get"]);
  });

  it("una bozza sparita da Gmail (eliminata da lì) si ricrea", async () => {
    const { me, box } = await scenario();
    const body = { accountId: box.id, threadId: null, mode: "new", to: [{ email: "x@y.it" }], subject: "Ciao", body: "a" };
    await save(me.headers, body);
    getError = new GoogleApiError({ api: "gmail.drafts.get", status: 404, code: "not_found", reason: "notFound" });
    expect((await save(me.headers, body)).statusCode).toBe(200);
    expect(calls.map((c) => c.fn)).toEqual(["create", "get", "create"]);
  });

  it("NEGATIVO: senza gmail.modify 409 google_scope_missing, la casella di un altro 404, un messaggio di un'altra casella 404 — e nessuna chiamata", async () => {
    const legacy = await scenario(["openid", "email", "https://www.googleapis.com/auth/gmail.readonly"]);
    const scope = await save(legacy.me.headers, { accountId: legacy.box.id, threadId: null, mode: "new", subject: "x", body: "y" });
    expect(scope.statusCode).toBe(409);
    expect(scope.json()).toMatchObject({ code: "google_scope_missing", missing: expect.arrayContaining([GMAIL_MODIFY]) });
    const s = await scenario();
    expect((await save(s.other.headers, { accountId: s.box.id, threadId: null, mode: "new", subject: "x", body: "y" })).statusCode).toBe(404);
    expect((await save(s.me.headers, { accountId: s.box.id, threadId: "t1", mode: "reply", replyToMessageId: legacy.message.id, subject: "x", body: "y" })).statusCode).toBe(404);
    expect(calls).toEqual([]);
  });

  it("eliminare: su Gmail e qui; la bozza di un altro è 404 senza chiamate", async () => {
    const { me, other, box } = await scenario();
    const saved = (await save(me.headers, { accountId: box.id, threadId: null, mode: "new", subject: "x", body: "y" })).json() as { id: string };
    calls.length = 0;
    expect((await app.inject({ method: "DELETE", url: `/api/me/mail/drafts/${saved.id}`, headers: other.headers })).statusCode).toBe(404);
    expect(calls).toEqual([]);
    expect((await app.inject({ method: "DELETE", url: `/api/me/mail/drafts/${saved.id}`, headers: me.headers })).statusCode).toBe(204);
    expect(calls.map((c) => c.fn)).toEqual(["delete"]);
    expect(await db.select().from(mailDrafts)).toEqual([]);
  });
});

describe("Invia, Annulla, Riprova, Elimina (D6: il server trattiene 10 s)", () => {
  async function savedDraft() {
    const s = await scenario();
    const draft = (await save(s.me.headers, { accountId: s.box.id, threadId: "t1", mode: "reply", replyToMessageId: s.message.id, to: [{ email: "cliente@x.it" }], subject: "Re: Export", body: "Fatto." })).json() as { id: string };
    return { ...s, draftId: draft.id };
  }
  const post = (headers: { cookie: string }, url: string) => app.inject({ method: "POST", url, headers, payload: {} });

  it("Invia: 202 con undoUntil fra ~10 s, la bozza esce dall'elenco, nessuna chiamata a Google (la fa il worker allo scadere)", async () => {
    const { me, draftId } = await savedDraft();
    calls.length = 0;
    const res = await post(me.headers, `/api/me/mail/drafts/${draftId}/send`);
    expect(res.statusCode).toBe(202);
    const out = res.json() as { messageId: string; state: string; undoUntil: string; threadId: string };
    expect(out.state).toBe("queued");
    const wait = new Date(out.undoUntil).getTime() - Date.now();
    expect(wait).toBeGreaterThan(5_000);
    expect(wait).toBeLessThan(70_000);
    expect(((await app.inject({ method: "GET", url: "/api/me/mail/drafts", headers: me.headers })).json() as { items: unknown[] }).items).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("un doppio Invia dà LO STESSO invio, non due", async () => {
    const { me, draftId } = await savedDraft();
    const a = (await post(me.headers, `/api/me/mail/drafts/${draftId}/send`)).json() as { messageId: string };
    const b = (await post(me.headers, `/api/me/mail/drafts/${draftId}/send`)).json() as { messageId: string };
    expect(b.messageId).toBe(a.messageId);
    const { mailOutgoing } = await import("@stubwise/db");
    expect(await db.select().from(mailOutgoing)).toHaveLength(1);
  });

  it("Annulla nei 10 s: la bozza torna; dopo, 409 too_late", async () => {
    const { me, draftId } = await savedDraft();
    const sent = (await post(me.headers, `/api/me/mail/drafts/${draftId}/send`)).json() as { messageId: string };
    const undo = await post(me.headers, `/api/me/mail/outgoing/${sent.messageId}/undo`);
    expect(undo.statusCode).toBe(200);
    expect((undo.json() as { draft: { id: string; body: string } }).draft).toMatchObject({ id: draftId, body: "Fatto." });
    // Di nuovo in coda, poi «scaduto»: Annulla non vale più.
    const again = (await post(me.headers, `/api/me/mail/drafts/${draftId}/send`)).json() as { messageId: string };
    const { mailOutgoing } = await import("@stubwise/db");
    const { eq, sql } = await import("drizzle-orm");
    await db.update(mailOutgoing).set({ sendAt: sql`now() - interval '1 second'` }).where(eq(mailOutgoing.id, again.messageId));
    const late = await post(me.headers, `/api/me/mail/outgoing/${again.messageId}/undo`);
    expect(late.statusCode).toBe(409);
    expect((late.json() as { code: string }).code).toBe("too_late");
  });

  it("Annulla quando nel frattempo ho scritto un'altra bozza nella stessa conversazione: 409 draft_slot_taken *(O)*", async () => {
    const { me, box, message, draftId } = await savedDraft();
    const sent = (await post(me.headers, `/api/me/mail/drafts/${draftId}/send`)).json() as { messageId: string };
    current = null;
    await save(me.headers, { accountId: box.id, threadId: "t1", mode: "reply", replyToMessageId: message.id, subject: "Re: Export", body: "Un'altra." });
    expect((await post(me.headers, `/api/me/mail/outgoing/${sent.messageId}/undo`)).json()).toMatchObject({ code: "draft_slot_taken" });
  });

  it("Riprova ed Elimina valgono SOLO su un invio fallito; Elimina riporta la bozza", async () => {
    const { me, draftId } = await savedDraft();
    const sent = (await post(me.headers, `/api/me/mail/drafts/${draftId}/send`)).json() as { messageId: string };
    expect((await post(me.headers, `/api/me/mail/outgoing/${sent.messageId}/retry`)).json()).toMatchObject({ code: "not_failed" });
    const { mailOutgoing } = await import("@stubwise/db");
    const { eq } = await import("drizzle-orm");
    await db.update(mailOutgoing).set({ state: "failed", error: "quota" }).where(eq(mailOutgoing.id, sent.messageId));
    const retried = await post(me.headers, `/api/me/mail/outgoing/${sent.messageId}/retry`);
    expect(retried.statusCode).toBe(202);
    expect((retried.json() as { state: string }).state).toBe("queued");
    await db.update(mailOutgoing).set({ state: "failed", error: "quota" }).where(eq(mailOutgoing.id, sent.messageId));
    const discarded = await post(me.headers, `/api/me/mail/outgoing/${sent.messageId}/discard`);
    expect((discarded.json() as { draft: { id: string } }).draft.id).toBe(draftId);
  });

  it("NEGATIVO: l'invio e la bozza di un altro sono 404", async () => {
    const { me, other, draftId } = await savedDraft();
    expect((await post(other.headers, `/api/me/mail/drafts/${draftId}/send`)).statusCode).toBe(404);
    const sent = (await post(me.headers, `/api/me/mail/drafts/${draftId}/send`)).json() as { messageId: string };
    expect((await post(other.headers, `/api/me/mail/outgoing/${sent.messageId}/undo`)).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/me/mail/outgoing/${sent.messageId}`, headers: other.headers })).statusCode).toBe(404);
  });
});
