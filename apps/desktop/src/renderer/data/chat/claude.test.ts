import { beforeEach, describe, expect, it } from "vitest";
import { chat, failNext, resetApi, setLatency, setStreamLatency, whenIdle } from "../api";
import { setSessionPersonId } from "../session";
import { state, visibleProjectIds } from "../store";
import { subscribeChat } from "../stream";
import type { ChatMessage, ChatMessageView, ConversationEvent } from "../types";
import { grantProjectRole } from "../viewer";

// @Claude nei thread della Chat (Task 3): ogni chiamata è di chi la fa.

const as = (personId: string) => setSessionPersonId(personId);
const byId = (id: string): ChatMessage => state.chatMessages.find((m) => m.id === id)!;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Le risposte di Claude di un thread, nell'ordine. */
const claudeReplies = (rootId: string): ChatMessage[] =>
  state.chatMessages
    .filter((m) => m.threadOf === rootId && m.kind === "claude")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

/** L'ultima risposta di Claude chiamata da `personId` nel thread, finita di arrivare. */
async function replyOf(rootId: string, personId: string): Promise<ChatMessage> {
  const reply = claudeReplies(rootId)
    .filter((m) => m.calledById === personId)
    .at(-1);
  expect(reply, `risposta chiamata da ${personId}`).toBeDefined();
  await chat.whenClaudeIdle(reply!.id);
  return byId(reply!.id);
}

const proposalOf = (m: { claudeEvents?: ConversationEvent[] }) => {
  const p = m.claudeEvents?.find((e) => e.type === "proposal");
  return p?.type === "proposal" ? p : undefined;
};

/** Il thread «Billing emails (AUD-4)» del general di AUD, con la risposta di Claude del seme. */
const BILLING = "ch-aud-general-m17";
const SEED_REPLY = "ch-aud-general-m17-r3";

beforeEach(() => {
  setLatency(0);
  setStreamLatency(null);
  resetApi();
});

describe("@Claude: quando risponde e dove", () => {
  it("senza «@Claude» Claude non risponde; «@Claudette» non è una chiamata", async () => {
    as("p-marco");
    const before = state.chatMessages.filter((m) => m.kind === "claude").length;
    await chat.sendMessage("ch-aud-general", {
      text: "Claude would know, I think",
      threadOf: BILLING,
    });
    await chat.sendMessage("ch-aud-general", { text: "@Claudette any news?" });
    await settle();
    expect(state.chatMessages.filter((m) => m.kind === "claude")).toHaveLength(before);
  });

  it("chiamato da un messaggio nel canale, risponde nel thread di quel messaggio, marcato «chiamato da»", async () => {
    as("p-giulia");
    const call = await chat.sendMessage("ch-announcements", { text: "@Claude explain AUD-4" });
    expect(call.threadOf).toBeNull();
    const [reply] = claudeReplies(call.id);
    // Nasce subito, vuota e al lavoro, nel thread: mai nel flusso del canale.
    expect(reply).toMatchObject({
      kind: "claude",
      authorId: "p-claude",
      calledById: "p-giulia",
      threadOf: call.id,
      claudeRun: { callMessageId: call.id, state: "working" },
    });
    expect(reply!.alsoInChannel).toBeUndefined();
    const flow = (await chat.listMessages("ch-announcements"))!;
    expect(flow.messages.some((m) => m.kind === "claude")).toBe(false);
    expect(flow.messages.find((m) => m.id === call.id)?.thread?.claudeReplying).toBe(true);

    const done = await replyOf(call.id, "p-giulia");
    expect(done.claudeRun?.state).toBe("done");
    expect(done.text).toContain("Billing emails with the new invoice layout");
    expect(done.citations).toContainEqual({ kind: "task", id: "t-aud-4" });
    expect(done.claudeEvents?.some((e) => e.type === "action" && e.state === "done")).toBe(true);
    const after = (await chat.listMessages("ch-announcements"))!;
    expect(after.messages.find((m) => m.id === call.id)?.thread?.claudeReplying).toBe(false);
  });

  it("chiamato in un thread, risponde in quel thread", async () => {
    as("p-marco");
    await chat.sendMessage("ch-aud-general", { text: "@Claude explain AUD-5", threadOf: BILLING });
    const reply = await replyOf(BILLING, "p-marco");
    expect(reply.threadOf).toBe(BILLING);
    const thread = (await chat.listThread(BILLING))!;
    expect(thread.replies.at(-1)?.id).toBe(reply.id);
  });
});

describe("@Claude: legge come chi lo chiama", () => {
  it("Giulia si fa spiegare AUD-4 dove Sara non vede AUD; Sara legge lo stesso testo (maintainer)", async () => {
    as("p-giulia");
    const call = await chat.sendMessage("ch-announcements", { text: "@Claude explain AUD-4" });
    const reply = await replyOf(call.id, "p-giulia");
    expect(reply.text).toContain("Billing emails with the new invoice layout");

    as("p-sara");
    const thread = (await chat.listThread(call.id))!;
    const seen = thread.replies.find((r) => r.id === reply.id)!;
    expect(seen.text).toBe(reply.text);
    expect(seen.calledById).toBe("p-giulia");
  });

  it("la stessa domanda chiamata da Sara, che non vede AUD, non trova nulla", async () => {
    as("p-sara");
    const call = await chat.sendMessage("ch-announcements", { text: "@Claude explain AUD-4" });
    const reply = await replyOf(call.id, "p-sara");
    expect(reply.text).not.toContain("Billing emails");
    expect(reply.citations).not.toContainEqual({ kind: "task", id: "t-aud-4" });
  });

  it("legge il thread come contesto: «plan it for W45» sotto un messaggio su AUD-4", async () => {
    as("p-giulia");
    await chat.sendMessage("ch-aud-general", {
      text: "@Claude plan it for W45",
      threadOf: BILLING,
    });
    const reply = await replyOf(BILLING, "p-giulia");
    const read = reply.claudeEvents?.find((e) => e.type === "action" && e.tool === "read_thread");
    expect(read).toBeDefined();
    const proposal = proposalOf(reply)!;
    expect(proposal).toMatchObject({ requesterId: "p-giulia", status: "open" });
    expect(proposal.actions[0]).toMatchObject({
      fn: "planTask",
      args: { id: "t-aud-4", plan: { week: "2026-W45" } },
    });
  });

  it("un «grazie» nel thread non diventa una spiegazione del codice del thread", async () => {
    as("p-giulia");
    await chat.sendMessage("ch-aud-general", { text: "@Claude thanks!", threadOf: BILLING });
    const reply = await replyOf(BILLING, "p-giulia");
    expect(reply.citations).not.toContainEqual({ kind: "task", id: "t-aud-4" });
    expect(proposalOf(reply)).toBeUndefined();
  });
});

describe("@Claude: due chiamate nello stesso thread (Review Focus 4)", () => {
  it("due risposte, ognuna «chiamata da» chi l'ha chiamata; ogni proposta la conferma solo il suo richiedente", async () => {
    as("p-giulia");
    await chat.sendMessage("ch-aud-general", {
      text: "@Claude create a task: “Invoice PDF size check in staging”",
      threadOf: BILLING,
    });
    as("p-marco");
    await chat.sendMessage("ch-aud-general", {
      text: "@Claude create a task: “Billing email copy review”",
      threadOf: BILLING,
    });
    const giulias = await replyOf(BILLING, "p-giulia");
    const marcos = await replyOf(BILLING, "p-marco");
    expect(giulias.id).not.toBe(marcos.id);
    const pg = proposalOf(giulias)!;
    const pm = proposalOf(marcos)!;
    expect(pg.requesterId).toBe("p-giulia");
    expect(pm.requesterId).toBe("p-marco");

    // Marco non conferma, non annulla, non modifica quella di Giulia (e viceversa).
    await expect(chat.confirmChatProposal(giulias.id, pg.proposalId)).rejects.toThrow("forbidden");
    await expect(chat.cancelChatProposal(giulias.id, pg.proposalId)).rejects.toThrow("forbidden");
    await expect(chat.editChatProposal(giulias.id, pg.proposalId)).rejects.toThrow("forbidden");
    as("p-giulia");
    await expect(chat.confirmChatProposal(marcos.id, pm.proposalId)).rejects.toThrow("forbidden");
    expect(state.tasks.some((t) => t.title === "Billing email copy review")).toBe(false);

    const outcome = await chat.confirmChatProposal(giulias.id, pg.proposalId);
    expect(outcome.status).toBe("confirmed");
    const created = state.tasks.find((t) => t.title === "Invoice PDF size check in staging")!;
    expect(created.projectId).toBe("prj-aud");
    expect(proposalOf(byId(giulias.id))).toMatchObject({
      status: "confirmed",
      resultCodes: [created.code],
    });
    // Una conferma sola.
    await expect(chat.confirmChatProposal(giulias.id, pg.proposalId)).rejects.toThrow(
      "invalid: status",
    );

    as("p-marco");
    await chat.cancelChatProposal(marcos.id, pm.proposalId);
    const thread = (await chat.listThread(BILLING))!;
    expect(proposalOf(thread.replies.find((r) => r.id === marcos.id)!)?.status).toBe("cancelled");
    expect(proposalOf(thread.replies.find((r) => r.id === giulias.id)!)?.status).toBe("confirmed");
  });

  it("la proposta del seme: la conferma Marco che l'ha chiesta, con la logica tutto-o-niente dell'area 3", async () => {
    as("p-giulia");
    await expect(chat.confirmChatProposal(SEED_REPLY, "prop-chat-aud-pdf-1")).rejects.toThrow(
      "forbidden",
    );
    as("p-marco");
    // Ora solo «viewer» in AUD, senza creare task: non fatta, nulla cambia, la proposta lo dice.
    grantProjectRole("p-marco", "prj-aud", "viewer");
    const tasksBefore = state.tasks.length;
    const failed = await chat.confirmChatProposal(SEED_REPLY, "prop-chat-aud-pdf-1");
    expect(failed.status).toBe("failed");
    expect(state.tasks.length).toBe(tasksBefore);
    expect(proposalOf(byId(SEED_REPLY))).toMatchObject({ status: "failed" });
  });

  it("scade dopo 20 messaggi del thread: si legge «expired» e non si conferma più", async () => {
    as("p-marco");
    for (let i = 0; i < 20; i++) {
      await chat.sendMessage("ch-aud-general", { text: `note ${i}`, threadOf: BILLING });
    }
    const thread = (await chat.listThread(BILLING))!;
    expect(proposalOf(thread.replies.find((r) => r.id === SEED_REPLY)!)?.status).toBe("expired");
    await expect(chat.confirmChatProposal(SEED_REPLY, "prop-chat-aud-pdf-1")).rejects.toThrow(
      "expired",
    );
  });

  it("19 messaggi dopo è ancora aperta", async () => {
    as("p-marco");
    for (let i = 0; i < 19; i++) {
      await chat.sendMessage("ch-aud-general", { text: `note ${i}`, threadOf: BILLING });
    }
    const thread = (await chat.listThread(BILLING))!;
    expect(proposalOf(thread.replies.find((r) => r.id === SEED_REPLY)!)?.status).toBe("open");
  });
});

describe("@Claude: la risposta non blocca le persone", () => {
  it("una risposta scritta mentre Claude scrive entra subito, in ordine, e lo stream continua", async () => {
    setStreamLatency(5);
    as("p-giulia");
    await chat.sendMessage("ch-aud-general", { text: "@Claude explain AUD-4", threadOf: BILLING });
    const [reply] = claudeReplies(BILLING).filter((m) => m.calledById === "p-giulia");
    // Claude sta già scrivendo (il primo pezzo è arrivato).
    while (byId(reply!.id).text === "") await new Promise((resolve) => setTimeout(resolve, 1));
    const updates: string[] = [];
    as("p-marco");
    const off = subscribeChat(chat.threadStream(BILLING), (m: ChatMessageView, mode) => {
      if (mode === "append") updates.push(m.id);
    });
    const marco = await chat.sendMessage("ch-aud-general", { text: "Thanks!", threadOf: BILLING });
    // Claude sta ancora scrivendo, e la risposta di Marco è già nel thread.
    expect(byId(reply!.id).claudeRun?.state).toBe("working");
    expect(updates).toContain(marco.id);
    const thread = (await chat.listThread(BILLING))!;
    const ids = thread.replies.map((r) => r.id);
    expect(ids.indexOf(reply!.id)).toBeLessThan(ids.indexOf(marco.id));
    await chat.whenClaudeIdle(reply!.id);
    off();
    expect(byId(reply!.id)).toMatchObject({ claudeRun: { state: "done" } });
    expect(byId(reply!.id).text).toContain("Billing emails");
  });
});

describe("@Claude: fermare, rifare, eliminare (solo chi chiama)", () => {
  it("«Stop» solo per chi ha chiamato: il testo arrivato resta, non ne arriva altro", async () => {
    setStreamLatency(5);
    as("p-giulia");
    await chat.sendMessage("ch-aud-general", { text: "@Claude explain AUD-4", threadOf: BILLING });
    const [reply] = claudeReplies(BILLING).filter((m) => m.calledById === "p-giulia");
    as("p-marco");
    await expect(chat.stopClaudeReply(reply!.id)).rejects.toThrow("forbidden");
    as("p-giulia");
    await chat.stopClaudeReply(reply!.id);
    const frozen = byId(reply!.id).text;
    await chat.whenClaudeIdle(reply!.id);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(byId(reply!.id)).toMatchObject({ text: frozen, claudeRun: { state: "stopped" } });
    expect(
      byId(reply!.id).claudeEvents?.some((e) => e.type === "action" && e.state === "running"),
    ).toBe(false);
    await expect(chat.stopClaudeReply(reply!.id)).rejects.toThrow("invalid: status");
  });

  it("fermata mentre pensa (prima del primo pezzo): non scrive nulla", async () => {
    setLatency(20);
    setStreamLatency(0);
    as("p-giulia");
    await chat.sendMessage("ch-aud-general", { text: "@Claude explain AUD-4", threadOf: BILLING });
    const [reply] = claudeReplies(BILLING).filter((m) => m.calledById === "p-giulia");
    await chat.stopClaudeReply(reply!.id);
    await chat.whenClaudeIdle(reply!.id);
    expect(byId(reply!.id)).toMatchObject({
      text: "",
      claudeEvents: [],
      claudeRun: { state: "stopped" },
    });
  });

  it("una risposta fallita mostra il motivo; «Try again» solo per chi ha chiamato, una volta", async () => {
    as("p-giulia");
    failNext("chat.claudeReply");
    await chat.sendMessage("ch-aud-general", { text: "@Claude explain AUD-4", threadOf: BILLING });
    const failed = await replyOf(BILLING, "p-giulia");
    expect(failed.claudeRun).toMatchObject({ state: "failed" });
    // Un codice, mai il testo grezzo dell'errore: la UI lo dice nella sua lingua.
    expect(failed.claudeRun?.errorCode).toBe("other");
    expect(JSON.stringify(failed.claudeRun)).not.toContain("Simulated");
    expect(failed.text).toBe("");

    as("p-marco");
    await expect(chat.retryClaudeReply(failed.id)).rejects.toThrow("forbidden");
    as("p-giulia");
    const again = await chat.retryClaudeReply(failed.id);
    expect(again).toMatchObject({ calledById: "p-giulia", threadOf: BILLING });
    expect(again.id).not.toBe(failed.id);
    expect(byId(failed.id).claudeRun).toMatchObject({ state: "failed", retried: true });
    await chat.whenClaudeIdle(again.id);
    expect(byId(again.id)).toMatchObject({ claudeRun: { state: "done" } });
    expect(byId(again.id).text).toContain("Billing emails");
    await expect(chat.retryClaudeReply(failed.id)).rejects.toThrow("invalid: status");
  });

  it("solo chi ha chiamato elimina la risposta; la sua proposta aperta decade con lei", async () => {
    as("p-giulia");
    await chat.sendMessage("ch-aud-general", {
      text: "@Claude plan it for W45",
      threadOf: BILLING,
    });
    const reply = await replyOf(BILLING, "p-giulia");
    const proposal = proposalOf(reply)!;
    as("p-marco");
    await expect(chat.deleteMessage(reply.id)).rejects.toThrow("forbidden");
    as("p-roberta");
    await expect(chat.deleteMessage(reply.id)).rejects.toThrow();
    as("p-giulia");
    await chat.deleteMessage(reply.id);
    expect(byId(reply.id)).toMatchObject({ text: "", claudeEvents: [], deletedById: "p-giulia" });
    await expect(chat.confirmChatProposal(reply.id, proposal.proposalId)).rejects.toThrow(
      "not_found",
    );
    expect(state.tasksById.get("t-aud-4")!.plannedWeek).not.toBe("2026-W45");
  });

  it("eliminata mentre arriva: si ferma, e nessun pezzo né riga arriva dopo", async () => {
    setStreamLatency(5);
    as("p-giulia");
    await chat.sendMessage("ch-aud-general", {
      text: "@Claude plan it for W45",
      threadOf: BILLING,
    });
    const [reply] = claudeReplies(BILLING).filter((m) => m.calledById === "p-giulia");
    await chat.deleteMessage(reply!.id);
    await chat.whenClaudeIdle(reply!.id);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(byId(reply!.id)).toMatchObject({ text: "", claudeEvents: [], citations: [] });
    expect(byId(reply!.id).claudeRun?.state).toBe("stopped");
  });
});

describe("@Claude: ripristino dello stato", () => {
  it("una risposta in volo durante `resetApi` non scrive nulla nello stato nuovo", async () => {
    setStreamLatency(5);
    as("p-giulia");
    await chat.sendMessage("ch-aud-general", { text: "@Claude explain AUD-4", threadOf: BILLING });
    const [reply] = claudeReplies(BILLING).filter((m) => m.calledById === "p-giulia");
    const replyId = reply!.id;
    resetApi();
    const fresh = JSON.stringify(state.chatMessages);
    await new Promise((resolve) => setTimeout(resolve, 120));
    await whenIdle(`chat:claude:${replyId}`);
    expect(state.chatMessages.some((m) => m.id === replyId)).toBe(false);
    expect(JSON.stringify(state.chatMessages)).toBe(fresh);
  });

  it("anche quando il ripristino arriva mentre Claude pensa (prima dei passi)", async () => {
    setLatency(5);
    as("p-giulia");
    const sent = chat.sendMessage("ch-aud-general", {
      text: "@Claude explain AUD-4",
      threadOf: BILLING,
    });
    await sent;
    resetApi();
    const fresh = JSON.stringify(state.chatMessages);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(JSON.stringify(state.chatMessages)).toBe(fresh);
  });
});

describe("@Claude: la domanda a chi chiama (R-G4)", () => {
  type Question = Extract<ConversationEvent, { type: "question" }>;
  /** Giulia chiede di assegnare AUD-4 senza dire a chi: Claude le chiede a chi. */
  async function ask(): Promise<{ reply: ChatMessage; question: Question }> {
    as("p-giulia");
    await chat.sendMessage("ch-aud-general", { text: "@Claude assign AUD-4", threadOf: BILLING });
    const reply = await replyOf(BILLING, "p-giulia");
    const question = reply.claudeEvents?.find((e): e is Question => e.type === "question");
    expect(question).toBeDefined();
    return { reply, question: question! };
  }

  it("la risposta aspetta chi ha chiamato; solo lui risponde, e la risposta continua il lavoro", async () => {
    const { reply, question } = await ask();
    expect(reply.claudeRun?.state).toBe("waiting");
    expect(question.answer).toBeNull();
    expect(question.options.map((o) => o.label)).toContain("Matteo Conti");
    // La riga del thread non dice «Claude is replying…» mentre aspetta una persona.
    expect((await chat.listThread(BILLING))!.root.thread?.claudeReplying).toBe(false);

    // In «Da decidere» la vede solo chi ha chiamato.
    expect(await chat.listClaudeQuestions()).toEqual([
      expect.objectContaining({
        messageId: reply.id,
        questionId: question.questionId,
        rootId: BILLING,
      }),
    ]);
    const matteo = question.options.findIndex((o) => o.label === "Matteo Conti");
    const pick = { optionIndex: matteo, text: null };
    for (const other of ["p-marco", "p-roberta"]) {
      as(other);
      expect(await chat.listClaudeQuestions()).toEqual([]);
      await expect(
        chat.answerChatClaudeQuestion(reply.id, question.questionId, pick),
      ).rejects.toThrow("forbidden");
    }

    as("p-giulia");
    await chat.answerChatClaudeQuestion(reply.id, question.questionId, pick);
    await chat.whenClaudeIdle(reply.id);
    const done = byId(reply.id);
    expect(done.claudeRun?.state).toBe("done");
    expect(done.claudeEvents!.find((e) => e.type === "question")).toMatchObject({
      answer: { optionIndex: matteo, byId: "p-giulia" },
    });
    expect(proposalOf(done)).toMatchObject({
      status: "open",
      requesterId: "p-giulia",
      actions: [{ fn: "updateTask", args: { id: "t-aud-4", patch: { assigneeId: "p-matteo" } } }],
    });
    // La lettura di AUD-4 fatta prima della domanda non si ripete.
    expect(
      done.claudeEvents!.filter((e) => e.type === "action" && e.tool === "get_ticket"),
    ).toHaveLength(1);
    // Risposta in un posto, chiusa ovunque.
    expect(await chat.listClaudeQuestions()).toEqual([]);
    await expect(
      chat.answerChatClaudeQuestion(reply.id, question.questionId, pick),
    ).rejects.toThrow("already_answered");
  });

  it("fermare o eliminare la risposta chiude la domanda", async () => {
    const first = await ask();
    await chat.stopClaudeReply(first.reply.id);
    expect(byId(first.reply.id).claudeRun?.state).toBe("stopped");
    expect(await chat.listClaudeQuestions()).toEqual([]);
    await expect(
      chat.answerChatClaudeQuestion(first.reply.id, first.question.questionId, {
        optionIndex: 0,
        text: null,
      }),
    ).rejects.toThrow("invalid: status");

    const second = await ask();
    await chat.deleteMessage(second.reply.id);
    expect(byId(second.reply.id)).toMatchObject({
      claudeEvents: [],
      claudeRun: { state: "stopped" },
    });
    expect(await chat.listClaudeQuestions()).toEqual([]);
  });
});

describe("@Claude: la domanda, i bordi", () => {
  it("due risposte insieme di chi ha chiamato: una passa, l'altra è `already_answered`", async () => {
    as("p-giulia");
    await chat.sendMessage("ch-aud-general", { text: "@Claude assign AUD-4", threadOf: BILLING });
    const reply = await replyOf(BILLING, "p-giulia");
    const q = reply.claudeEvents!.find((e) => e.type === "question")!;
    if (q.type !== "question") throw new Error("question");
    const results = await Promise.allSettled([
      chat.answerChatClaudeQuestion(reply.id, q.questionId, { optionIndex: 0, text: null }),
      chat.answerChatClaudeQuestion(reply.id, q.questionId, { optionIndex: 1, text: null }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((lost.reason as Error).message).toBe("already_answered");
    expect((lost.reason as Error & { byId?: string }).byId).toBe("p-giulia");
    await chat.whenClaudeIdle(reply.id);
    const answered = byId(reply.id).claudeEvents!.find((e) => e.type === "question")!;
    expect(answered).toMatchObject({ answer: { optionIndex: 0 } });
  });

  it("uscire dal canale ferma la risposta che aspetta: la domanda non è più in «Da decidere»", async () => {
    as("p-giulia");
    const call = await chat.sendMessage("ch-announcements", { text: "@Claude assign AUD-4" });
    const reply = await replyOf(call.id, "p-giulia");
    expect(reply.claudeRun?.state).toBe("waiting");
    expect(await chat.listClaudeQuestions()).toHaveLength(1);
    await chat.leaveChannel("ch-announcements");
    expect(byId(reply.id).claudeRun?.state).toBe("stopped");
    expect(await chat.listClaudeQuestions()).toEqual([]);
  });
});

describe("@Claude: nessun oracolo di esistenza nelle righe (R-G5)", () => {
  it("un codice nascosto non trovato e uno inesistente si leggono identici, per chi chiama e per un terzo", async () => {
    const visible = visibleProjectIds("p-giulia");
    const hidden = state.tasks.find((t) => !visible.has(t.projectId))!;
    const prefix = hidden.code.split("-")[0]!;
    const missing = `${prefix}-9999`;
    expect(state.tasks.some((t) => t.code === missing)).toBe(false);

    as("p-giulia");
    const views: Record<string, string> = {};
    for (const code of [hidden.code, missing]) {
      const call = await chat.sendMessage("ch-announcements", { text: `@Claude explain ${code}` });
      const reply = await replyOf(call.id, "p-giulia");
      for (const reader of ["p-giulia", "p-marco"]) {
        as(reader);
        const view = (await chat.listThread(call.id))!.replies.find((r) => r.id === reply.id)!;
        expect(view.hiddenCodes).toEqual([]);
        // Tolto il codice, la riga e il testo sono gli stessi.
        views[`${reader}:${code}`] = JSON.stringify({
          text: view.text,
          citations: view.citations,
          events: view.claudeEvents!.map((e) => ({ ...e, id: "", at: "" })),
        }).replaceAll(code, "CODE");
      }
      as("p-giulia");
    }
    expect(views[`p-giulia:${hidden.code}`]).toBe(views[`p-giulia:${missing}`]);
    expect(views[`p-marco:${hidden.code}`]).toBe(views[`p-marco:${missing}`]);
  });
});

describe("@Claude: righe d'azione e proposte per chi non vede (R-E9)", () => {
  it("il nome di un codice che il lettore non vede non esce da riassunti, righe e argomenti", async () => {
    as("p-giulia");
    const call = await chat.sendMessage("ch-announcements", {
      text: "@Claude plan AUD-4 for W45",
    });
    const reply = await replyOf(call.id, "p-giulia");
    const title = state.tasksById.get("t-aud-4")!.title;
    const view = async () =>
      (await chat.listThread(call.id))!.replies.find((r) => r.id === reply.id)!;

    const mine = await view();
    expect(proposalOf(mine)!.actions[0]!.summary).toContain(`AUD-4 ${title}`);
    expect(proposalOf(mine)!.actions[0]!.args).not.toEqual({});
    expect(mine.hiddenCodes).toEqual([]);

    // Sara non vede AUD: il codice resta, il nome no, gli argomenti nemmeno.
    as("p-sara");
    const hers = await view();
    const summary = proposalOf(hers)!.actions[0]!.summary;
    expect(summary).toContain("AUD-4");
    expect(summary).not.toContain(title);
    // Anche la frase registrata, che il lettore rilegge nella sua lingua.
    expect(proposalOf(mine)!.actions[0]!.summaryText?.params?.task).toBe(`AUD-4 ${title}`);
    expect(proposalOf(hers)!.actions[0]!.summaryText?.params?.task).toBe("AUD-4");
    expect(proposalOf(hers)!.actions[0]!.args).toEqual({});
    expect(hers.hiddenCodes).toEqual(["AUD-4"]);
    const rows = JSON.stringify(hers.claudeEvents!.filter((e) => e.type === "action"));
    expect(rows).not.toContain(title);
  });

  it("la domanda in «Da decidere» passa dalla stessa riscrittura del thread", async () => {
    as("p-giulia");
    const call = await chat.sendMessage("ch-announcements", { text: "@Claude assign AUD-4" });
    const reply = await replyOf(call.id, "p-giulia");
    const title = state.tasksById.get("t-aud-4")!.title;
    const question = reply.claudeEvents!.find((e) => e.type === "question")!;
    // Il testo registrato nomina il titolo; Giulia poi smette di vedere AUD.
    if (question.type === "question") question.text = `Who should take AUD-4 ${title}?`;
    const project = state.projectsById.get("prj-aud")!;
    project.memberIds = project.memberIds.filter((id) => id !== "p-giulia");
    expect(visibleProjectIds("p-giulia").has("prj-aud")).toBe(false);
    const [listed] = await chat.listClaudeQuestions();
    expect(listed?.text).toContain("AUD-4");
    expect(listed?.text).not.toContain(title);
  });
});

describe("@Claude: revisione finale dell'area", () => {
  it("chi non è più membro non conferma, annulla né modifica una proposta", async () => {
    as("p-giulia");
    const call = await chat.sendMessage("ch-announcements", { text: "@Claude plan AUD-4 for W45" });
    const reply = await replyOf(call.id, "p-giulia");
    const proposal = proposalOf(reply)!;
    expect(proposal.status).toBe("open");
    await chat.leaveChannel("ch-announcements");
    for (const attempt of [
      () => chat.confirmChatProposal(reply.id, proposal.proposalId),
      () => chat.cancelChatProposal(reply.id, proposal.proposalId),
      () => chat.editChatProposal(reply.id, proposal.proposalId),
      () => chat.completeEditedChatProposal(reply.id, proposal.proposalId, []),
    ]) {
      await expect(attempt()).rejects.toThrow("forbidden");
    }
    expect(proposalOf(byId(reply.id))?.status).toBe("open");
  });

  it("eliminare il canale mentre Claude risponde ferma la risposta, senza errori lasciati in giro", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      setStreamLatency(5);
      as("p-roberta");
      const call = await chat.sendMessage("ch-announcements", { text: "@Claude explain AUD-4" });
      const [reply] = claudeReplies(call.id);
      await chat.deleteChannel("ch-announcements");
      await expect(chat.whenClaudeIdle(reply!.id)).resolves.toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(state.chatMessages.some((m) => m.channelId === "ch-announcements")).toBe(false);
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});
