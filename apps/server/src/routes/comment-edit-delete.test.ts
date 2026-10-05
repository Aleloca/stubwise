import { randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aiJobs, comments, tickets } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import type { SeededUsers } from "../test/fixtures.js";
import { seedUsers, sessionCookie } from "../test/fixtures.js";

/**
 * Modificare e cancellare i commenti (piano 2026-10-05, A4/A5).
 *
 * A4 — le LETTURE: `GET /comments`, la risposta del `POST` e `/activity`
 * portano `editedAt`/`deletedAt`/`deletedBy`, i permessi calcolati PER CHI
 * GUARDA e `inDecisionLog`; un padre eliminato dà `replyTo.deleted`; le due
 * ricerche non trovano più il testo cancellato (verso opposto incluso); una
 * risposta a un eliminato è rifiutata (D1).
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
