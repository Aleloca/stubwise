import { randomUUID } from "node:crypto";
import { driveFiles, emailMessages, encrypt, googleAccounts, googleWorkspaces, mailDraftAttachments, mailDrafts, projects, type Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { GoogleApiError } from "@stubwise/google";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import type { MailComposeClient } from "../services/mail-drafts.js";
import type { ObjectStorage } from "../storage/index.js";
import { addMember, createUserWithSession } from "../test/fixtures.js";

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
const sigCalls: string[] = [];
let signature: string | null = "Ada Lovelace\nAcme";
let sigError: unknown = null;
const objects = new Map<string, Buffer>();
let storage: ObjectStorage | null = null;
const memoryStorage: ObjectStorage = {
  putObject: async (key, body) => void objects.set(key, body),
  putObjectStream: async () => {
    throw new Error("non usato");
  },
  copyObject: async () => {
    throw new Error("non usato");
  },
  getSignedDownloadUrl: async () => "https://x",
  deleteObject: async (key) => void objects.delete(key),
  getObjectBytes: async (key, max) => {
    const b = objects.get(key);
    if (!b) throw new Error("missing");
    if (b.length > max) throw new Error("too big");
    return b;
  },
};
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
  // La firma si traccia a parte: le sequenze di `calls` restano quelle delle bozze.
  getSendAsSignature: async (input) => {
    sigCalls.push(input.sendAsEmail);
    if (sigError) throw sigError;
    return signature;
  },
};

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  app = buildApp({
    db,
    sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!",
    encryptionKey: KEY.toString("base64"),
    mailComposeClient: fake,
    storageFactory: async () => storage,
  });
}, 120_000);
beforeEach(() => {
  calls.length = 0;
  current = null;
  getError = null;
  sigCalls.length = 0;
  signature = "Ada Lovelace\nAcme";
  sigError = null;
  objects.clear();
  storage = memoryStorage;
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
    .values({ userId: me.id, workspaceId: ws!.id, email: boxEmail, googleSub: randomUUID(), refreshTokenEncrypted: encrypt("r", KEY), scopes, signatureText: "Ada (copia)", signatureFetchedAt: new Date() })
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

  it("«Tieni la mia» (overwrite: true) dopo un draft_changed: la si scrive sopra quella di Gmail, e il salvataggio dopo torna normale", async () => {
    const { me, box } = await scenario();
    const body = { accountId: box.id, threadId: null, mode: "new", to: [{ email: "x@y.it" }], subject: "Ciao", body: "a" };
    await save(me.headers, body);
    current = { id: "g-draft-1", messageId: "cambiata-da-gmail", threadId: null };
    expect((await save(me.headers, { ...body, body: "b" })).statusCode).toBe(409);
    calls.length = 0;
    const kept = await save(me.headers, { ...body, body: "b", overwrite: true });
    expect(kept.statusCode).toBe(200);
    expect(calls.map((c) => c.fn)).toEqual(["get", "update"]);
    expect((kept.json() as { body: string }).body).toBe("b");
    // La versione vista ora è la nostra: il prossimo salvataggio non è in conflitto.
    expect((await save(me.headers, { ...body, body: "c" })).statusCode).toBe(200);
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
    const { eq } = await import("drizzle-orm");
    // Il worker l'ha già reclamata (la corsa vera): Annulla non vale più.
    await db.update(mailOutgoing).set({ state: "sending" }).where(eq(mailOutgoing.id, again.messageId));
    const late = await post(me.headers, `/api/me/mail/outgoing/${again.messageId}/undo`);
    expect(late.statusCode).toBe(409);
    expect((late.json() as { code: string }).code).toBe("too_late");
    const [still] = await db.select().from(mailOutgoing).where(eq(mailOutgoing.id, again.messageId));
    expect(still!.state).toBe("sending");
  });

  it("Annulla a 9 s con un'altra bozza nello stesso slot: l'invio si FERMA comunque, e il contenuto torna NON salvato (correzione di 46)", async () => {
    const { me, box, message, draftId } = await savedDraft();
    const sent = (await post(me.headers, `/api/me/mail/drafts/${draftId}/send`)).json() as { messageId: string };
    current = null;
    const other = (await save(me.headers, { accountId: box.id, threadId: "t1", mode: "reply", replyToMessageId: message.id, subject: "Re: Export", body: "Un'altra." })).json() as { id: string };
    const { mailOutgoing } = await import("@stubwise/db");
    const { eq, sql } = await import("drizzle-orm");
    // 9 s dopo Invia: manca un secondo.
    await db.update(mailOutgoing).set({ sendAt: sql`now() + interval '1 second'` }).where(eq(mailOutgoing.id, sent.messageId));
    calls.length = 0;
    const undo = await post(me.headers, `/api/me/mail/outgoing/${sent.messageId}/undo`);
    expect(undo.statusCode).toBe(200);
    const out = undo.json() as { unsaved: boolean; draft: { id: string | null; body: string; to: { email: string }[]; subject: string; mode: string; threadId: string } };
    expect(out.unsaved).toBe(true);
    expect(out.draft).toMatchObject({ id: null, body: "Fatto.", subject: "Re: Export", mode: "reply", threadId: "t1" });
    expect(out.draft.to.map((a) => a.email)).toEqual(["cliente@x.it"]);
    // Nessuna email: l'invio è annullato, e il worker prende solo le righe `queued`.
    const [row] = await db.select().from(mailOutgoing).where(eq(mailOutgoing.id, sent.messageId));
    expect(row!.state).toBe("cancelled");
    // L'altra bozza resta nello slot, intatta; nessuna scrittura su Gmail.
    const drafts = ((await app.inject({ method: "GET", url: "/api/me/mail/drafts", headers: me.headers })).json() as { items: { id: string; body: string }[] }).items;
    expect(drafts).toEqual([expect.objectContaining({ id: other.id, body: "Un'altra." })]);
    expect(calls).toEqual([]);
    // La copia annullata non resta in Stubwise (su Gmail sì, fra le bozze).
    expect(await db.select().from(mailDrafts).where(eq(mailDrafts.id, draftId))).toEqual([]);
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

  it("review F3, punto 4: Annulla decide sullo STATO sotto il lock, non sull'orologio — `queued` oltre send_at (orologi sfasati) si annulla ancora", async () => {
    const { me, draftId } = await savedDraft();
    const sent = (await post(me.headers, `/api/me/mail/drafts/${draftId}/send`)).json() as { messageId: string };
    const { mailOutgoing } = await import("@stubwise/db");
    const { eq, sql } = await import("drizzle-orm");
    await db.update(mailOutgoing).set({ sendAt: sql`now() - interval '1 second'` }).where(eq(mailOutgoing.id, sent.messageId));
    const undo = await post(me.headers, `/api/me/mail/outgoing/${sent.messageId}/undo`);
    expect(undo.statusCode).toBe(200);
    expect((await db.select().from(mailOutgoing).where(eq(mailOutgoing.id, sent.messageId)))[0]!.state).toBe("cancelled");
  });

  it("review F3, punto 2: `sent_unrecorded` (Gmail l'ha mandata) — Riprova ed Elimina sono rifiutati, niente doppioni", async () => {
    const { me, draftId } = await savedDraft();
    const sent = (await post(me.headers, `/api/me/mail/drafts/${draftId}/send`)).json() as { messageId: string };
    const { mailOutgoing } = await import("@stubwise/db");
    const { eq } = await import("drizzle-orm");
    await db.update(mailOutgoing).set({ state: "failed", error: "sent_unrecorded" }).where(eq(mailOutgoing.id, sent.messageId));
    const retry = await post(me.headers, `/api/me/mail/outgoing/${sent.messageId}/retry`);
    expect(retry.statusCode).toBe(409);
    expect((retry.json() as { code: string }).code).toBe("sent_unrecorded");
    const discard = await post(me.headers, `/api/me/mail/outgoing/${sent.messageId}/discard`);
    expect((discard.json() as { code: string }).code).toBe("sent_unrecorded");
    expect((await db.select().from(mailOutgoing).where(eq(mailOutgoing.id, sent.messageId)))[0]).toMatchObject({ state: "failed", error: "sent_unrecorded" });
  });

  it("review F3, punto 3: Riprova rifà i controlli e trattiene 10 s come Invia, con un Annulla che funziona", async () => {
    const { me, box, draftId } = await savedDraft();
    const sent = (await post(me.headers, `/api/me/mail/drafts/${draftId}/send`)).json() as { messageId: string };
    const { mailOutgoing } = await import("@stubwise/db");
    const { eq } = await import("drizzle-orm");
    await db.update(mailOutgoing).set({ state: "failed", error: "quota" }).where(eq(mailOutgoing.id, sent.messageId));
    // Nel frattempo la casella è stata disabilitata: Riprova non parte.
    await db.update(googleAccounts).set({ disabledAt: new Date(), disabledReason: "revoked" }).where(eq(googleAccounts.id, box.id));
    const refused = await post(me.headers, `/api/me/mail/outgoing/${sent.messageId}/retry`);
    expect((refused.json() as { code: string }).code).toBe("account_disabled");
    expect((await db.select().from(mailOutgoing).where(eq(mailOutgoing.id, sent.messageId)))[0]!.state).toBe("failed");
    await db.update(googleAccounts).set({ disabledAt: null, disabledReason: null }).where(eq(googleAccounts.id, box.id));
    const retried = (await post(me.headers, `/api/me/mail/outgoing/${sent.messageId}/retry`)).json() as { undoUntil: string; state: string };
    expect(retried.state).toBe("queued");
    expect(new Date(retried.undoUntil).getTime() - Date.now()).toBeGreaterThan(5_000);
    expect((await post(me.headers, `/api/me/mail/outgoing/${sent.messageId}/undo`)).statusCode).toBe(200);
  });

  it("review F3, punto 5: Invia su una bozza il cui ultimo invio è FALLITO restituisce quello, senza un secondo invio", async () => {
    const { me, draftId } = await savedDraft();
    const sent = (await post(me.headers, `/api/me/mail/drafts/${draftId}/send`)).json() as { messageId: string };
    const { mailOutgoing } = await import("@stubwise/db");
    const { eq } = await import("drizzle-orm");
    await db.update(mailOutgoing).set({ state: "failed", error: "quota" }).where(eq(mailOutgoing.id, sent.messageId));
    const again = (await post(me.headers, `/api/me/mail/drafts/${draftId}/send`)).json() as { messageId: string; state: string };
    expect(again).toMatchObject({ messageId: sent.messageId, state: "failed" });
    expect(await db.select().from(mailOutgoing).where(eq(mailOutgoing.draftId, draftId))).toHaveLength(1);
  });

  it("NEGATIVO: l'invio e la bozza di un altro sono 404", async () => {
    const { me, other, draftId } = await savedDraft();
    expect((await post(other.headers, `/api/me/mail/drafts/${draftId}/send`)).statusCode).toBe(404);
    const sent = (await post(me.headers, `/api/me/mail/drafts/${draftId}/send`)).json() as { messageId: string };
    expect((await post(other.headers, `/api/me/mail/outgoing/${sent.messageId}/undo`)).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/me/mail/outgoing/${sent.messageId}`, headers: other.headers })).statusCode).toBe(404);
  });
});

describe("l'invio nel thread (delivery, solo di chi scrive)", () => {
  it("l'invio in coda compare nel thread di chi scrive come `sending`, col testo; a un altro no", async () => {
    const s = await scenario();
    const draft = (await save(s.me.headers, { accountId: s.box.id, threadId: "t1", mode: "reply", replyToMessageId: s.message.id, to: [{ email: "cliente@x.it" }], subject: "Re: Export", body: "Eccolo." })).json() as { id: string };
    const sent = (await app.inject({ method: "POST", url: `/api/me/mail/drafts/${draft.id}/send`, headers: s.me.headers, payload: {} })).json() as { messageId: string };
    const detail = (await app.inject({ method: "GET", url: `/api/me/mail/threads/t1?account=${s.box.id}`, headers: s.me.headers })).json() as { messages: { id: string; delivery: { state: string } | null; textExcerpt: string | null }[] };
    const mine = detail.messages.find((m) => m.id === sent.messageId);
    expect(mine).toMatchObject({ delivery: { state: "sending" }, textExcerpt: "Eccolo." });
    expect(detail.messages.find((m) => m.id === s.message.id)?.delivery).toBeNull();
  });
});

describe("i controlli PRIMA di accodare: subito sul bottone Invia, la bozza resta lì", () => {
  async function draftWith(overrides: Record<string, unknown>) {
    const s = await scenario();
    const d = (await save(s.me.headers, { accountId: s.box.id, threadId: null, mode: "new", subject: "x", body: "y", to: [{ email: "ok@x.it" }], ...overrides })).json() as { id: string };
    return { ...s, draftId: d.id };
  }
  const send = (headers: { cookie: string }, id: string) => app.inject({ method: "POST", url: `/api/me/mail/drafts/${id}/send`, headers, payload: {} });
  async function nothingQueued() {
    const { mailOutgoing } = await import("@stubwise/db");
    expect(await db.select().from(mailOutgoing)).toEqual([]);
  }

  it("senza destinatari: 400 invalid_recipients", async () => {
    const { me, draftId } = await draftWith({ to: [] });
    const res = await send(me.headers, draftId);
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe("invalid_recipients");
    await nothingQueued();
  });

  it("un indirizzo malformato: 400 invalid_address, con l'indirizzo", async () => {
    const { me, draftId } = await draftWith({ to: [{ email: "ok@x.it" }], cc: [{ email: "non-un-indirizzo" }] });
    expect((await send(me.headers, draftId)).json()).toMatchObject({ code: "invalid_address", address: "non-un-indirizzo" });
    await nothingQueued();
  });

  it("troppi allegati, troppo grandi, uno sparito: 400 / 400 / 409", async () => {
    const { me, draftId } = await draftWith({});
    const { mailDraftAttachments } = await import("@stubwise/db");
    const { eq } = await import("drizzle-orm");
    await db.insert(mailDraftAttachments).values(Array.from({ length: 11 }, (_, i) => ({ draftId, name: `f${i}`, sizeBytes: 1, mimeType: "text/plain", storageKey: `mail/${i}` })));
    expect((await send(me.headers, draftId)).json()).toMatchObject({ code: "too_many_attachments" });
    await db.delete(mailDraftAttachments).where(eq(mailDraftAttachments.draftId, draftId));
    await db.insert(mailDraftAttachments).values({ draftId, name: "big", sizeBytes: 26 * 1024 * 1024, mimeType: "application/pdf", storageKey: "mail/big" });
    expect((await send(me.headers, draftId)).json()).toMatchObject({ code: "too_large" });
    await db.delete(mailDraftAttachments).where(eq(mailDraftAttachments.draftId, draftId));
    await db.insert(mailDraftAttachments).values({ draftId, name: "via", sizeBytes: 10, mimeType: "application/pdf" });
    const gone = await send(me.headers, draftId);
    expect(gone.statusCode).toBe(409);
    expect((gone.json() as { code: string }).code).toBe("attachment_unavailable");
    await nothingQueued();
  });

  it("la casella scaduta o senza gmail.modify: 409", async () => {
    const { me, box, draftId } = await draftWith({});
    const { eq } = await import("drizzle-orm");
    await db.update(googleAccounts).set({ scopes: ["openid"] }).where(eq(googleAccounts.id, box.id));
    expect((await send(me.headers, draftId)).json()).toMatchObject({ code: "google_scope_missing" });
    await db.update(googleAccounts).set({ disabledAt: new Date(), disabledReason: "revoked" }).where(eq(googleAccounts.id, box.id));
    expect((await send(me.headers, draftId)).json()).toMatchObject({ code: "account_disabled" });
    await nothingQueued();
    // La bozza è ancora lì.
    expect(((await app.inject({ method: "GET", url: "/api/me/mail/drafts", headers: me.headers })).json() as { items: unknown[] }).items).toHaveLength(1);
  });
});

describe("gli allegati di una bozza: nel MIME a ogni salvataggio, dal disco o dal Drive", () => {
  const BOUNDARY = "----stubwisemailboundary";
  async function draftOf() {
    const s = await scenario();
    const d = (await save(s.me.headers, { accountId: s.box.id, threadId: null, mode: "new", subject: "x", body: "y", to: [{ email: "ok@x.it" }] })).json() as { id: string };
    calls.length = 0;
    return { ...s, draftId: d.id };
  }
  const upload = (headers: { cookie: string }, id: string, name: string, content: Buffer) =>
    app.inject({
      method: "POST",
      url: `/api/me/mail/drafts/${id}/attachments`,
      headers: { cookie: headers.cookie, "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
      payload: Buffer.concat([
        Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/plain\r\n\r\n`),
        content,
        Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
      ]),
    });
  const lastMime = () => Buffer.from(String(calls.filter((c) => c.fn === "update").at(-1)!.input.raw), "base64url").toString("utf8");
  async function driveFile(userId: string | null, opts: { deleted?: boolean } = {}) {
    const [project] = await db.insert(projects).values({ name: "Audin", slug: `audin-${randomUUID().slice(0, 6)}`, ingestionKey: randomUUID() }).returning();
    if (userId) await addMember(app, project!.id, userId, "viewer");
    const key = `drive/${project!.id}/specifica.pdf`;
    objects.set(key, Buffer.from("PDF-DEL-DRIVE"));
    const [file] = await db
      .insert(driveFiles)
      .values({ projectId: project!.id, number: 1, name: "specifica.pdf", mime: "application/pdf", type: "pdf", sizeBytes: 13, storageKey: key, deletedAt: opts.deleted ? new Date() : null })
      .returning();
    return file!;
  }
  const attachDrive = (headers: { cookie: string }, id: string, driveFileId: string) =>
    app.inject({ method: "POST", url: `/api/me/mail/drafts/${id}/attachments/drive`, headers, payload: { driveFileId } });

  it("dal disco: va nello storage sotto mail/<bozza>/, la bozza su Gmail si riscrive COL file, e la risposta lo elenca", async () => {
    const { me, draftId } = await draftOf();
    const res = await upload(me.headers, draftId, "nota.txt", Buffer.from("CONTENUTO-ALLEGATO"));
    expect(res.statusCode).toBe(200);
    expect((res.json() as { attachments: { name: string }[] }).attachments.map((a) => a.name)).toEqual(["nota.txt"]);
    expect([...objects.keys()].every((k) => k.startsWith(`mail/${draftId}/`))).toBe(true);
    const mime = lastMime();
    expect(mime).toContain('filename="nota.txt"');
    expect(mime).toContain(Buffer.from("CONTENUTO-ALLEGATO").toString("base64"));
    // Un salvataggio successivo del testo tiene l'allegato.
    const { box } = { box: (await db.select().from(googleAccounts))[0]! };
    await save(me.headers, { accountId: box.id, threadId: null, mode: "new", subject: "x", body: "z", to: [{ email: "ok@x.it" }] });
    expect(lastMime()).toContain('filename="nota.txt"');
  });

  it("dal Drive: un file del progetto che vedo entra come copia, letto dal suo oggetto", async () => {
    const { me, draftId } = await draftOf();
    const file = await driveFile(me.id);
    const res = await attachDrive(me.headers, draftId, file.id);
    expect(res.statusCode).toBe(200);
    expect(lastMime()).toContain(Buffer.from("PDF-DEL-DRIVE").toString("base64"));
    const [row] = await db.select().from(mailDraftAttachments);
    expect(row).toMatchObject({ driveFileId: file.id, storageKey: null });
  });

  it("NEGATIVO: un file del Drive di un progetto che NON vedo (o eliminato) è 409 attachment_unavailable, e Gmail non si tocca", async () => {
    const { me, draftId } = await draftOf();
    const foreign = await driveFile(null);
    const res = await attachDrive(me.headers, draftId, foreign.id);
    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("attachment_unavailable");
    const gone = await driveFile(me.id, { deleted: true });
    expect((await attachDrive(me.headers, draftId, gone.id)).statusCode).toBe(409);
    expect(calls).toEqual([]);
    expect(await db.select().from(mailDraftAttachments)).toEqual([]);
  });

  it("NEGATIVO: perso l'accesso al progetto DOPO aver allegato, il salvataggio dopo è 409 attachment_unavailable", async () => {
    const { me, box, draftId } = await draftOf();
    const file = await driveFile(me.id);
    await attachDrive(me.headers, draftId, file.id);
    const { projectMembers } = await import("@stubwise/db");
    const { eq } = await import("drizzle-orm");
    await db.delete(projectMembers).where(eq(projectMembers.projectId, file.projectId));
    calls.length = 0;
    const res = await save(me.headers, { accountId: box.id, threadId: null, mode: "new", subject: "x", body: "z", to: [{ email: "ok@x.it" }] });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("attachment_unavailable");
    expect(calls.filter((c) => c.fn === "update")).toEqual([]);
  });

  it("NEGATIVO: un file del Drive eliminato DOPO averlo allegato: il salvataggio dopo è 409 attachment_unavailable", async () => {
    const { me, box, draftId } = await draftOf();
    const file = await driveFile(me.id);
    await attachDrive(me.headers, draftId, file.id);
    const { eq } = await import("drizzle-orm");
    await db.update(driveFiles).set({ deletedAt: new Date() }).where(eq(driveFiles.id, file.id));
    calls.length = 0;
    const res = await save(me.headers, { accountId: box.id, threadId: null, mode: "new", subject: "x", body: "z", to: [{ email: "ok@x.it" }] });
    expect((res.json() as { code: string }).code).toBe("attachment_unavailable");
    expect(calls.filter((c) => c.fn === "update")).toEqual([]);
  });

  it("Invia ricontrolla il Drive: perso l'accesso dopo l'ultimo salvataggio, 409 attachment_unavailable e niente in coda", async () => {
    const { me, draftId } = await draftOf();
    const file = await driveFile(me.id);
    await attachDrive(me.headers, draftId, file.id);
    const { projectMembers, mailOutgoing } = await import("@stubwise/db");
    const { eq } = await import("drizzle-orm");
    await db.delete(projectMembers).where(eq(projectMembers.projectId, file.projectId));
    const res = await app.inject({ method: "POST", url: `/api/me/mail/drafts/${draftId}/send`, headers: me.headers, payload: {} });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("attachment_unavailable");
    expect(await db.select().from(mailOutgoing)).toEqual([]);
    // Il gemello positivo: con l'accesso, parte.
    await addMember(app, file.projectId, me.id, "viewer");
    expect((await app.inject({ method: "POST", url: `/api/me/mail/drafts/${draftId}/send`, headers: me.headers, payload: {} })).statusCode).toBe(202);
  });

  it("Invia ricontrolla il Drive: un file eliminato dopo l'ultimo salvataggio non parte", async () => {
    const { me, draftId } = await draftOf();
    const file = await driveFile(me.id);
    await attachDrive(me.headers, draftId, file.id);
    const { eq } = await import("drizzle-orm");
    await db.update(driveFiles).set({ deletedAt: new Date() }).where(eq(driveFiles.id, file.id));
    const res = await app.inject({ method: "POST", url: `/api/me/mail/drafts/${draftId}/send`, headers: me.headers, payload: {} });
    expect((res.json() as { code: string }).code).toBe("attachment_unavailable");
  });

  it("NEGATIVO: la bozza di un altro è 404, e niente finisce nello storage", async () => {
    const { draftId } = await draftOf();
    const other = await createUserWithSession(app, `zeta-${randomUUID()}@acme.com`);
    expect((await upload(other.headers, draftId, "a.txt", Buffer.from("x"))).statusCode).toBe(404);
    expect(objects.size).toBe(0);
  });

  it("i limiti: oltre 25 MB in tutto 400 too_large, l'undicesimo 400 too_many_attachments, senza storage 400", async () => {
    const { me, draftId } = await draftOf();
    await db.insert(mailDraftAttachments).values({ draftId, name: "grande", sizeBytes: 25 * 1024 * 1024 - 4, mimeType: "application/pdf", storageKey: "mail/x" });
    const big = await upload(me.headers, draftId, "b.txt", Buffer.from("12345"));
    expect(big.statusCode).toBe(400);
    expect((big.json() as { code: string }).code).toBe("too_large");
    const { eq } = await import("drizzle-orm");
    await db.delete(mailDraftAttachments).where(eq(mailDraftAttachments.draftId, draftId));
    await db.insert(mailDraftAttachments).values(Array.from({ length: 10 }, (_, i) => ({ draftId, name: `f${i}`, sizeBytes: 1, mimeType: "text/plain", storageKey: `mail/${i}` })));
    expect((await upload(me.headers, draftId, "c.txt", Buffer.from("1"))).json()).toMatchObject({ code: "too_many_attachments" });
    await db.delete(mailDraftAttachments).where(eq(mailDraftAttachments.draftId, draftId));
    storage = null;
    expect((await upload(me.headers, draftId, "d.txt", Buffer.from("1"))).json()).toMatchObject({ code: "storage_not_configured" });
    expect(objects.size).toBe(0);
  });

  it("togliere un allegato: via dallo storage, e la bozza su Gmail si riscrive SENZA", async () => {
    const { me, draftId } = await draftOf();
    const added = (await upload(me.headers, draftId, "nota.txt", Buffer.from("CONTENUTO-ALLEGATO"))).json() as { attachments: { id: string }[] };
    const res = await app.inject({ method: "DELETE", url: `/api/me/mail/drafts/${draftId}/attachments/${added.attachments[0]!.id}`, headers: me.headers });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { attachments: unknown[] }).attachments).toEqual([]);
    expect(objects.size).toBe(0);
    expect(lastMime()).not.toContain('filename="nota.txt"');
  });

  it("un salvataggio su Gmail fallito annulla l'allegato appena aggiunto (riga e oggetto)", async () => {
    const { me, draftId } = await draftOf();
    getError = new GoogleApiError({ api: "gmail.drafts.get", status: 500, code: "server_error", reason: "backendError" });
    const res = await upload(me.headers, draftId, "nota.txt", Buffer.from("x"));
    expect(res.statusCode).toBe(502);
    expect(await db.select().from(mailDraftAttachments)).toEqual([]);
    expect(objects.size).toBe(0);
  });
});

describe("la firma di Gmail (decisione M; basta gmail.modify)", () => {
  const textOf = (raw: unknown) => {
    const mime = Buffer.from(String(raw), "base64url").toString("utf8");
    return Buffer.from(mime.split("\r\n\r\n").slice(1).join("").replace(/\r\n/g, ""), "base64").toString("utf8");
  };

  it("al salvataggio: con la copia VECCHIA si rilegge dall'indirizzo mittente; sotto il corpo e PRIMA della citazione, una volta sola; mai in body", async () => {
    const { me, box, message } = await scenario();
    const { eq: eqOld } = await import("drizzle-orm");
    await db.update(googleAccounts).set({ signatureFetchedAt: new Date(Date.now() - 25 * 3600_000) }).where(eqOld(googleAccounts.id, box.id));
    const res = await save(me.headers, { accountId: box.id, threadId: "t1", mode: "reply", replyToMessageId: message.id, to: [{ email: "cliente@x.it" }], subject: "Re: Export", body: "Fatto.", quote: true });
    expect(sigCalls).toEqual([box.email]);
    const text = textOf(calls[0]!.input.raw);
    expect(text).toContain("Fatto.\n\n-- \nAda Lovelace\nAcme");
    expect(text.indexOf("Ada Lovelace")).toBeLessThan(text.indexOf("> Ci serve l'export."));
    expect(text.split("Ada Lovelace")).toHaveLength(2);
    expect(res.json()).toMatchObject({ body: "Fatto.", signature: "Ada Lovelace\nAcme", signatureStatus: "present" });
    // E la copia della casella è aggiornata.
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select().from(googleAccounts).where(eq(googleAccounts.id, box.id));
    expect(row!.signatureText).toBe("Ada Lovelace\nAcme");
  });

  it("compose: dalla copia fresca, SENZA chiamare Google; con la copia vecchia di un giorno (o assente) la rilegge", async () => {
    const { me, box } = await scenario();
    const first = (await compose(me.headers, `account=${box.id}&mode=new`)).json() as { signature: string | null; signatureStatus: string };
    expect(first).toMatchObject({ signature: "Ada (copia)", signatureStatus: "present" });
    expect(sigCalls).toEqual([]);
    const { eq } = await import("drizzle-orm");
    await db.update(googleAccounts).set({ signatureFetchedAt: new Date(Date.now() - 25 * 3600_000) }).where(eq(googleAccounts.id, box.id));
    const second = (await compose(me.headers, `account=${box.id}&mode=new`)).json() as { signature: string | null };
    expect(second.signature).toBe("Ada Lovelace\nAcme");
    expect(sigCalls).toEqual([box.email]);
  });

  it("nessuna firma su Gmail: status none e niente blocco nel messaggio; Google irraggiungibile: si usa la copia, il salvataggio non fallisce", async () => {
    const { me, box } = await scenario();
    signature = null;
    const { eq: eqStale } = await import("drizzle-orm");
    const stale = () => db.update(googleAccounts).set({ signatureFetchedAt: new Date(Date.now() - 25 * 3600_000) }).where(eqStale(googleAccounts.id, box.id));
    await stale();
    const res = await save(me.headers, { accountId: box.id, threadId: null, mode: "new", to: [{ email: "x@y.it" }], subject: "Ciao", body: "a" });
    expect(res.json()).toMatchObject({ signature: null, signatureStatus: "none" });
    expect(textOf(calls[0]!.input.raw)).not.toContain("-- ");
    const { eq } = await import("drizzle-orm");
    await db.update(googleAccounts).set({ signatureText: "Ada (copia)" }).where(eq(googleAccounts.id, box.id));
    await stale();
    sigError = new GoogleApiError({ api: "gmail.settings.sendAs.get", status: 500, code: "server_error", reason: "backendError" });
    const again = await save(me.headers, { accountId: box.id, threadId: null, mode: "new", to: [{ email: "x@y.it" }], subject: "Ciao", body: "b" });
    expect(again.statusCode).toBe(200);
    expect(textOf(calls.filter((c) => c.fn === "update").at(-1)!.input.raw)).toContain("-- \nAda (copia)");
  });

  it("review F3, punto 9: con la copia FRESCA il salvataggio non chiama Google; una firma lunghissima si taglia a 2000 caratteri", async () => {
    const { me, box } = await scenario();
    await save(me.headers, { accountId: box.id, threadId: null, mode: "new", to: [{ email: "x@y.it" }], subject: "Ciao", body: "a" });
    expect(sigCalls).toEqual([]);
    expect(textOf(calls[0]!.input.raw)).toContain("-- \nAda (copia)");
    const { eq } = await import("drizzle-orm");
    await db.update(googleAccounts).set({ signatureFetchedAt: null }).where(eq(googleAccounts.id, box.id));
    signature = "x".repeat(5000);
    const res = await save(me.headers, { accountId: box.id, threadId: null, mode: "new", to: [{ email: "x@y.it" }], subject: "Ciao", body: "b" });
    expect((res.json() as { signature: string }).signature).toHaveLength(2000);
  });

  it("una casella senza gmail.modify: scope_missing nel compositore, e nessuna chiamata", async () => {
    const { me, box } = await scenario(["openid", "email", "https://www.googleapis.com/auth/gmail.readonly"]);
    const view = (await compose(me.headers, `account=${box.id}&mode=new`)).json() as { signature: string | null; signatureStatus: string };
    expect(view).toMatchObject({ signature: null, signatureStatus: "scope_missing" });
    expect(sigCalls).toEqual([]);
  });
});

describe("review F3, punti 6, 7 e 10: Message-ID nostro, catena dei References, l'invio che resta leggibile", () => {
  const raw = (i = -1) => Buffer.from(String(calls.filter((c) => c.fn === "create" || c.fn === "update").at(i)!.input.raw), "base64url").toString("utf8");

  it("il Message-ID è nostro e stabile fra i salvataggi; References ha la catena del thread fino al messaggio a cui si risponde", async () => {
    const { me, box, message } = await scenario();
    await db.insert(emailMessages).values({ accountId: box.id, gmailMessageId: "g0", threadId: "t1", fromAddress: "a@x.it", subject: "Export", receivedAt: new Date("2026-11-09T09:00:00.000Z"), rfcMessageId: "<m0@x.it>" });
    const body = { accountId: box.id, threadId: "t1", mode: "reply", replyToMessageId: message.id, to: [{ email: "cliente@x.it" }], subject: "Re: Export", body: "a" };
    await save(me.headers, body);
    const first = raw().match(/Message-ID: (<stubwise\.[^>]+>)/)![1];
    expect(first).toMatch(/@acme\.com>$/);
    expect(raw()).toContain("References: <m0@x.it> <m1@x.it>");
    await save(me.headers, { ...body, body: "b" });
    expect(raw().match(/Message-ID: (<stubwise\.[^>]+>)/)![1]).toBe(first);
  });

  it("Invia copia destinatari, oggetto, corpo e Message-ID sull'invio: il fumetto «inviata» si legge anche dopo che la bozza se n'è andata", async () => {
    const { me, box, message } = await scenario();
    const saved = (await save(me.headers, { accountId: box.id, threadId: "t1", mode: "reply", replyToMessageId: message.id, to: [{ email: "cliente@x.it" }], subject: "Re: Export", body: "Fatto." })).json() as { id: string };
    const sent = (await app.inject({ method: "POST", url: `/api/me/mail/drafts/${saved.id}/send`, headers: me.headers, payload: {} })).json() as { messageId: string };
    const { mailOutgoing } = await import("@stubwise/db");
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select().from(mailOutgoing).where(eq(mailOutgoing.id, sent.messageId));
    expect(row).toMatchObject({ subject: "Re: Export", body: "Fatto." });
    expect(row!.rfcMessageId).toMatch(/^<stubwise\./);
    // Il worker l'ha mandata e ha tolto la bozza.
    await db.update(mailOutgoing).set({ state: "sent", gmailMessageId: "gm-x" }).where(eq(mailOutgoing.id, sent.messageId));
    await db.delete(mailDrafts).where(eq(mailDrafts.id, saved.id));
    const detail = (await app.inject({ method: "GET", url: `/api/me/mail/threads/t1?account=${box.id}`, headers: me.headers })).json() as { messages: { textExcerpt: string | null; to: string[]; delivery: { state: string } | null }[] };
    const bubble = detail.messages.find((m) => m.delivery?.state === "sent")!;
    expect(bubble).toMatchObject({ textExcerpt: "Fatto.", to: ["cliente@x.it"] });
  });
});

