import i18n from "i18next";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as api from "../../data/api";
import { readsAs } from "../../data/api-mutations";
import { classOfGroup } from "../../data/claude/classes";
import { contextOf } from "../../data/claude/context";
import { mailDraftFor, taskDescriptionDraftFor } from "../../data/claude/drafts";
import { MAIL_CASES } from "../../data/seed/mail";
import { PEOPLE } from "../../data/seed/people";
import { setSessionPersonId } from "../../data/session";
import { setStreamLatency, state } from "../../data/store";
import { draftText } from "../../data/support/visibility";
import type { ContextRef, ConversationEvent, ScriptStep } from "../../data/types";
import { recognize, respond, type IntentContext } from "./intents";

// L'intento «bozza» (area 10b, Task 8: S6, S6b, Posta, descrizione — D1).
// Claude scrive un testo per uno dei quattro campi dichiarati e non scrive
// mai dati: niente messaggi al cliente, niente email, niente note salvate,
// nessuna modifica della task. Inviare e salvare restano gesti della
// persona. L'invisibile non esiste (R-G5, test in minuscolo).

const en = i18n.getFixedT("en");
const it_ = i18n.getFixedT("it");
const LAURA = "p-laura";
const DAVIDE = "p-davide";
const SARA = "p-sara";
const GIULIA = "p-giulia";
const ROBERTA = "p-roberta";
const ACQ = "prj-acq";
const ACQ_PR = "opr-acq-77";
const SUP_ACQ_2 = "sup-acq-2";
const ACQ_7 = "t-acq-7";
const threadOf = (id: string) => state.mailMessages.find((m) => m.id === id)!.threadId;
/** Nelle caselle di Giulia, Matteo e Laura. */
const BILLING = () => threadOf(MAIL_CASES.shared);
/** Solo nella casella di Matteo. */
const MATTEO_ONLY = () => threadOf(MAIL_CASES.pending);

/** Il contesto come lo passa `freeTurn`: solo se chi chiede lo vede, col suo progetto. */
function as(
  personId: string,
  t = en,
  context: ContextRef | null = null,
  extra: Partial<IntentContext> = {},
): IntentContext {
  setSessionPersonId(personId);
  const seen = context ? contextOf(personId, context) : null;
  return {
    personId,
    contextProjectId: seen?.projectId ?? null,
    context: seen ? context : null,
    read: readsAs(personId),
    t,
    seed: "conv-10b-draft",
    classify: async (actions) => classOfGroup(personId, actions),
    asks: true,
    ...extra,
  };
}

const said = (steps: ScriptStep[]) =>
  steps.flatMap((s) => (s.step === "say" ? [s.text] : [])).join("\n");
type DraftEvent = Omit<Extract<ConversationEvent, { type: "draft" }>, "id" | "at">;
const drafts = (steps: ScriptStep[]): DraftEvent[] =>
  steps.flatMap((s) =>
    s.step === "event" && s.event.type === "draft" ? [s.event as unknown as DraftEvent] : [],
  );
const teamNames = (except: string[] = []) =>
  PEOPLE.filter((p) => !p.isClaude && !except.includes(p.id)).map((p) => p.name.toLowerCase());

beforeEach(() => {
  api.setLatency(0);
  setStreamLatency(0);
  api.resetApi();
  void i18n.changeLanguage("en");
});
afterEach(() => void i18n.changeLanguage("en"));

describe("recognize: la bozza", () => {
  it("un verbo di scrittura in testa e uno dei campi, en e it", () => {
    for (const text of [
      "write the reply",
      "Write the reply to ACQ-S2",
      "scrivi la risposta",
      "prepara la risposta",
      "Puoi scrivere la risposta?",
      "please draft the reply",
      "draft the release notes",
      "scrivi le note di rilascio",
      "write an email to Sofia saying it slips to Thursday",
      "scrivi un'email a Sofia per dire che slitta a giovedì",
      "write the description for ACQ-14",
      "scrivi la descrizione di ACQ-14",
      "scrivi e manda l'email",
      "write and send the reply",
      "prepara una bozza",
      "scrivi un messaggio nel canale",
    ])
      expect(recognize(text), text).toBe("draft");
  });

  it("una domanda «come si fa» resta `howto` (ruling T6 I1), in en e in it", () => {
    for (const text of [
      "how do I write release notes?",
      "how can I draft a reply to a customer?",
      "how to write the description of a task?",
      "come si scrive una bozza?",
      "come si scrivono le note di rilascio?",
      "come faccio a scrivere la risposta al cliente?",
    ])
      expect(recognize(text), text).toBe("howto");
  });

  it("gli altri restano com'erano: «descrivi» spiega, «manda» è la riga D, la decisione è delle persone", () => {
    expect(recognize("Descrivi ACQ-14")).toBe("explain");
    expect(recognize("describe ACQ-14")).toBe("explain");
    expect(recognize("manda l'email")).toBe("refused");
    expect(recognize("send the reply to the customer")).toBe("refused");
    expect(recognize("scrivi la decisione su AUD-4")).toBe("refused");
    expect(recognize("crea una task per scrivere la risposta")).toBe("create");
    expect(recognize("who wrote the release notes?")).not.toBe("draft");
  });
});

describe("S6: la risposta di supporto", () => {
  it("Davide su ACQ-S2: un `draft` `supportReply` col testo di `draftText`; nessun messaggio nuovo", async () => {
    const c = state.supportConversations.find((x) => x.id === SUP_ACQ_2)!;
    const before = c.messages.length;
    const steps = await respond(
      "write the reply",
      as(DAVIDE, en, { kind: "support", conversationId: SUP_ACQ_2 }),
    );
    const [draft, ...rest] = drafts(steps);
    expect(rest).toEqual([]);
    expect(draft).toEqual({
      type: "draft",
      field: { kind: "supportReply", conversationId: SUP_ACQ_2 },
      text: draftText(c),
      status: "pending",
    });
    for (const name of teamNames()) expect(draft!.text.toLowerCase()).not.toContain(name);
    expect(c.messages).toHaveLength(before);
    // Nessuna scheda, nessuna esecuzione: la bozza non è un'azione.
    expect(steps.some((s) => s.step === "event" && s.event.type !== "draft")).toBe(false);
  });

  it("il codice nella frase vale come il contesto (da Tasks)", async () => {
    const steps = await respond("scrivi la risposta ad ACQ-S2", as(DAVIDE, it_));
    expect(drafts(steps)[0]!.field).toEqual({ kind: "supportReply", conversationId: SUP_ACQ_2 });
  });

  it("Sara, senza `support.reply`: la riga col «Who?», nessun `draft`", async () => {
    const steps = await respond(
      "write the reply",
      as(SARA, en, { kind: "support", conversationId: SUP_ACQ_2 }),
    );
    expect(said(steps)).toBe(
      "You can't reply to this conversation · [Who?](who:replyCustomers/ACQ)",
    );
    expect(drafts(steps)).toEqual([]);
    const it = await respond("scrivi la risposta ad ACQ-S2", as(SARA, it_));
    expect(said(it)).toBe(
      "Non puoi rispondere a questa conversazione · [Chi?](who:replyCustomers/ACQ)",
    );
  });

  it("R-G5: un codice di conversazione che chi chiede non vede è come uno che non c'è", async () => {
    const hidden = await respond("write the reply to ACQ-S2", as(GIULIA));
    const missing = await respond("write the reply to ACQ-S99", as(GIULIA));
    expect(said(hidden)).toBe(said(missing).replace("ACQ-S99", "ACQ-S2"));
    expect(drafts(hidden)).toEqual([]);
  });

  it("«scrivi e manda la risposta»: la bozza e la riga D `send`, nessun messaggio", async () => {
    const c = state.supportConversations.find((x) => x.id === SUP_ACQ_2)!;
    const before = c.messages.length;
    const steps = await respond(
      "write and send the reply",
      as(DAVIDE, en, { kind: "support", conversationId: SUP_ACQ_2 }),
    );
    expect(drafts(steps)).toHaveLength(1);
    expect(said(steps)).toBe(
      "Sending is yours to do: I don't send emails or replies. [Open the reply →](#/p/ACQ/support/ACQ-S2)",
    );
    expect(c.messages).toHaveLength(before);
  });
});

describe("S6b: le note di rilascio", () => {
  it("Laura sulla PR: un `draft` `releaseNotes` con `sources`; le note della PR restano `undefined`", async () => {
    const steps = await respond(
      "draft the release notes",
      as(LAURA, en, { kind: "pr", prId: ACQ_PR }),
    );
    const [draft] = drafts(steps);
    expect(draft).toMatchObject({
      field: { kind: "releaseNotes", prId: ACQ_PR },
      sources: ["ACQ-7", "ACQ-2"],
      status: "pending",
    });
    expect(draft!.text.split("\n")).toHaveLength(2);
    expect(state.openPrs.find((p) => p.id === ACQ_PR)!.releaseNotes).toBeUndefined();
  });

  it("chi non può modificarle: la riga col «Who?», nessun `draft`", async () => {
    const steps = await respond(
      "scrivi le note di rilascio",
      as(SARA, it_, { kind: "pr", prId: ACQ_PR }),
    );
    expect(said(steps)).toBe(
      "Non puoi modificare le note di rilascio di questa pull request · [Chi?](who:release/ACQ)",
    );
    expect(drafts(steps)).toEqual([]);
  });
});

describe("R-G5: un contesto invisibile", () => {
  it("la PR di ACQ come contesto di Giulia: la frase di quando non c'è un campo, nessuna parola sulla PR", async () => {
    setSessionPersonId(GIULIA);
    const c = await api.createConversation();
    await api.sendMessage(
      c.id,
      { text: "draft the release notes" },
      { context: { kind: "pr", prId: ACQ_PR } },
    );
    await api.whenIdle(c.id);
    const events = (await api.getConversation(c.id))!.events;
    const text = events.flatMap((e) => (e.type === "assistant" ? [e.text] : [])).join("\n");
    expect(text).toBe(
      "Open the conversation, the email, the pull request or the task and ask me again.",
    );
    expect(events.some((e) => e.type === "draft")).toBe(false);
    // Anche col contesto passato a mano al motore (difesa nel motore).
    const steps = await respond("draft the release notes", {
      ...as(GIULIA),
      context: { kind: "pr", prId: ACQ_PR },
    });
    expect(said(steps)).toBe(text);
  });
});

describe("R-G5: una conversazione pubblica con un `draft`", () => {
  it("letta da chi non vede ACQ: né testo né codice nel flusso (in minuscolo)", async () => {
    setSessionPersonId(LAURA);
    const c = await api.createConversation();
    await api.sendMessage(
      c.id,
      { text: "draft the release notes" },
      { context: { kind: "pr", prId: ACQ_PR } },
    );
    await api.whenIdle(c.id);
    const own = (await api.getConversation(c.id))!.events.find((e) => e.type === "draft");
    expect(own).toMatchObject({ field: { kind: "releaseNotes", prId: ACQ_PR } });
    const touched = state.conversations.find((x) => x.id === c.id)!.touchedProjectIds;
    expect(touched).toContain(ACQ);
    await api.setVisibility(c.id, "public", { confirmedProjectIds: touched });

    setSessionPersonId(GIULIA);
    const read = (await api.getConversation(c.id))!;
    const events = JSON.stringify(read.events).toLowerCase();
    expect(read.events.find((e) => e.type === "draft")).toMatchObject({ field: null, text: "" });
    expect(events).not.toMatch(/acq|opr-|reminder|booking/);
  });
});

describe("Posta (D1)", () => {
  it("Giulia sulla sua conversazione: «scrivi la risposta» → un `draft` `mailBody` col testo di `mailDraftFor`; nessun invio", async () => {
    await i18n.changeLanguage("it");
    const messages = state.mailMessages.length;
    const steps = await respond(
      "scrivi la risposta",
      as(GIULIA, it_, { kind: "mail", threadId: BILLING() }),
    );
    const expected = await mailDraftFor(GIULIA, BILLING(), "");
    if (!expected.ok) throw new Error(expected.reason);
    const [draft] = drafts(steps);
    expect(draft).toMatchObject({
      field: { kind: "mailBody", threadId: BILLING() },
      text: expected.text,
      status: "pending",
    });
    for (const name of teamNames([GIULIA])) expect(draft!.text.toLowerCase()).not.toContain(name);
    expect(state.mailMessages).toHaveLength(messages);
  });

  it("l'email nuova: con «per dire che» la bozza; senza indicazione la riga che la chiede", async () => {
    await i18n.changeLanguage("it");
    const context: ContextRef = { kind: "mail", threadId: null };
    const steps = await respond(
      "scrivi un'email a Sofia per dire che slitta a giovedì",
      as(GIULIA, it_, context),
    );
    const [draft] = drafts(steps);
    expect(draft!.field).toEqual({ kind: "mailBody", threadId: null });
    expect(draft!.text).toContain("Slitta a giovedì.");

    const bare = await respond("scrivi un'email a Sofia", as(GIULIA, it_, context));
    expect(said(bare)).toBe("Cosa deve dire l'email?");
    expect(drafts(bare)).toEqual([]);
    await i18n.changeLanguage("en");
    const english = await respond(
      "write an email to Sofia saying it slips to Thursday",
      as(GIULIA, en, context),
    );
    expect(drafts(english)[0]!.text).toContain("It slips to Thursday.");
    expect(said(await respond("write an email to Sofia", as(GIULIA, en, context)))).toBe(
      "What should the email say?",
    );
  });

  it("mailbox_owner: Roberta (admin) sulla conversazione di Matteo non ha contesto né bozza", async () => {
    const context: ContextRef = { kind: "mail", threadId: MATTEO_ONLY() };
    expect(contextOf(ROBERTA, context)).toBeNull();
    const steps = await respond("write the reply", as(ROBERTA, en, context));
    expect(drafts(steps)).toEqual([]);
    expect(said(steps)).toBe(
      "Open the conversation, the email, the pull request or the task and ask me again.",
    );
  });

  it("dal riquadro vero: il contesto che chi scrive non vede non arriva al motore", async () => {
    setSessionPersonId(ROBERTA);
    const c = await api.createConversation();
    await api.sendMessage(
      c.id,
      { text: "write the reply" },
      { context: { kind: "mail", threadId: MATTEO_ONLY() } },
    );
    await api.whenIdle(c.id);
    const events = (await api.getConversation(c.id))!.events;
    expect(events.some((e) => e.type === "draft")).toBe(false);
  });

  it("una pubblica di Giulia con un `draft` `mailBody` letta da Roberta: né testo né oggetto", async () => {
    setSessionPersonId(GIULIA);
    const subject = state.mailMessages.find((m) => m.threadId === BILLING())!.subject;
    const c = await api.createConversation();
    await api.sendMessage(
      c.id,
      { text: "write the reply" },
      { context: { kind: "mail", threadId: BILLING() } },
    );
    await api.whenIdle(c.id);
    expect((await api.getConversation(c.id))!.events.find((e) => e.type === "draft")).toMatchObject(
      { field: { kind: "mailBody", threadId: BILLING() } },
    );
    const touched = state.conversations.find((x) => x.id === c.id)!.touchedProjectIds;
    await api.setVisibility(c.id, "public", { confirmedProjectIds: touched });

    setSessionPersonId(ROBERTA);
    const read = (await api.getConversation(c.id))!;
    const json = JSON.stringify(read).toLowerCase();
    expect(read.events.find((e) => e.type === "draft")).toMatchObject({ field: null, text: "" });
    expect(json).not.toContain(subject.toLowerCase());
    expect(json).not.toContain("sofia");
    expect(json).not.toContain(BILLING().toLowerCase());
  });

  it("«scrivi e manda l'email»: la bozza e la riga D `send`; nessun invio", async () => {
    await i18n.changeLanguage("it");
    const messages = state.mailMessages.length;
    const steps = await respond(
      "scrivi e manda l'email",
      as(GIULIA, it_, { kind: "mail", threadId: BILLING() }),
    );
    expect(drafts(steps)).toHaveLength(1);
    // La riga `draft` prima, poi la riga D.
    const draftAt = steps.findIndex((s) => s.step === "event" && s.event.type === "draft");
    const sayAt = steps.findIndex((s) => s.step === "say");
    expect(draftAt).toBeLessThan(sayAt);
    expect(said(steps)).toBe(
      `L'invio tocca a te: non mando email né risposte. [Apri la risposta →](#/mail/${BILLING()})`,
    );
    expect(state.mailMessages).toHaveLength(messages);
  });
});

describe("La descrizione di una task (D1)", () => {
  it("Laura sulla task convertita: un `draft` `taskDescription` che cita la richiesta; la task non cambia", async () => {
    const task = state.tasksById.get(ACQ_7)!;
    const activity = JSON.stringify(state.activity);
    const steps = await respond(
      "write the description",
      as(LAURA, en, { kind: "task", taskId: ACQ_7 }),
    );
    const expected = taskDescriptionDraftFor(LAURA, ACQ_7);
    if (!expected.ok) throw new Error(expected.reason);
    const [draft] = drafts(steps);
    expect(draft).toEqual({
      type: "draft",
      field: { kind: "taskDescription", taskId: ACQ_7 },
      text: expected.text,
      sources: expected.sources,
      status: "pending",
    });
    const req = state.requests.find((r) => r.id === task.requestId)!;
    expect(draft!.text).toContain(req.code);
    expect(draft!.text).toContain(req.description);
    expect(task.description).toBe("");
    expect(JSON.stringify(state.activity)).toBe(activity);
    // Col codice, da qualunque pagina.
    const coded = await respond("write the description for ACQ-7", as(LAURA));
    expect(drafts(coded)[0]!.field).toEqual({ kind: "taskDescription", taskId: ACQ_7 });
  });

  it("senza fonti: la frase del dato che manca, nessun `draft`", async () => {
    setSessionPersonId(LAURA);
    const hand = await api.createTask({ projectId: ACQ, title: "A task written by hand" });
    const steps = await respond(`write the description for ${hand.code}`, as(LAURA));
    expect(said(steps)).toBe(
      `I have nothing to write **${hand.code}**'s description from: tell me what it should say.`,
    );
    expect(drafts(steps)).toEqual([]);
    const it = await respond(`scrivi la descrizione di ${hand.code}`, as(LAURA, it_));
    expect(said(it)).toBe(
      `Non ho da dove scrivere la descrizione di **${hand.code}**: dimmi cosa deve dire.`,
    );
  });

  it("Sara su una task di ACQ senza `tickets.edit`: la riga col «Who?»", async () => {
    const steps = await respond("write the description for ACQ-7", as(SARA));
    expect(said(steps)).toBe("You can't edit **ACQ-7** · [Who?](who:editTasks/ACQ)");
    expect(drafts(steps)).toEqual([]);
  });

  it("R-G5: una task invisibile è come una che non c'è", async () => {
    const hidden = await respond("write the description for ACQ-7", as(GIULIA));
    const missing = await respond("write the description for ACQ-999", as(GIULIA));
    expect(said(hidden)).toBe(said(missing).replace("ACQ-999", "ACQ-7"));
  });
});

describe("Dove la bozza non ha un campo", () => {
  it("un contesto che non porta a un campo: la frase; con un codice, il suo link", async () => {
    const page = await respond(
      "write the reply",
      as(LAURA, en, { kind: "page", route: "tasks", projectId: ACQ }),
    );
    expect(said(page)).toBe(
      "Open the conversation, the email, the pull request or the task and ask me again.",
    );
    const coded = await respond("write the reply to ACQ-3", as(LAURA));
    expect(said(coded)).toBe(
      "Open the conversation, the email, the pull request or the task and ask me again. [Open **ACQ-3** →](#/p/ACQ/tasks?task=ACQ-3)",
    );
    expect(drafts(coded)).toEqual([]);
  });

  it("«scrivi un messaggio nel canale»: lì la bozza la scrive @Claude nel thread, nessun `draft`", async () => {
    const steps = await respond("scrivi un messaggio nel canale", as(LAURA, it_));
    expect(said(steps)).toBe("In un canale le bozze le scrive @Claude nel thread: menzionalo lì.");
    expect(drafts(steps)).toEqual([]);
  });

  it("nella Chat (senza `classify`) nessun `draft`: una riga che rimanda al riquadro (P11)", async () => {
    const steps = await respond(
      "write the reply to ACQ-S2",
      as(DAVIDE, en, null, { classify: undefined, asks: false }),
    );
    expect(drafts(steps)).toEqual([]);
    expect(said(steps)).toBe(
      "I write drafts from the Claude panel, next to the field: ask me there.",
    );
  });
});
