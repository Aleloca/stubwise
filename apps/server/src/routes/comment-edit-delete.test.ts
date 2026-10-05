import { randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { aiJobs, attachments, comments, tickets } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import type { SeededUsers } from "../test/fixtures.js";
import { seedUsers, sessionCookie } from "../test/fixtures.js";
import type { ObjectStorage } from "../storage/index.js";

/**
 * Modificare e cancellare i commenti (piano 2026-10-05, A4/A5).
 *
 * A4 — le LETTURE: `GET /comments`, la risposta del `POST` e `/activity`
 * portano `editedAt`/`deletedAt`/`deletedBy`, i permessi calcolati PER CHI
 * GUARDA e `inDecisionLog`; un padre eliminato dà `replyTo.deleted`; le due
 * ricerche non trovano più il testo cancellato (verso opposto incluso); una
 * risposta a un eliminato è rifiutata (D1).
 *
 * A5 — le SCRITTURE: `PATCH`/`DELETE /:commentId`. Ogni negativo asserisce la
 * RIGA in DB (corpo, `edited_at`, `deleted_at`, `deleted_by_user_id`
 * invariati), non solo lo status.
 *
 * Tre identità sugli STESSI dati: member A (autore), member B, admin.
 */

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";

let testDb: TestDb;
let app: FastifyInstance;
let users: SeededUsers;
/** Secondo member: chi guarda senza essere l'autore. */
let memberB: { id: string; cookie: string };
let projectId: string;
let ticketNumber = 1;

/** Doppio dello storage: registra le chiavi cancellate (D3). */
const deleteObject = vi.fn<(key: string) => Promise<void>>(async () => {});
const fakeStorage: ObjectStorage = {
  putObject: async () => {},
  getSignedDownloadUrl: async (key) => `https://fake-storage.test/${key}`,
  deleteObject,
};

async function seedSecondMember(): Promise<{ id: string; cookie: string }> {
  const invite = await app.inject({
    method: "POST",
    url: "/api/auth/invites",
    headers: { cookie: users.adminCookie },
    payload: { email: "member-b@example.com" },
  });
  const register = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      token: (invite.json() as { token: string }).token,
      email: "member-b@example.com",
      password: "password-member-b",
    },
  });
  const id = (register.json() as { user: { id: string } }).user.id;
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "member-b@example.com", password: "password-member-b" },
  });
  return { id, cookie: sessionCookie(login) };
}

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: randomBytes(32).toString("base64"),
    storageFactory: async () => fakeStorage,
  });
  users = await seedUsers(app);
  memberB = await seedSecondMember();
  ({ projectId } = await seedRepository(testDb.db));
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

interface PublicComment {
  id: string;
  body: string;
  editedAt: string | null;
  deletedAt: string | null;
  deletedBy: { name: string | null } | null;
  canEdit: boolean;
  canDelete: boolean;
  inDecisionLog: boolean;
  replyTo: { id: string; excerpt: string; authorName: string | null; deleted: boolean } | null;
}
interface ActivityItem extends Partial<PublicComment> {
  kind: string;
  id: string;
}

async function newTicket(): Promise<string> {
  const [row] = await testDb.db
    .insert(tickets)
    .values({
      projectId,
      number: ticketNumber++,
      title: "Commenti",
      type: "bug",
      priority: "medium",
      source: "manual",
    })
    .returning({ id: tickets.id });
  return row!.id;
}

function post(ticketId: string, payload: Record<string, unknown>, cookie = users.memberCookie) {
  return app.inject({
    method: "POST",
    url: `/api/tickets/${ticketId}/comments`,
    headers: { cookie },
    payload,
  });
}

async function postComment(ticketId: string, body: string, cookie = users.memberCookie): Promise<PublicComment> {
  const res = await post(ticketId, { body }, cookie);
  expect(res.statusCode).toBe(201);
  return res.json() as PublicComment;
}

async function listComments(ticketId: string, cookie: string): Promise<PublicComment[]> {
  const res = await app.inject({
    method: "GET",
    url: `/api/tickets/${ticketId}/comments`,
    headers: { cookie },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as PublicComment[];
}

async function activity(ticketId: string, cookie: string): Promise<ActivityItem[]> {
  const res = await app.inject({
    method: "GET",
    url: `/api/tickets/${ticketId}/activity`,
    headers: { cookie },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as ActivityItem[];
}

/** Lo stato di una cancellazione, scritto in DB come lo scrive la rotta. */
async function markDeleted(commentId: string, byUserId: string): Promise<void> {
  await testDb.db
    .update(comments)
    .set({ body: "", deletedAt: sql`now()`, deletedByUserId: byUserId })
    .where(eq(comments.id, commentId));
}

async function commentCount(ticketId: string): Promise<number> {
  const rows = await testDb.db
    .select({ id: comments.id })
    .from(comments)
    .where(eq(comments.ticketId, ticketId));
  return rows.length;
}

/** Una parola che il tokenizer `english` tiene intera e che nessun altro test usa. */
function uniqueWord(): string {
  return "zq" + randomUUID().replace(/[^a-f]/g, "").slice(0, 10) + "x";
}

async function searchFinds(ticketId: string, word: string): Promise<{ global: boolean; list: boolean }> {
  const global = await app.inject({
    method: "GET",
    url: `/api/search?q=${word}`,
    headers: { cookie: users.memberCookie },
  });
  expect(global.statusCode).toBe(200);
  const list = await app.inject({
    method: "GET",
    url: `/api/tickets?q=${word}`,
    headers: { cookie: users.memberCookie },
  });
  expect(list.statusCode).toBe(200);
  return {
    global: (global.json() as { tickets: { items: { id: string }[] } }).tickets.items.some(
      (t) => t.id === ticketId,
    ),
    list: (list.json() as { items: { id: string }[] }).items.some((t) => t.id === ticketId),
  };
}

describe("letture: permessi per CHI GUARDA (A4)", () => {
  it("POST risponde con canEdit e canDelete veri all'autore, e i campi nuovi vuoti", async () => {
    const ticketId = await newTicket();
    const created = await postComment(ticketId, "mio");
    expect(created).toMatchObject({
      canEdit: true,
      canDelete: true,
      editedAt: null,
      deletedAt: null,
      deletedBy: null,
      inDecisionLog: false,
    });
  });

  it("stessa riga, tre sessioni: autore, altro member, admin — su /comments e /activity", async () => {
    const ticketId = await newTicket();
    const created = await postComment(ticketId, "scritto da A");
    const expectations: Array<[string, { canEdit: boolean; canDelete: boolean }]> = [
      [users.memberCookie, { canEdit: true, canDelete: true }],
      [memberB.cookie, { canEdit: false, canDelete: false }],
      [users.adminCookie, { canEdit: false, canDelete: true }],
    ];
    for (const [cookie, perms] of expectations) {
      const listed = (await listComments(ticketId, cookie)).find((c) => c.id === created.id);
      expect(listed).toMatchObject(perms);
      const fed = (await activity(ticketId, cookie)).find((i) => i.id === created.id);
      expect(fed).toMatchObject(perms);
    }
  });

  it("commenti ai e system: nessuno può toccarli, nemmeno l'admin", async () => {
    const ticketId = await newTicket();
    const rows = await testDb.db
      .insert(comments)
      .values([
        { ticketId, authorType: "ai", body: "fix pronto" },
        { ticketId, authorType: "system", body: "PR mergiata" },
      ])
      .returning({ id: comments.id });
    for (const cookie of [users.memberCookie, memberB.cookie, users.adminCookie]) {
      const listed = await listComments(ticketId, cookie);
      for (const r of rows) {
        expect(listed.find((c) => c.id === r.id)).toMatchObject({ canEdit: false, canDelete: false });
      }
    }
  });

  it("un eliminato: corpo vuoto, chi e quando, nessun permesso — su entrambe le letture", async () => {
    const ticketId = await newTicket();
    const created = await postComment(ticketId, "da cancellare");
    await markDeleted(created.id, users.adminId);
    for (const cookie of [users.memberCookie, users.adminCookie]) {
      const listed = (await listComments(ticketId, cookie)).find((c) => c.id === created.id);
      expect(listed).toMatchObject({
        body: "",
        deletedBy: { name: "admin@example.com" },
        canEdit: false,
        canDelete: false,
      });
      expect(listed?.deletedAt).not.toBeNull();
      const fed = (await activity(ticketId, cookie)).find((i) => i.id === created.id);
      expect(fed).toMatchObject({ body: "", deletedBy: { name: "admin@example.com" } });
      expect(fed?.deletedAt).not.toBeNull();
    }
  });

  it("un modificato porta editedAt", async () => {
    const ticketId = await newTicket();
    const created = await postComment(ticketId, "prima");
    await testDb.db
      .update(comments)
      .set({ body: "dopo", editedAt: sql`now()` })
      .where(eq(comments.id, created.id));
    const listed = (await listComments(ticketId, users.memberCookie)).find((c) => c.id === created.id);
    expect(listed?.body).toBe("dopo");
    expect(listed?.editedAt).not.toBeNull();
    const fed = (await activity(ticketId, users.memberCookie)).find((i) => i.id === created.id);
    expect(fed?.editedAt).not.toBeNull();
  });

  it("una risposta a un eliminato: replyTo.deleted vero e nessun estratto", async () => {
    const ticketId = await newTicket();
    const parent = await postComment(ticketId, "originale");
    const reply = await post(ticketId, { body: "risposta", replyToCommentId: parent.id });
    expect(reply.statusCode).toBe(201);
    const replyId = (reply.json() as PublicComment).id;
    await markDeleted(parent.id, users.memberId);
    const listed = (await listComments(ticketId, users.memberCookie)).find((c) => c.id === replyId);
    expect(listed?.replyTo).toEqual({
      id: parent.id,
      authorType: "user",
      authorName: "member@example.com",
      excerpt: "",
      deleted: true,
    });
    const fed = (await activity(ticketId, users.memberCookie)).find((i) => i.id === replyId);
    expect(fed?.replyTo).toMatchObject({ excerpt: "", deleted: true });
  });

  it("D1 NEGATIVO: rispondere a un eliminato → 422 e nessuna riga nuova", async () => {
    const ticketId = await newTicket();
    const parent = await postComment(ticketId, "originale");
    await markDeleted(parent.id, users.memberId);
    const before = await commentCount(ticketId);
    const res = await post(ticketId, { body: "risposta", replyToCommentId: parent.id });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: "reply_target_invalid" });
    expect(await commentCount(ticketId)).toBe(before);
  });
});

describe("il testo cancellato sparisce davvero dalle ricerche (A4)", () => {
  it("una parola solo nel commento: trovata prima, NON trovata dopo la cancellazione", async () => {
    const ticketId = await newTicket();
    const word = uniqueWord();
    const created = await postComment(ticketId, `nota interna ${word}`);
    // Verso opposto PRIMA: così un vuoto dopo non può essere una query rotta.
    expect(await searchFinds(ticketId, word)).toEqual({ global: true, list: true });
    await markDeleted(created.id, users.memberId);
    expect(await searchFinds(ticketId, word)).toEqual({ global: false, list: false });
  });

  it("un commento modificato si trova col testo NUOVO, non col vecchio", async () => {
    const ticketId = await newTicket();
    const oldWord = uniqueWord();
    const newWord = uniqueWord();
    const created = await postComment(ticketId, `versione ${oldWord}`);
    await testDb.db
      .update(comments)
      .set({ body: `versione ${newWord}`, editedAt: sql`now()` })
      .where(eq(comments.id, created.id));
    expect(await searchFinds(ticketId, newWord)).toEqual({ global: true, list: true });
    expect(await searchFinds(ticketId, oldWord)).toEqual({ global: false, list: false });
  });
});

describe("inDecisionLog (L1)", () => {
  it("le istruzioni di un rifiuto del piano (rotta vera) sono nel registro; gli altri commenti no", async () => {
    const ticketId = await newTicket();
    const plain = await postComment(ticketId, "commento qualunque", users.adminCookie);
    await testDb.db
      .insert(aiJobs)
      .values({ ticketId, status: "awaiting_plan_approval", planText: "## Piano" });
    const res = await app.inject({
      method: "POST",
      url: `/api/tickets/${ticketId}/reject-plan`,
      headers: { cookie: users.adminCookie },
      payload: { instructions: "Ripianifica senza toccare lo schema." },
    });
    expect(res.statusCode).toBe(202);

    const listed = await listComments(ticketId, users.adminCookie);
    const instructions = listed.find((c) => c.body === "Ripianifica senza toccare lo schema.");
    expect(instructions?.inDecisionLog).toBe(true);
    expect(listed.find((c) => c.id === plain.id)?.inDecisionLog).toBe(false);
    // Il commento di SISTEMA del rifiuto non è il testo copiato nel registro.
    for (const c of listed.filter((c) => c.id !== instructions?.id)) {
      expect(c.inDecisionLog).toBe(false);
    }
    const fed = await activity(ticketId, users.memberCookie);
    expect(fed.find((i) => i.id === instructions?.id)?.inDecisionLog).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A5 — PATCH e DELETE
// ---------------------------------------------------------------------------

interface RowState {
  body: string;
  editedAt: Date | null;
  deletedAt: Date | null;
  deletedByUserId: string | null;
}

async function rowState(commentId: string): Promise<RowState | undefined> {
  const [row] = await testDb.db
    .select({
      body: comments.body,
      editedAt: comments.editedAt,
      deletedAt: comments.deletedAt,
      deletedByUserId: comments.deletedByUserId,
    })
    .from(comments)
    .where(eq(comments.id, commentId));
  return row;
}

function patch(ticketId: string, commentId: string, body: unknown, cookie: string) {
  return app.inject({
    method: "PATCH",
    url: `/api/tickets/${ticketId}/comments/${commentId}`,
    headers: { cookie },
    payload: body as Record<string, unknown>,
  });
}

function del(ticketId: string, commentId: string, cookie: string) {
  return app.inject({
    method: "DELETE",
    url: `/api/tickets/${ticketId}/comments/${commentId}`,
    headers: { cookie },
  });
}

async function insertRaw(
  ticketId: string,
  authorType: "user" | "ai" | "system",
  body: string,
  authorId: string | null = null,
): Promise<string> {
  const [row] = await testDb.db
    .insert(comments)
    .values({ ticketId, authorType, authorId, body })
    .returning({ id: comments.id });
  return row!.id;
}

describe("PATCH /comments/:commentId — negativi a più ruoli (A5)", () => {
  it("member B modifica il commento di A → 403, riga identica", async () => {
    const ticketId = await newTicket();
    const c = await postComment(ticketId, "di A");
    const before = await rowState(c.id);
    const res = await patch(ticketId, c.id, { body: "di B" }, memberB.cookie);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "forbidden" });
    expect(await rowState(c.id)).toEqual(before);
  });

  it("l'ADMIN modifica il commento di A → 403, riga identica (un maintainer non riscrive le parole altrui)", async () => {
    const ticketId = await newTicket();
    const c = await postComment(ticketId, "di A");
    const before = await rowState(c.id);
    const res = await patch(ticketId, c.id, { body: "dell'admin" }, users.adminCookie);
    expect(res.statusCode).toBe(403);
    expect(await rowState(c.id)).toEqual(before);
  });

  it("commenti ai e system: PATCH da A, B e admin → 403, righe identiche", async () => {
    const ticketId = await newTicket();
    const ids = [await insertRaw(ticketId, "ai", "fix pronto"), await insertRaw(ticketId, "system", "PR mergiata")];
    for (const id of ids) {
      const before = await rowState(id);
      for (const cookie of [users.memberCookie, memberB.cookie, users.adminCookie]) {
        const res = await patch(ticketId, id, { body: "riscritto" }, cookie);
        expect(res.statusCode).toBe(403);
      }
      expect(await rowState(id)).toEqual(before);
    }
  });

  it("commento di un ALTRO ticket (id giusto, ticket sbagliato) → 404, riga identica; id inesistente → 404", async () => {
    const mine = await newTicket();
    const other = await newTicket();
    const c = await postComment(other, "altrove");
    const before = await rowState(c.id);
    const res = await patch(mine, c.id, { body: "x" }, users.memberCookie);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "comment_not_found" });
    expect(await rowState(c.id)).toEqual(before);
    const missing = await patch(mine, randomUUID(), { body: "x" }, users.memberCookie);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: "comment_not_found" });
  });

  it("PATCH di un eliminato → 409 comment_deleted, il corpo resta vuoto", async () => {
    const ticketId = await newTicket();
    const c = await postComment(ticketId, "da cancellare");
    expect((await del(ticketId, c.id, users.memberCookie)).statusCode).toBe(204);
    const before = await rowState(c.id);
    const res = await patch(ticketId, c.id, { body: "risorto" }, users.memberCookie);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "comment_deleted" });
    expect(await rowState(c.id)).toEqual(before);
    expect(before?.body).toBe("");
  });

  it("body vuoto o oltre 20 000 caratteri → 400, riga identica", async () => {
    const ticketId = await newTicket();
    const c = await postComment(ticketId, "valido");
    const before = await rowState(c.id);
    expect((await patch(ticketId, c.id, { body: "" }, users.memberCookie)).statusCode).toBe(400);
    expect((await patch(ticketId, c.id, { body: "x".repeat(20_001) }, users.memberCookie)).statusCode).toBe(400);
    expect(await rowState(c.id)).toEqual(before);
  });
});

describe("PATCH /comments/:commentId — positivi (A5)", () => {
  it("l'autore modifica → 200, corpo nuovo, edited_at valorizzato, risposta coi permessi", async () => {
    const ticketId = await newTicket();
    const c = await postComment(ticketId, "prima");
    const res = await patch(ticketId, c.id, { body: "dopo" }, users.memberCookie);
    expect(res.statusCode).toBe(200);
    const out = res.json() as PublicComment;
    expect(out).toMatchObject({ id: c.id, body: "dopo", canEdit: true, canDelete: true });
    expect(out.editedAt).not.toBeNull();
    const after = await rowState(c.id);
    expect(after?.body).toBe("dopo");
    expect(after?.editedAt).not.toBeNull();
  });

  it("stesso corpo → 200 senza toccare edited_at (niente «modificato» a vuoto)", async () => {
    const ticketId = await newTicket();
    const c = await postComment(ticketId, "uguale");
    const res = await patch(ticketId, c.id, { body: "uguale" }, users.memberCookie);
    expect(res.statusCode).toBe(200);
    expect((res.json() as PublicComment).editedAt).toBeNull();
    expect((await rowState(c.id))?.editedAt).toBeNull();
  });
});

describe("DELETE /comments/:commentId (A5)", () => {
  beforeEach(() => {
    deleteObject.mockClear();
  });

  it("member B cancella il commento di A → 403, riga identica", async () => {
    const ticketId = await newTicket();
    const c = await postComment(ticketId, "di A");
    const before = await rowState(c.id);
    const res = await del(ticketId, c.id, memberB.cookie);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "forbidden" });
    expect(await rowState(c.id)).toEqual(before);
  });

  it("l'admin cancella il commento di A → 204, corpo vuoto, deleted_by = admin", async () => {
    const ticketId = await newTicket();
    const c = await postComment(ticketId, "di A");
    const res = await del(ticketId, c.id, users.adminCookie);
    expect(res.statusCode).toBe(204);
    const after = await rowState(c.id);
    expect(after?.body).toBe("");
    expect(after?.deletedAt).not.toBeNull();
    expect(after?.deletedByUserId).toBe(users.adminId);
  });

  it("l'autore cancella il proprio → 204, deleted_by = autore", async () => {
    const ticketId = await newTicket();
    const c = await postComment(ticketId, "mio");
    expect((await del(ticketId, c.id, users.memberCookie)).statusCode).toBe(204);
    const after = await rowState(c.id);
    expect(after).toMatchObject({ body: "", deletedByUserId: users.memberId });
    expect(after?.deletedAt).not.toBeNull();
  });

  it("commenti ai e system: DELETE da A, B e admin → 403, righe identiche", async () => {
    const ticketId = await newTicket();
    const ids = [await insertRaw(ticketId, "ai", "fix pronto"), await insertRaw(ticketId, "system", "PR mergiata")];
    for (const id of ids) {
      const before = await rowState(id);
      for (const cookie of [users.memberCookie, memberB.cookie, users.adminCookie]) {
        expect((await del(ticketId, id, cookie)).statusCode).toBe(403);
      }
      expect(await rowState(id)).toEqual(before);
    }
  });

  it("commento di un ALTRO ticket → 404, riga identica; id inesistente → 404", async () => {
    const mine = await newTicket();
    const other = await newTicket();
    const c = await postComment(other, "altrove");
    const before = await rowState(c.id);
    const res = await del(mine, c.id, users.adminCookie);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "comment_not_found" });
    expect(await rowState(c.id)).toEqual(before);
    expect((await del(mine, randomUUID(), users.adminCookie)).statusCode).toBe(404);
  });

  it("DELETE ripetuto → 204, e restano data e autore della PRIMA cancellazione", async () => {
    const ticketId = await newTicket();
    const c = await postComment(ticketId, "mio");
    expect((await del(ticketId, c.id, users.memberCookie)).statusCode).toBe(204);
    const first = await rowState(c.id);
    // Il secondo è un'altra persona (l'admin): non deve diventare «chi ha eliminato».
    expect((await del(ticketId, c.id, users.adminCookie)).statusCode).toBe(204);
    expect(await rowState(c.id)).toEqual(first);
    expect(first?.deletedByUserId).toBe(users.memberId);
  });

  it("D3: gli allegati del commento spariscono (riga e oggetto), quelli del ticket restano", async () => {
    const ticketId = await newTicket();
    const c = await postComment(ticketId, "con allegato");
    const [ofComment, ofTicket] = await testDb.db
      .insert(attachments)
      .values([
        { ticketId, commentId: c.id, filename: "a.png", mimeType: "image/png", sizeBytes: 1, storageKey: `k/${randomUUID()}` },
        { ticketId, filename: "b.png", mimeType: "image/png", sizeBytes: 1, storageKey: `k/${randomUUID()}` },
      ])
      .returning({ id: attachments.id, storageKey: attachments.storageKey });
    expect((await del(ticketId, c.id, users.memberCookie)).statusCode).toBe(204);
    const left = await testDb.db
      .select({ id: attachments.id })
      .from(attachments)
      .where(eq(attachments.ticketId, ticketId));
    expect(left.map((r) => r.id)).toEqual([ofTicket!.id]);
    expect(deleteObject).toHaveBeenCalledWith(ofComment!.storageKey);
    expect(deleteObject).not.toHaveBeenCalledWith(ofTicket!.storageKey);
  });

  it("D3: con un rifiuto (403) gli allegati del commento restano", async () => {
    const ticketId = await newTicket();
    const c = await postComment(ticketId, "con allegato");
    await testDb.db.insert(attachments).values({
      ticketId,
      commentId: c.id,
      filename: "a.png",
      mimeType: "image/png",
      sizeBytes: 1,
      storageKey: `k/${randomUUID()}`,
    });
    expect((await del(ticketId, c.id, memberB.cookie)).statusCode).toBe(403);
    const left = await testDb.db.select({ id: attachments.id }).from(attachments).where(eq(attachments.commentId, c.id));
    expect(left).toHaveLength(1);
    expect(deleteObject).not.toHaveBeenCalled();
  });
});
