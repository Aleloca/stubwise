import { describe, expect, it } from "vitest";
import { readerSchema } from "./reader.js";
import { multiSelectableIndices } from "./multi-select.js";
import { answerBodySchema, inboxAnswerBodySchema, inboxGoogleSchema } from "./schemas/notification.js";

/**
 * «Una mail, più azioni e più progetti» (26 set 2026, design §2): quali
 * opzioni di una card di posta si possono SOMMARE. Una regola sola, che il
 * server usa sia per mostrare le caselle sia per accettare la risposta.
 */
const a = (type: string) => ({ type }) as { type: never };

describe("multiSelectableIndices", () => {
  it("le azioni proposte dal modello, se sono almeno due; «Sposta» e «Non fare nulla» mai", () => {
    expect(
      multiSelectableIndices("email", [
        a("create_backlog_item"),
        a("create_backlog_item"),
        a("record_decision"),
        a("reassign_project"),
        a("ignore"),
      ]),
    ).toEqual([0, 1, 2]);
  });

  it("tutti e cinque i tipi del modello si sommano", () => {
    expect(
      multiSelectableIndices("email", [
        a("create_backlog_item"),
        a("create_milestone"),
        a("update_ticket"),
        a("comment_ticket"),
        a("record_decision"),
        a("ignore"),
      ]),
    ).toEqual([0, 1, 2, 3, 4]);
  });

  it("una sola azione del modello: niente caselle, è una scelta come oggi", () => {
    expect(multiSelectableIndices("email", [a("create_backlog_item"), a("reassign_project"), a("ignore")])).toEqual([]);
  });

  it("il calendario non ha mai caselle", () => {
    expect(multiSelectableIndices("calendar", [a("create_milestone"), a("create_backlog_item"), a("ignore")])).toEqual([]);
  });

  it("lo smistamento (choose_project) e un promemoria non si sommano", () => {
    expect(multiSelectableIndices("email", [a("choose_project"), a("choose_project"), a("ignore")])).toEqual([]);
    expect(multiSelectableIndices("email", [a("acknowledge_reminder"), a("acknowledge_reminder")])).toEqual([]);
  });

  it("un tipo che questa versione non conosce non si somma", () => {
    expect(multiSelectableIndices("email", [a("create_backlog_item"), a("__unknown__"), a("create_milestone")])).toEqual([0, 2]);
  });
});

describe("InboxGoogle.multiSelectIndices", () => {
  const google = {
    source: "email",
    from: "cliente@example.com",
    subject: "Tre cose",
    signal: "request",
    actions: [{ type: "create_backlog_item" }, { type: "ignore" }],
  };

  it("una risposta SENZA il campo (server più vecchio) parsa, e vale []", () => {
    const parsed = readerSchema(inboxGoogleSchema).parse(google);
    expect(parsed.multiSelectIndices).toEqual([]);
  });

  it("col campo, lo porta com'è", () => {
    expect(inboxGoogleSchema.parse({ ...google, multiSelectIndices: [0, 1] }).multiSelectIndices).toEqual([0, 1]);
  });
});

describe("inboxAnswerBodySchema con optionIndices", () => {
  it("i corpi di prima restano validi", () => {
    expect(inboxAnswerBodySchema.safeParse({ optionIndex: 2 }).success).toBe(true);
    expect(inboxAnswerBodySchema.safeParse({ text: "sì" }).success).toBe(true);
  });

  it("accetta optionIndices da solo", () => {
    expect(inboxAnswerBodySchema.safeParse({ optionIndices: [0, 2] }).success).toBe(true);
  });

  it("esattamente uno fra optionIndex, optionIndices e text", () => {
    expect(inboxAnswerBodySchema.safeParse({}).success).toBe(false);
    expect(inboxAnswerBodySchema.safeParse({ optionIndex: 0, optionIndices: [0] }).success).toBe(false);
    expect(inboxAnswerBodySchema.safeParse({ optionIndices: [0], text: "x" }).success).toBe(false);
    expect(inboxAnswerBodySchema.safeParse({ optionIndex: 0, text: "x" }).success).toBe(false);
  });

  it("indici interi non negativi", () => {
    expect(inboxAnswerBodySchema.safeParse({ optionIndices: [-1] }).success).toBe(false);
    expect(inboxAnswerBodySchema.safeParse({ optionIndices: [0.5] }).success).toBe(false);
  });
});

/**
 * ⚠️ Le domande di un ticket e del backlog usano `answerBodySchema`, che NON
 * accetta `optionIndices`: lì una scelta multipla non esiste, e i loro
 * gestori leggono solo `optionIndex` e `text`.
 */
describe("answerBodySchema resta com'era", () => {
  it("rifiuta optionIndices", () => {
    expect(answerBodySchema.safeParse({ optionIndices: [0] }).success).toBe(false);
  });
});
