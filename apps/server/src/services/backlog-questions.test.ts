import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backlogChatMessages, backlogItems, backlogQuestions, users, type Db } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { isUniqueViolation } from "../routes/shared.js";
import type { Actor } from "./jobs.js";
import {
  answerBacklogQuestion,
  askBacklogQuestion,
  closeOpenBacklogQuestion,
  dismissBacklogQuestion,
} from "./backlog-questions.js";

let testDb: TestDb;
let db: Db;
let projectId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  ({ projectId } = await seedRepository(db));
}, 120_000);

afterAll(async () => {
  await testDb.stop();
});

async function seedItem(): Promise<string> {
  const [row] = await db
    .insert(backlogItems)
    .values({ projectId, title: "Voce di test", source: "manual" })
    .returning({ id: backlogItems.id });
  return row!.id;
}

async function seedActor(role: "admin" | "member" = "member"): Promise<Actor> {
  const [row] = await db
    .insert(users)
    .values({ email: `utente-${randomUUID()}@example.com`, passwordHash: "x", role })
    .returning({ id: users.id, role: users.role });
  return { id: row!.id, role: row!.role };
}

/** Pone una domanda a due opzioni sulla voce e ne restituisce l'id. */
async function seedQuestion(
  backlogItemId: string,
  overrides: { allowFreeText?: boolean } = {},
): Promise<string> {
  const asked = await db.transaction((tx) =>
    askBacklogQuestion(tx, {
      backlogItemId,
      question: "Import CSV o form manuale?",
      options: [{ label: "Import CSV", consequence: "Serve un file già pronto" }, { label: "Form manuale" }],
      recommendedIndex: 0,
      ...(overrides.allowFreeText !== undefined ? { allowFreeText: overrides.allowFreeText } : {}),
    }),
  );
  if (!asked) throw new Error("askBacklogQuestion non ha restituito la domanda");
  return asked.id;
}

describe("askBacklogQuestion", () => {
  it("inserisce la domanda con i default (allowFreeText true, nessuna risposta)", async () => {
    const itemId = await seedItem();
    const questionId = await seedQuestion(itemId);

    const [row] = await db.select().from(backlogQuestions).where(eq(backlogQuestions.id, questionId));
    expect(row?.allowFreeText).toBe(true);
    expect(row?.recommendedIndex).toBe(0);
    expect(row?.answer).toBeNull();
    expect(row?.answeredAt).toBeNull();
    expect(row?.dismissedAt).toBeNull();
  });

  it("rifiuta meno di 2 o più di 4 opzioni (nessuna riga inserita)", async () => {
    const itemId = await seedItem();
    const oneOption = await db.transaction((tx) =>
      askBacklogQuestion(tx, { backlogItemId: itemId, question: "?", options: [{ label: "A" }] }),
    );
    expect(oneOption).toBeNull();

    const fiveOptions = await db.transaction((tx) =>
      askBacklogQuestion(tx, {
        backlogItemId: itemId,
        question: "?",
        options: [{ label: "A" }, { label: "B" }, { label: "C" }, { label: "D" }, { label: "E" }],
      }),
    );
    expect(fiveOptions).toBeNull();

    const rows = await db.select().from(backlogQuestions).where(eq(backlogQuestions.backlogItemId, itemId));
    expect(rows).toHaveLength(0);
  });

  it("una seconda domanda aperta sulla stessa voce viola l'unique parziale", async () => {
    const itemId = await seedItem();
    await seedQuestion(itemId);

    let caught: unknown;
    try {
      await db.transaction((tx) =>
        askBacklogQuestion(tx, {
          backlogItemId: itemId,
          question: "Seconda domanda",
          options: [{ label: "A" }, { label: "B" }],
        }),
      );
    } catch (error) {
      caught = error;
    }
    expect(isUniqueViolation(caught)).toBe(true);
  });
});

describe("answerBacklogQuestion", () => {
  it("risponde con un indice valido: UPDATE scritto, messaggio system in chat", async () => {
    const itemId = await seedItem();
    const questionId = await seedQuestion(itemId);
    const actor = await seedActor();

    const result = await answerBacklogQuestion(db, {
      backlogItemId: itemId,
      questionId,
      actor,
      answer: { optionIndex: 0 },
    });
    expect(result).toEqual({ ok: true, backlogItemId: itemId });

    const [row] = await db.select().from(backlogQuestions).where(eq(backlogQuestions.id, questionId));
    expect(row?.answer).toEqual({ optionIndex: 0 });
    expect(row?.answeredByUserId).toBe(actor.id);
    expect(row?.answeredAt).toBeInstanceOf(Date);

    const messages = await db
      .select()
      .from(backlogChatMessages)
      .where(eq(backlogChatMessages.itemId, itemId));
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toContain("Import CSV");
    expect(messages[0]?.content).toContain("Serve un file già pronto");
  });

  it("risponde con testo libero quando la domanda lo ammette", async () => {
    const itemId = await seedItem();
    const questionId = await seedQuestion(itemId);
    const actor = await seedActor();

    const result = await answerBacklogQuestion(db, {
      backlogItemId: itemId,
      questionId,
      actor,
      answer: { text: "Nessuna delle due: preferisco un webhook" },
    });
    expect(result).toEqual({ ok: true, backlogItemId: itemId });
  });

  it("testo libero rifiutato se la domanda non lo ammette (allowFreeText:false)", async () => {
    const itemId = await seedItem();
    const questionId = await seedQuestion(itemId, { allowFreeText: false });
    const actor = await seedActor();

    const result = await answerBacklogQuestion(db, {
      backlogItemId: itemId,
      questionId,
      actor,
      answer: { text: "Altro" },
    });
    expect(result).toEqual({ ok: false, error: "invalid_answer" });
  });

  it("indice fuori range → invalid_answer (nessuna scrittura)", async () => {
    const itemId = await seedItem();
    const questionId = await seedQuestion(itemId); // 2 opzioni: 0 e 1 validi
    const actor = await seedActor();

    const result = await answerBacklogQuestion(db, {
      backlogItemId: itemId,
      questionId,
      actor,
      answer: { optionIndex: 2 },
    });
    expect(result).toEqual({ ok: false, error: "invalid_answer" });

    const [row] = await db.select().from(backlogQuestions).where(eq(backlogQuestions.id, questionId));
    expect(row?.answeredAt).toBeNull();
  });

  it("né indice né testo (o entrambi) → invalid_answer", async () => {
    const itemId = await seedItem();
    const questionId = await seedQuestion(itemId);
    const actor = await seedActor();

    expect(await answerBacklogQuestion(db, { backlogItemId: itemId, questionId, actor, answer: {} })).toEqual({
      ok: false,
      error: "invalid_answer",
    });
    expect(
      await answerBacklogQuestion(db, {
        backlogItemId: itemId,
        questionId,
        actor,
        answer: { optionIndex: 0, text: "anche questo" },
      }),
    ).toEqual({ ok: false, error: "invalid_answer" });
  });

  it("questionId di un'ALTRA voce → not_found (lo scoping dell'URL annidato è verificato)", async () => {
    const itemId = await seedItem();
    const altItemId = await seedItem();
    const questionId = await seedQuestion(itemId);
    const actor = await seedActor();

    const result = await answerBacklogQuestion(db, {
      backlogItemId: altItemId,
      questionId,
      actor,
      answer: { optionIndex: 0 },
    });
    expect(result).toEqual({ ok: false, error: "not_found" });
  });

  it("domanda inesistente → not_found", async () => {
    const itemId = await seedItem();
    const actor = await seedActor();
    const result = await answerBacklogQuestion(db, {
      backlogItemId: itemId,
      questionId: randomUUID(),
      actor,
      answer: { optionIndex: 0 },
    });
    expect(result).toEqual({ ok: false, error: "not_found" });
  });

  it("già risposta → already_answered", async () => {
    const itemId = await seedItem();
    const questionId = await seedQuestion(itemId);
    const actor = await seedActor();
    await answerBacklogQuestion(db, { backlogItemId: itemId, questionId, actor, answer: { optionIndex: 0 } });

    const second = await answerBacklogQuestion(db, {
      backlogItemId: itemId,
      questionId,
      actor: await seedActor(),
      answer: { optionIndex: 1 },
    });
    expect(second).toEqual({ ok: false, error: "already_answered" });
  });

  it("già chiusa con 'non ora' → question_not_pending, non already_answered", async () => {
    const itemId = await seedItem();
    const questionId = await seedQuestion(itemId);
    const actor = await seedActor();
    await dismissBacklogQuestion(db, { backlogItemId: itemId, questionId, actor });

    const result = await answerBacklogQuestion(db, {
      backlogItemId: itemId,
      questionId,
      actor,
      answer: { optionIndex: 0 },
    });
    expect(result).toEqual({ ok: false, error: "question_not_pending" });
  });

  it("due risposte concorrenti sulla stessa domanda: una sola vince", async () => {
    const itemId = await seedItem();
    const questionId = await seedQuestion(itemId);
    const [a, b] = await Promise.all([
      answerBacklogQuestion(db, {
        backlogItemId: itemId,
        questionId,
        actor: await seedActor(),
        answer: { optionIndex: 0 },
      }),
      answerBacklogQuestion(db, {
        backlogItemId: itemId,
        questionId,
        actor: await seedActor(),
        answer: { optionIndex: 1 },
      }),
    ]);
    const outcomes = [a, b];
    const wins = outcomes.filter((r) => r.ok);
    const losses = outcomes.filter((r) => !r.ok);
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    expect(losses[0]).toMatchObject({ error: "already_answered" });

    // Un solo messaggio system: la corsa persa non ne ha scritto uno suo.
    const messages = await db
      .select()
      .from(backlogChatMessages)
      .where(eq(backlogChatMessages.itemId, itemId));
    expect(messages).toHaveLength(1);
  });
});

describe("dismissBacklogQuestion — 'non ora'", () => {
  it("chiude la domanda SENZA rispondere, nessun messaggio in chat", async () => {
    const itemId = await seedItem();
    const questionId = await seedQuestion(itemId);
    const actor = await seedActor();

    const result = await dismissBacklogQuestion(db, { backlogItemId: itemId, questionId, actor });
    expect(result).toEqual({ ok: true, backlogItemId: itemId });

    const [row] = await db.select().from(backlogQuestions).where(eq(backlogQuestions.id, questionId));
    expect(row?.dismissedAt).toBeInstanceOf(Date);
    expect(row?.answer).toBeNull();
    expect(row?.answeredAt).toBeNull();

    const messages = await db
      .select()
      .from(backlogChatMessages)
      .where(eq(backlogChatMessages.itemId, itemId));
    expect(messages).toHaveLength(0);
  });

  it("libera il posto: dopo 'non ora' una nuova domanda può essere posta", async () => {
    const itemId = await seedItem();
    const questionId = await seedQuestion(itemId);
    await dismissBacklogQuestion(db, { backlogItemId: itemId, questionId, actor: await seedActor() });

    const second = await db.transaction((tx) =>
      askBacklogQuestion(tx, {
        backlogItemId: itemId,
        question: "Domanda successiva",
        options: [{ label: "Sì" }, { label: "No" }],
      }),
    );
    expect(second).not.toBeNull();
  });

  it("su una domanda già risposta → already_answered", async () => {
    const itemId = await seedItem();
    const questionId = await seedQuestion(itemId);
    const actor = await seedActor();
    await answerBacklogQuestion(db, { backlogItemId: itemId, questionId, actor, answer: { optionIndex: 0 } });

    const result = await dismissBacklogQuestion(db, { backlogItemId: itemId, questionId, actor });
    expect(result).toEqual({ ok: false, error: "already_answered" });
  });

  it("due volte di seguito: la seconda → question_not_pending", async () => {
    const itemId = await seedItem();
    const questionId = await seedQuestion(itemId);
    const actor = await seedActor();
    await dismissBacklogQuestion(db, { backlogItemId: itemId, questionId, actor });

    const result = await dismissBacklogQuestion(db, { backlogItemId: itemId, questionId, actor });
    expect(result).toEqual({ ok: false, error: "question_not_pending" });
  });

  it("domanda inesistente → not_found", async () => {
    const itemId = await seedItem();
    const result = await dismissBacklogQuestion(db, {
      backlogItemId: itemId,
      questionId: randomUUID(),
      actor: await seedActor(),
    });
    expect(result).toEqual({ ok: false, error: "not_found" });
  });
});

describe("closeOpenBacklogQuestion", () => {
  it("chiude senza risposta l'eventuale domanda aperta (dismissedAt, answer resta null)", async () => {
    const itemId = await seedItem();
    const questionId = await seedQuestion(itemId);

    await db.transaction((tx) => closeOpenBacklogQuestion(tx, itemId));

    const [row] = await db.select().from(backlogQuestions).where(eq(backlogQuestions.id, questionId));
    expect(row?.dismissedAt).toBeInstanceOf(Date);
    expect(row?.answer).toBeNull();
  });

  it("no-op su una voce senza domanda aperta (nessun errore)", async () => {
    const itemId = await seedItem();
    await expect(db.transaction((tx) => closeOpenBacklogQuestion(tx, itemId))).resolves.toBeUndefined();
  });

  it("non tocca una domanda già risposta", async () => {
    const itemId = await seedItem();
    const questionId = await seedQuestion(itemId);
    await answerBacklogQuestion(db, {
      backlogItemId: itemId,
      questionId,
      actor: await seedActor(),
      answer: { optionIndex: 0 },
    });

    await db.transaction((tx) => closeOpenBacklogQuestion(tx, itemId));

    const [row] = await db.select().from(backlogQuestions).where(eq(backlogQuestions.id, questionId));
    expect(row?.answer).toEqual({ optionIndex: 0 });
  });

  it("non tocca le domande aperte di ALTRE voci", async () => {
    const itemId = await seedItem();
    const otherId = await seedItem();
    const questionId = await seedQuestion(otherId);

    await db.transaction((tx) => closeOpenBacklogQuestion(tx, itemId));

    const openOfOther = await db
      .select()
      .from(backlogQuestions)
      .where(and(eq(backlogQuestions.id, questionId), isNull(backlogQuestions.dismissedAt)));
    expect(openOfOther).toHaveLength(1);
  });
});
