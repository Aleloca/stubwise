import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { comments, recordDecision, tickets, users } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import {
  commentPermissions,
  loadDecisionLogLinks,
  loadDeleterNames,
  loadReplyTargets,
  type CommentRow,
  type CommentViewer,
} from "./comments.js";

/**
 * Modificare e cancellare i commenti (piano 2026-10-05, A3): la regola UNICA
 * dei permessi (`commentPermissions`, pura) e i loader che la proiezione usa
 * (`replyTo.deleted`, i nomi di chi ha eliminato, il legame col registro
 * decisioni). La rotta e la proiezione chiamano la STESSA funzione: il client
 * legge i due booleani e non li deduce.
 */

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const memberA: CommentViewer = { id: A, role: "member" };
const memberB: CommentViewer = { id: B, role: "member" };
const adminC: CommentViewer = { id: C, role: "admin" };

function row(over: Partial<CommentRow>): CommentRow {
  return {
    id: randomUUID(),
    ticketId: randomUUID(),
    authorType: "user",
    authorId: A,
    body: "testo",
    createdAt: new Date("2026-10-05T09:00:00Z"),
    replyToCommentId: null,
    editedAt: null,
    deletedAt: null,
    deletedByUserId: null,
    ...over,
  };
}

describe("commentPermissions — più ruoli sugli STESSI dati", () => {
  const cases: Array<{
    name: string;
    comment: CommentRow;
    expected: Array<[CommentViewer, { canEdit: boolean; canDelete: boolean }]>;
  }> = [
    {
      name: "commento user di A",
      comment: row({}),
      expected: [
        [memberA, { canEdit: true, canDelete: true }],
        [memberB, { canEdit: false, canDelete: false }],
        [adminC, { canEdit: false, canDelete: true }],
      ],
    },
    {
      name: "commento ai",
      comment: row({ authorType: "ai", authorId: null }),
      expected: [
        [memberA, { canEdit: false, canDelete: false }],
        [memberB, { canEdit: false, canDelete: false }],
        [adminC, { canEdit: false, canDelete: false }],
      ],
    },
    {
      name: "commento system",
      comment: row({ authorType: "system", authorId: null }),
      expected: [
        [memberA, { canEdit: false, canDelete: false }],
        [memberB, { canEdit: false, canDelete: false }],
        [adminC, { canEdit: false, canDelete: false }],
      ],
    },
    {
      // Un ai/system che portasse per errore un authorId resta intoccabile:
      // il tipo d'autore viene prima dell'identità.
      name: "commento ai con authorId di A (riga anomala)",
      comment: row({ authorType: "ai", authorId: A }),
      expected: [
        [memberA, { canEdit: false, canDelete: false }],
        [adminC, { canEdit: false, canDelete: false }],
      ],
    },
    {
      name: "commento user con autore eliminato (authorId null)",
      comment: row({ authorId: null }),
      expected: [
        [memberA, { canEdit: false, canDelete: false }],
        [memberB, { canEdit: false, canDelete: false }],
        [adminC, { canEdit: false, canDelete: true }],
      ],
    },
    {
      name: "commento user di A già eliminato",
      comment: row({ body: "", deletedAt: new Date(), deletedByUserId: A }),
      expected: [
        [memberA, { canEdit: false, canDelete: false }],
        [memberB, { canEdit: false, canDelete: false }],
        [adminC, { canEdit: false, canDelete: false }],
      ],
    },
  ];

  for (const c of cases) {
    for (const [viewer, expected] of c.expected) {
      it(`${c.name} — visto da ${viewer.id === C ? "admin C" : viewer.id === A ? "member A" : "member B"}`, () => {
        expect(commentPermissions(c.comment, viewer)).toEqual(expected);
      });
    }
  }
});

describe("loader della proiezione (DB vero)", () => {
  let testDb: TestDb;
  let projectId: string;
  let ticketId: string;
  let userA: string;
  let userB: string;

  async function insertUser(email: string): Promise<string> {
    const [u] = await testDb.db
      .insert(users)
      .values({ email, passwordHash: "x", role: "member" })
      .returning({ id: users.id });
    return u!.id;
  }

  async function insertComment(values: Partial<typeof comments.$inferInsert>): Promise<CommentRow> {
    const [c] = await testDb.db
      .insert(comments)
      .values({ ticketId, authorType: "user", authorId: userA, body: "testo", ...values })
      .returning();
    return c!;
  }

  beforeAll(async () => {
    testDb = await startTestDb();
    ({ projectId } = await seedRepository(testDb.db));
    const [t] = await testDb.db
      .insert(tickets)
      .values({ projectId, number: 1, title: "T", type: "bug", priority: "medium", source: "manual" })
      .returning({ id: tickets.id });
    ticketId = t!.id;
    userA = await insertUser("a@example.com");
    userB = await insertUser("b@example.com");
  }, 120_000);

  afterAll(async () => {
    await testDb.stop();
  });

  it("replyTo verso un padre eliminato: deleted true, excerpt vuoto, autore conservato", async () => {
    const parent = await insertComment({
      body: "",
      deletedAt: new Date(),
      deletedByUserId: userB,
    });
    const alive = await insertComment({ body: "ancora qui" });
    const targets = await loadReplyTargets(testDb.db, ticketId, [parent.id, alive.id]);
    expect(targets.get(parent.id)).toEqual({
      id: parent.id,
      authorType: "user",
      authorName: "a@example.com",
      excerpt: "",
      deleted: true,
    });
    expect(targets.get(alive.id)).toMatchObject({ excerpt: "ancora qui", deleted: false });
  });

  it("loadDeleterNames: l'email di chi ha eliminato, una mappa per id", async () => {
    const byB = await insertComment({ body: "", deletedAt: new Date(), deletedByUserId: userB });
    const live = await insertComment({});
    const names = await loadDeleterNames(testDb.db, [byB, live]);
    expect(names.get(userB)).toBe("b@example.com");
    expect(names.size).toBe(1);
  });

  describe("loadDecisionLogLinks (L1)", () => {
    /**
     * Come `resolvePlan`: commento user e decisione `plan_review` nella STESSA
     * transazione, entrambi col default now() — l'istante d'inizio della
     * transazione, identico per i due insert.
     */
    async function rejectWithInstructions(authorId: string, text: string): Promise<string> {
      return testDb.db.transaction(async (tx) => {
        const [c] = await tx
          .insert(comments)
          .values({ ticketId, authorType: "user", authorId, body: text })
          .returning({ id: comments.id });
        await recordDecision(tx, {
          projectId,
          source: "plan_review",
          sourceKey: `plan_review:${randomUUID()}:1`,
          sourceRef: { mode: "fix" },
          ticketId,
          title: "T",
          decision: `Piano rifiutato: ${text}`,
          decidedByUserId: authorId,
        });
        return c!.id;
      });
    }

    it("il commento scritto insieme alla decisione è nel registro; gli altri no", async () => {
      const linked = await rejectWithInstructions(userA, "usa la cache");
      // Stesso autore, stesso ticket, FUORI da quella transazione.
      const plain = await insertComment({ body: "un'altra cosa" });
      const rows = await testDb.db.select().from(comments).where(eq(comments.ticketId, ticketId));
      const links = await loadDecisionLogLinks(testDb.db, ticketId, rows);
      expect(links.has(linked)).toBe(true);
      expect(links.has(plain.id)).toBe(false);
    });

    it("con l'autore eliminato (NULL da entrambe le parti) il legame resta", async () => {
      const gone = await insertUser(`gone-${randomUUID()}@example.com`);
      const linked = await rejectWithInstructions(gone, "niente migrazione");
      await testDb.db.delete(users).where(eq(users.id, gone));
      const [r] = await testDb.db.select().from(comments).where(eq(comments.id, linked));
      expect(r!.authorId).toBeNull();
      const links = await loadDecisionLogLinks(testDb.db, ticketId, [r!]);
      expect(links.has(linked)).toBe(true);
    });

    it("una decisione di un altro autore nello stesso istante non lega il commento", async () => {
      const id = await testDb.db.transaction(async (tx) => {
        const [c] = await tx
          .insert(comments)
          .values({ ticketId, authorType: "user", authorId: userA, body: "mio" })
          .returning({ id: comments.id });
        await recordDecision(tx, {
          projectId,
          source: "plan_review",
          sourceKey: `plan_review:${randomUUID()}:1`,
          ticketId,
          title: "T",
          decision: "altro",
          decidedByUserId: userB,
        });
        return c!.id;
      });
      const [r] = await testDb.db.select().from(comments).where(eq(comments.id, id));
      const links = await loadDecisionLogLinks(testDb.db, ticketId, [r!]);
      expect(links.has(id)).toBe(false);
      // Il controllo sull'istante esiste: la query vede davvero la decisione.
      const counted = await testDb.db.execute<{ n: number }>(
        sql`select count(*)::int as n from project_decisions where decided_by_user_id = ${userB}`,
      );
      expect(counted[0]?.n).toBe(1);
    });
  });
});
