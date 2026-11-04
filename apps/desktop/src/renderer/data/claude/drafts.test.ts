import i18n from "i18next";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTask, resetApi, setLatency } from "../api";
import { streamClaudeDraft } from "../mail/compose";
import { MAIL_CASES } from "../seed/mail";
import { PEOPLE } from "../seed/people";
import { setSessionPersonId } from "../session";
import { setStreamLatency, state } from "../store";
import { draftText, supportReplyDraftFor } from "../support/visibility";
import type { ConversationEvent } from "../types";
import { contextOf, presentEventFor } from "./context";
import { mailDraftFor, taskDescriptionDraftFor } from "./drafts";

// Le bozze di Claude nei quattro campi (area 10b, Task 8, D1): i testi, letti
// con la visibilità di chi chiede, e nessuna scrittura. Il campo, il segno e
// la riga sono del Task 10.

const as = (personId: string) => setSessionPersonId(personId);
const threadOf = (id: string) => state.mailMessages.find((m) => m.id === id)!.threadId;
/** La conversazione condivisa di AUD: nelle caselle di Giulia, Matteo e Laura. */
const BILLING = () => threadOf(MAIL_CASES.shared);
/** Solo nella casella di Matteo. */
const MATTEO_ONLY = () => threadOf(MAIL_CASES.pending);
const SUP_ACQ_2 = "sup-acq-2";
const ACQ_7 = "t-acq-7";
/** Le persone del team (mai Claude) i cui nomi una bozza che esce non deve dire. */
const teamNames = (except: string[] = []) =>
  PEOPLE.filter((p) => !p.isClaude && !except.includes(p.id)).flatMap((p) => [
    p.name.toLowerCase(),
  ]);

beforeEach(() => {
  resetApi();
  setLatency(0);
  setStreamLatency(0);
  void i18n.changeLanguage("en");
});
afterEach(() => void i18n.changeLanguage("en"));

describe("supportReplyDraftFor", () => {
  it("Davide (`support.reply` in ACQ): il testo di `draftText`, senza nomi del team", () => {
    const c = state.supportConversations.find((x) => x.id === SUP_ACQ_2)!;
    const text = supportReplyDraftFor("p-davide", SUP_ACQ_2)!;
    expect(text).toBe(draftText(c));
    for (const name of teamNames()) expect(text.toLowerCase()).not.toContain(name);
  });

  it("senza `support.reply`, o senza vedere il progetto: `null`", () => {
    expect(supportReplyDraftFor("p-sara", SUP_ACQ_2)).toBeNull();
    expect(supportReplyDraftFor("p-giulia", SUP_ACQ_2)).toBeNull();
    expect(supportReplyDraftFor("p-davide", "sup-none")).toBeNull();
  });
});

describe("mailDraftFor (D1)", () => {
  it("Giulia sulla sua conversazione: lo stesso testo di «Ask Claude» con la stessa indicazione; nessun invio", async () => {
    as("p-giulia");
    const messages = state.mailMessages.length;
    const drafts = state.mailDrafts.length;
    const hint = "tell them it lands on Monday";
    const draft = await mailDraftFor("p-giulia", BILLING(), hint);
    const ask = await streamClaudeDraft({ threadId: BILLING(), hint }, () => {}).result;
    expect(draft).toEqual({ ok: true, text: ask.text, used: ask.used.map((u) => u.code) });
    if (!draft.ok) return;
    for (const name of teamNames(["p-giulia"])) {
      expect(draft.text.toLowerCase()).not.toContain(name);
    }
    expect(state.mailMessages).toHaveLength(messages);
    expect(state.mailDrafts).toHaveLength(drafts);
  });

  it("una conversazione di un'altra casella, anche per un admin: `not_found` (mailbox_owner)", async () => {
    expect(await mailDraftFor("p-roberta", MATTEO_ONLY(), "")).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await mailDraftFor("p-giulia", MATTEO_ONLY(), "")).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("l'email nuova: con l'indicazione la bozza; senza, `hint`", async () => {
    await i18n.changeLanguage("it");
    const draft = await mailDraftFor("p-giulia", null, "slitta a giovedì");
    expect(draft.ok).toBe(true);
    if (draft.ok) expect(draft.text).toContain("Slitta a giovedì.");
    expect(await mailDraftFor("p-giulia", null, "  ")).toEqual({ ok: false, reason: "hint" });
  });
});

describe("taskDescriptionDraftFor (D1)", () => {
  it("Laura sulla task convertita: cita la richiesta e la conversazione da cui viene; la task non cambia", () => {
    const task = state.tasksById.get(ACQ_7)!;
    const req = state.requests.find((r) => r.id === task.requestId)!;
    const conversation = state.supportConversations.find(
      (c) => c.id === req.origin!.conversationId,
    )!;
    const activity = JSON.stringify(state.activity);
    const draft = taskDescriptionDraftFor("p-laura", ACQ_7);
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect(draft.sources).toEqual([req.code, conversation.code]);
    expect(draft.text).toContain(req.code);
    expect(draft.text).toContain(req.title);
    expect(draft.text).toContain(req.description);
    expect(draft.text).toContain(conversation.code);
    expect(draft.text).toContain(conversation.messages.find((m) => m.from === "customer")!.body);
    expect(task.description).toBe("");
    expect(JSON.stringify(state.activity)).toBe(activity);
  });

  it("in it, le parole intorno sono in italiano (la bozza nella lingua di chi chiede)", async () => {
    await i18n.changeLanguage("it");
    const draft = taskDescriptionDraftFor("p-laura", ACQ_7);
    if (!draft.ok) throw new Error(draft.reason);
    expect(draft.text).toMatch(/Dalla richiesta/);
    expect(draft.text).toMatch(/urgenza: alta/);
  });

  it("senza fonti: `no_source`; senza `tickets.edit`: `forbidden`; invisibile: `not_found`", async () => {
    as("p-laura");
    const hand = await createTask({ projectId: "prj-acq", title: "A task written by hand" });
    expect(taskDescriptionDraftFor("p-laura", hand.id)).toEqual({ ok: false, reason: "no_source" });
    expect(taskDescriptionDraftFor("p-sara", ACQ_7)).toEqual({ ok: false, reason: "forbidden" });
    expect(taskDescriptionDraftFor("p-giulia", ACQ_7)).toEqual({ ok: false, reason: "not_found" });
    expect(taskDescriptionDraftFor("p-laura", "t-none")).toEqual({
      ok: false,
      reason: "not_found",
    });
  });
});

describe("contextOf: la Posta (D1)", () => {
  it("la conversazione nella propria casella: il chip «email» senza codice", () => {
    expect(contextOf("p-giulia", { kind: "mail", threadId: BILLING() })).toEqual({
      code: null,
      labelKey: "claude.panel.chip.kind.mail",
      projectId: null,
    });
    expect(contextOf("p-giulia", { kind: "mail", threadId: null })).toEqual({
      code: null,
      labelKey: "claude.panel.chip.kind.mail",
      projectId: null,
    });
  });

  it("mailbox_owner: la casella di un altro non c'è, admin compresi; senza casella nemmeno l'email nuova", () => {
    expect(contextOf("p-roberta", { kind: "mail", threadId: MATTEO_ONLY() })).toBeNull();
    expect(contextOf("p-giulia", { kind: "mail", threadId: MATTEO_ONLY() })).toBeNull();
    expect(contextOf("p-giulia", { kind: "mail", threadId: "th-none" })).toBeNull();
    // Roberta non ha una casella (seme): l'email nuova non è sua da scrivere.
    expect(contextOf("p-roberta", { kind: "mail", threadId: null })).toBeNull();
  });
});

describe("presentEventFor: un `draft` letto da chi non vede il campo (R-G5)", () => {
  type DraftEvent = Extract<ConversationEvent, { type: "draft" }>;
  const log = (author: string, draft: Omit<DraftEvent, "id" | "at" | "type">) =>
    [
      {
        id: "e1",
        at: "2026-10-23T09:00:00Z",
        type: "user",
        authorId: author,
        text: "write it",
        attachments: [],
        delivery: "delivered",
      },
      { id: "e2", at: "2026-10-23T09:00:01Z", type: "draft", ...draft },
    ] as ConversationEvent[];

  it("le note di una PR di ACQ lette da Giulia: né testo né bersaglio; Laura le legge com'erano", () => {
    const events = log("p-laura", {
      field: { kind: "releaseNotes", prId: "opr-acq-77" },
      text: "- ACQ-7: Reminder text message",
      sources: ["ACQ-7"],
      status: "placed",
    });
    const hidden = presentEventFor("p-giulia", events, 1);
    expect(hidden).toMatchObject({ type: "draft", field: null, text: "", status: "placed" });
    expect(JSON.stringify(hidden).toLowerCase()).not.toMatch(/acq|opr-|reminder/);
    expect(presentEventFor("p-laura", events, 1)).toMatchObject({
      field: { kind: "releaseNotes", prId: "opr-acq-77" },
      sources: ["ACQ-7"],
    });
  });

  it("supporto e descrizione: lo stesso, per chi non vede ACQ", () => {
    for (const field of [
      { kind: "supportReply", conversationId: SUP_ACQ_2 },
      { kind: "taskDescription", taskId: ACQ_7 },
    ] as DraftEvent["field"][]) {
      const events = log("p-laura", { field, text: "Hi Mario, ACQ-R1", status: "pending" });
      const hidden = presentEventFor("p-giulia", events, 1);
      expect(JSON.stringify(hidden).toLowerCase()).not.toMatch(/acq|mario/);
      expect(presentEventFor("p-sara", events, 1)).toMatchObject({
        field,
        text: "Hi Mario, ACQ-R1",
      });
    }
  });

  it("il corpo di un'email: solo il proprietario della casella lo legge, nemmeno chi vede la conversazione", () => {
    const subject = state.mailMessages.find((m) => m.threadId === BILLING())!.subject;
    const events = log("p-giulia", {
      field: { kind: "mailBody", threadId: BILLING() },
      text: `Hi Sofia, about “${subject}”`,
      status: "placed",
    });
    expect(presentEventFor("p-giulia", events, 1)).toMatchObject({ text: expect.any(String) });
    for (const reader of ["p-roberta", "p-matteo"]) {
      const hidden = presentEventFor(reader, events, 1);
      const json = JSON.stringify(hidden).toLowerCase();
      expect(hidden).toMatchObject({ field: null, text: "" });
      expect(json).not.toContain(subject.toLowerCase());
      expect(json).not.toContain("sofia");
      expect(json).not.toContain(BILLING().toLowerCase());
    }
  });
});
