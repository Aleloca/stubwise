import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { comments, tickets } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { isReplyTargetFkViolation } from "./comments.js";
import type { SeededUsers } from "../test/fixtures.js";
import { seedUsers } from "../test/fixtures.js";

/**
 * Risposte ai commenti (migrazione 0083, piano A5): il `POST` accetta
 * `replyToCommentId` opzionale e lo valida (stesso ticket, altrimenti 422 e
 * NESSUNA riga), e `GET /comments`, la risposta del `POST` e il feed
 * `/activity` portano `replyTo` DERIVATO a lettura.
 */

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";

let testDb: TestDb;
let app: FastifyInstance;
let users: SeededUsers;
let projectId: string;
let ticketNumber = 1;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: randomBytes(32).toString("base64"),
  });
  users = await seedUsers(app);
  ({ projectId } = await seedRepository(testDb.db));
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

interface ReplyTo {
  id: string;
  authorType: string;
  authorName: string | null;
  excerpt: string;
}
interface CommentBody {
  id: string;
  body: string;
  replyTo: ReplyTo | null;
}
interface ActivityItem {
  kind: string;
  id: string;
  replyTo?: ReplyTo | null;
}

async function newTicket(): Promise<string> {
  const [row] = await testDb.db
    .insert(tickets)
    .values({
      projectId,
      number: ticketNumber++,
      title: "Risposte",
      type: "bug",
      priority: "medium",
      source: "manual",
    })
    .returning({ id: tickets.id });
  return row!.id;
}

async function insertComment(
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

function post(ticketId: string, payload: Record<string, unknown>, cookie = users.memberCookie) {
  return app.inject({
    method: "POST",
    url: `/api/tickets/${ticketId}/comments`,
    headers: { cookie },
    payload,
  });
}

async function listComments(ticketId: string): Promise<CommentBody[]> {
  const res = await app.inject({
    method: "GET",
    url: `/api/tickets/${ticketId}/comments`,
    headers: { cookie: users.memberCookie },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as CommentBody[];
}

async function activity(ticketId: string): Promise<ActivityItem[]> {
  const res = await app.inject({
    method: "GET",
    url: `/api/tickets/${ticketId}/activity`,
    headers: { cookie: users.memberCookie },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as ActivityItem[];
}

async function commentCount(ticketId: string): Promise<number> {
  const rows = await testDb.db
    .select({ id: comments.id })
    .from(comments)
    .where(eq(comments.ticketId, ticketId));
  return rows.length;
}

describe("POST /api/tickets/:id/comments con replyToCommentId", () => {
  it("risposta a un commento dello stesso ticket: 201 e replyTo in POST, GET /comments e /activity", async () => {
    const ticketId = await newTicket();
    const original = await insertComment(
      ticketId,
      "user",
      "Il **login** non va: vedi [log](https://x.test/log)",
      users.adminId,
    );

    const res = await post(ticketId, { body: "Confermo", replyToCommentId: original });
    expect(res.statusCode).toBe(201);
    const created = res.json() as CommentBody;
    const expected: ReplyTo = {
      id: original,
      authorType: "user",
      authorName: "admin@example.com",
      excerpt: "Il login non va: vedi log",
    };
    expect(created.replyTo).toEqual(expected);

    const listed = await listComments(ticketId);
    expect(listed.find((c) => c.id === created.id)?.replyTo).toEqual(expected);
    expect(listed.find((c) => c.id === original)?.replyTo).toBeNull();

    const feed = await activity(ticketId);
    expect(feed.find((i) => i.id === created.id)?.replyTo).toEqual(expected);
    expect(feed.find((i) => i.id === original)?.replyTo).toBeNull();
  });

  it("NEGATIVO: risposta a un commento di un ALTRO ticket → 422 e nessuna riga nuova", async () => {
    const mine = await newTicket();
    const other = await newTicket();
    const foreign = await insertComment(other, "user", "altrove", users.adminId);
    const beforeMine = await commentCount(mine);
    const beforeOther = await commentCount(other);

    const res = await post(mine, { body: "risposta", replyToCommentId: foreign });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: "reply_target_invalid" });
    expect(await commentCount(mine)).toBe(beforeMine);
    expect(await commentCount(other)).toBe(beforeOther);
  });

  it("NEGATIVO: id inesistente → 422 e nessuna riga nuova", async () => {
    const ticketId = await newTicket();
    const before = await commentCount(ticketId);
    const res = await post(ticketId, { body: "risposta", replyToCommentId: randomUUID() });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: "reply_target_invalid" });
    expect(await commentCount(ticketId)).toBe(before);
  });

  it("body SENZA replyToCommentId (app installata): 201 come oggi, replyTo null", async () => {
    const ticketId = await newTicket();
    const res = await post(ticketId, { body: "commento normale" });
    expect(res.statusCode).toBe(201);
    expect((res.json() as CommentBody).replyTo).toBeNull();
    const [row] = await testDb.db
      .select({ replyTo: comments.replyToCommentId })
      .from(comments)
      .where(eq(comments.id, (res.json() as CommentBody).id));
    expect(row?.replyTo).toBeNull();
  });

  it("si risponde anche a un commento dell'AI e a uno di sistema (D7), senza nome", async () => {
    const ticketId = await newTicket();
    const fromAi = await insertComment(ticketId, "ai", "Fix automatico pronto");
    const fromSystem = await insertComment(ticketId, "system", "PR mergiata");

    const a = await post(ticketId, { body: "grazie", replyToCommentId: fromAi });
    expect(a.statusCode).toBe(201);
    expect((a.json() as CommentBody).replyTo).toEqual({
      id: fromAi,
      authorType: "ai",
      authorName: null,
      excerpt: "Fix automatico pronto",
    });
    const s = await post(ticketId, { body: "ok", replyToCommentId: fromSystem });
    expect(s.statusCode).toBe(201);
    expect((s.json() as CommentBody).replyTo).toMatchObject({
      id: fromSystem,
      authorType: "system",
      authorName: null,
    });
  });

  it("replyTo è DERIVATO a lettura: cambiando il padre in DB cambia l'estratto della risposta", async () => {
    const ticketId = await newTicket();
    const original = await insertComment(ticketId, "user", "testo di prima", users.adminId);
    const reply = (await post(ticketId, { body: "r", replyToCommentId: original })).json() as CommentBody;
    expect(reply.replyTo?.excerpt).toBe("testo di prima");

    // Solo nel test: i commenti non si modificano da nessuna rotta.
    await testDb.db
      .update(comments)
      .set({ body: "testo di dopo" })
      .where(eq(comments.id, original));
    const listed = await listComments(ticketId);
    expect(listed.find((c) => c.id === reply.id)?.replyTo?.excerpt).toBe("testo di dopo");
    const feed = await activity(ticketId);
    expect(feed.find((i) => i.id === reply.id)?.replyTo?.excerpt).toBe("testo di dopo");
  });

  it("originale cancellato: la risposta resta, con replyTo null", async () => {
    const ticketId = await newTicket();
    const original = await insertComment(ticketId, "user", "da cancellare", users.adminId);
    const reply = (await post(ticketId, { body: "r", replyToCommentId: original })).json() as CommentBody;

    // Solo nel test: oggi nessuna rotta cancella un commento.
    await testDb.db.delete(comments).where(eq(comments.id, original));
    const listed = await listComments(ticketId);
    expect(listed.map((c) => c.id)).toEqual([reply.id]);
    expect(listed[0]?.replyTo).toBeNull();
  });

  it("un estratto lungo si taglia a ~120 caratteri con «…»", async () => {
    const ticketId = await newTicket();
    const long = Array.from({ length: 60 }, (_, i) => `parola${i}`).join(" ");
    const original = await insertComment(ticketId, "user", long, users.adminId);
    const reply = (await post(ticketId, { body: "r", replyToCommentId: original })).json() as CommentBody;
    expect(reply.replyTo?.excerpt.endsWith("…")).toBe(true);
    expect(reply.replyTo!.excerpt.length).toBeLessThanOrEqual(121);
  });
});

describe("isReplyTargetFkViolation (review fase A, M3)", () => {
  /** L'errore VERO del driver, con la sua catena di `cause`. */
  async function errorOf(query: PromiseLike<unknown>): Promise<unknown> {
    try {
      await query;
    } catch (error) {
      return error;
    }
    throw new Error("la query doveva fallire");
  }

  it("riconosce la FK del padre, e solo quella", async () => {
    const ticketId = await newTicket();
    const replyFk = await errorOf(
      testDb.db
        .insert(comments)
        .values({ ticketId, authorType: "user", body: "x", replyToCommentId: randomUUID() }),
    );
    expect(isReplyTargetFkViolation(replyFk)).toBe(true);

    // Un'altra FK della stessa tabella (il ticket) NON è un padre sparito: un
    // 422 `reply_target_invalid` lì mentirebbe.
    const ticketFk = await errorOf(
      testDb.db
        .insert(comments)
        .values({ ticketId: randomUUID(), authorType: "user", body: "x" }),
    );
    expect(isReplyTargetFkViolation(ticketFk)).toBe(false);
    expect(isReplyTargetFkViolation(new Error("altro"))).toBe(false);
  });
});
