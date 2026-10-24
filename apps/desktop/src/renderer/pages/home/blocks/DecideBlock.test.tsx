import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as api from "../../../data/api";
import { setSessionPersonId } from "../../../data/session";
import { state } from "../../../data/store";
import type { ConversationEvent } from "../../../data/types";
import { clearToasts } from "../../../tasks-ui/Toast";
import { renderRoute } from "../../../test/renderRoute";
import { clearPendingAnswers, setUndoWindow } from "../pendingAnswers";

// «Decide» con le domande e i piani di Claude (Review Focus 4): la stessa
// domanda e lo stesso piano della conversazione, risolvibili sul posto con
// la forma delle richieste di decisione. Due persone: Marco (il
// richiedente di AUD-3, senza plans.approve) e Laura (plans.approve in AUD
// e STW).

const QUESTION =
  "When an imported row matches an existing contact by phone but has a different email, what should the import do?";
const PLAN_GROUP = "Decide on the plan for STW-13";

beforeEach(() => {
  api.setLatency(0);
  api.resetApi();
  setUndoWindow(0);
});

afterEach(() => {
  clearPendingAnswers();
  clearToasts();
  setUndoWindow(null);
});

const decideBlock = () => screen.findByRole("region", { name: "Decide" });
const questionOf = (id: string) =>
  state.conversationEvents.get(id)!.find((e) => e.type === "question") as Extract<
    ConversationEvent,
    { type: "question" }
  >;
const planOf = (id: string) =>
  state.conversationEvents.get(id)!.find((e) => e.type === "plan") as Extract<
    ConversationEvent,
    { type: "plan" }
  >;

describe("Decide: domande e piani di Claude", () => {
  it("Marco (richiedente) ha la domanda con le opzioni sul posto, non il piano", async () => {
    renderRoute("/home", "p-marco");
    const decide = await decideBlock();
    const group = await within(decide).findByRole("group", { name: `Answer: ${QUESTION}` });
    // La stessa forma delle richieste di decisione: chi chiede, la task citata col codice.
    const item = group.closest("[data-claude-decision]") as HTMLElement;
    expect(within(item).getByText("Claude asks")).toBeInTheDocument();
    expect(within(item).getByText("AUD-3")).toBeInTheDocument();
    // La consigliata per prima, e lo dice a parole.
    const options = within(group).getAllByRole("button");
    expect(options[0]).toHaveAccessibleName(/^Create a new contact.*Recommended/);
    // Cosa comporta ogni opzione si legge a vista, come nella conversazione.
    expect(
      within(options[0]!).getByText(
        "Nothing is overwritten; possible duplicates are listed for someone to merge.",
      ),
    ).toBeVisible();
    expect(within(group).getByRole("button", { name: "Other…" })).toBeInTheDocument();
    expect(within(decide).queryByRole("group", { name: PLAN_GROUP })).toBeNull();
  });

  it("Laura (plans.approve) ha anche il piano, con Approve e Reject", async () => {
    renderRoute("/home", "p-laura");
    const decide = await decideBlock();
    await within(decide).findByRole("group", { name: `Answer: ${QUESTION}` });
    const plan = await within(decide).findByRole("group", { name: PLAN_GROUP });
    expect(within(plan).getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(within(plan).getByRole("button", { name: "Reject…" })).toBeInTheDocument();
  });

  it("«Read the full plan» apre la sessione del piano, col piano intero", async () => {
    const router = renderRoute("/home", "p-laura");
    const decide = await decideBlock();
    const plan = await within(decide).findByRole("group", { name: PLAN_GROUP });
    const link = within(plan).getByRole("link", { name: "Read the full plan" });
    expect(link).toHaveAttribute("href", expect.stringContaining("/claude/cv-run-stw-13"));
    await userEvent.click(link);
    await waitFor(() => expect(router.state.location.pathname).toBe("/claude/cv-run-stw-13"));
    expect(
      await screen.findByRole("region", { name: /Plan · waiting for approval/ }),
    ).toBeInTheDocument();
  });

  it("Sara non vede né la domanda né il piano", async () => {
    renderRoute("/home", "p-sara");
    const decide = await decideBlock();
    // Caricato (anche le letture di Claude: finché una carica il blocco è uno scheletro).
    await waitFor(() =>
      expect(
        decide.querySelector("[data-decision], [data-request]") ??
          within(decide).queryByText("Nothing to decide"),
      ).not.toBeNull(),
    );
    expect(decide.querySelector("[data-claude-decision]")).toBeNull();
    expect(within(decide).queryByText(QUESTION)).toBeNull();
    expect(within(decide).queryByRole("group", { name: PLAN_GROUP })).toBeNull();
  });

  it("rispondere qui la chiude nella conversazione, a nome di chi risponde", async () => {
    renderRoute("/home", "p-marco");
    const decide = await decideBlock();
    const group = await within(decide).findByRole("group", { name: `Answer: ${QUESTION}` });
    await userEvent.click(within(group).getByRole("button", { name: /^Create a new contact/ }));
    expect(within(decide).queryByRole("group", { name: `Answer: ${QUESTION}` })).toBeNull();
    await waitFor(() =>
      expect(questionOf("cv-run-aud-3").answer).toMatchObject({ optionIndex: 0, byId: "p-marco" }),
    );
    expect(screen.getByText("Answered on AUD-3")).toBeInTheDocument();
    // Nella conversazione la scheda è già una riga «risposta».
    setSessionPersonId("p-marco");
    const detail = (await api.getConversation("cv-run-aud-3"))!;
    expect(detail.canAnswer).toBe(false);
  });

  it("rispondere nella conversazione (anche un altro) la toglie da Decide, dal vivo", async () => {
    renderRoute("/home", "p-laura");
    const decide = await decideBlock();
    await within(decide).findByRole("group", { name: `Answer: ${QUESTION}` });
    await act(async () => {
      setSessionPersonId("p-marco");
      await api.answerQuestion("cv-run-aud-3", "q-aud-3-1", { optionIndex: 1, text: null });
      setSessionPersonId("p-laura");
    });
    await waitFor(() =>
      expect(within(decide).queryByRole("group", { name: `Answer: ${QUESTION}` })).toBeNull(),
    );
  });

  it("risposta concorrente: la seconda sa chi ha risposto prima, e la voce se ne va", async () => {
    renderRoute("/home", "p-laura");
    const decide = await decideBlock();
    const group = await within(decide).findByRole("group", { name: `Answer: ${QUESTION}` });
    // Marco ha già risposto sul «server»; la pagina di Laura non lo sa ancora.
    questionOf("cv-run-aud-3").answer = {
      optionIndex: 1,
      text: null,
      byId: "p-marco",
      at: "2026-10-24T09:00:00Z",
    };
    await userEvent.click(within(group).getByRole("button", { name: /^Create a new contact/ }));
    expect(await screen.findByText("Already answered by Marco Bellini.")).toBeInTheDocument();
    expect(questionOf("cv-run-aud-3").answer).toMatchObject({ optionIndex: 1, byId: "p-marco" });
    await waitFor(() =>
      expect(within(decide).queryByRole("group", { name: `Answer: ${QUESTION}` })).toBeNull(),
    );
    expect(screen.queryByText(/It's back in Decide/)).toBeNull();
  });

  it("Laura approva il piano da qui: il piano è approvato da lei nella conversazione", async () => {
    renderRoute("/home", "p-laura");
    const decide = await decideBlock();
    const plan = await within(decide).findByRole("group", { name: PLAN_GROUP });
    await userEvent.click(within(plan).getByRole("button", { name: "Approve" }));
    expect(within(decide).queryByRole("group", { name: PLAN_GROUP })).toBeNull();
    await waitFor(() =>
      expect(planOf("cv-run-stw-13")).toMatchObject({ status: "approved", decidedById: "p-laura" }),
    );
    expect(screen.getByText("Plan for STW-13 approved")).toBeInTheDocument();
  });

  it("«Reject…» con le indicazioni: Claude le riceve", async () => {
    renderRoute("/home", "p-laura");
    const decide = await decideBlock();
    const plan = await within(decide).findByRole("group", { name: PLAN_GROUP });
    await userEvent.click(within(plan).getByRole("button", { name: "Reject…" }));
    await userEvent.type(
      within(decide).getByRole("textbox", { name: "What should Claude change?" }),
      "Also cover 800 × 600.",
    );
    await userEvent.click(within(decide).getByRole("button", { name: "Reject and send" }));
    await waitFor(() =>
      expect(planOf("cv-run-stw-13")).toMatchObject({
        status: "rejected",
        decidedById: "p-laura",
        instructions: "Also cover 800 × 600.",
      }),
    );
  });

  it("piano deciso da un altro nel frattempo: «Already decided by …»", async () => {
    renderRoute("/home", "p-laura");
    const decide = await decideBlock();
    const plan = await within(decide).findByRole("group", { name: PLAN_GROUP });
    const event = planOf("cv-run-stw-13");
    event.status = "approved";
    event.decidedById = "p-roberta";
    await userEvent.click(within(plan).getByRole("button", { name: "Approve" }));
    expect(await screen.findByText("Already decided by Roberta Fontana.")).toBeInTheDocument();
    expect(planOf("cv-run-stw-13").decidedById).toBe("p-roberta");
  });

  it("piano rifiutato e riscritto nel frattempo: l'approvazione resta sul piano letto", async () => {
    renderRoute("/home", "p-laura");
    const decide = await decideBlock();
    const plan = await within(decide).findByRole("group", { name: PLAN_GROUP });
    // Sul «server» Roberta ha rifiutato v1 e Claude ha scritto v2; la pagina non lo sa.
    const v1 = planOf("cv-run-stw-13");
    v1.status = "rejected";
    v1.decidedById = "p-roberta";
    v1.instructions = "Also cover 800 × 600.";
    state.conversationEvents.get("cv-run-stw-13")!.push({
      ...v1,
      id: "cv-run-stw-13-v2",
      status: "pending",
      decidedById: undefined,
      instructions: undefined,
    });
    await userEvent.click(within(plan).getByRole("button", { name: "Approve" }));
    expect(await screen.findByText("Already decided by Roberta Fontana.")).toBeInTheDocument();
    const v2 = state.conversationEvents
      .get("cv-run-stw-13")!
      .find((e) => e.id === "cv-run-stw-13-v2");
    expect(v2).toMatchObject({ status: "pending" });
  });

  it("«Undo» entro la finestra: la risposta non parte e la domanda torna", async () => {
    setUndoWindow(60_000);
    renderRoute("/home", "p-marco");
    const decide = await decideBlock();
    const group = await within(decide).findByRole("group", { name: `Answer: ${QUESTION}` });
    await userEvent.click(within(group).getByRole("button", { name: /^Create a new contact/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
    expect(
      await within(decide).findByRole("group", { name: `Answer: ${QUESTION}` }),
    ).toBeInTheDocument();
    expect(questionOf("cv-run-aud-3").answer).toBeNull();
  });

  it("il punto «ti aspetta» sulla tessera si accende quando Claude arriva a una domanda", async () => {
    // Giulia: niente da decidere in MKX se non quello che chiederà Claude.
    state.decisions = [];
    state.requests = [];
    api.setStreamLatency(0);
    renderRoute("/home", "p-giulia");
    await decideBlock();
    const tile = () => document.querySelector('a[href="/p/MKX"]');
    await waitFor(() => expect(tile()).not.toBeNull());
    expect(tile()!.querySelector('[data-signal="waiting"]')).toBeNull();
    // La sessione dal vivo di MKX-11 arriva a una domanda per Giulia.
    const off = api.subscribe("cv-run-mkx-11", () => {});
    await act(() => api.whenIdle("cv-run-mkx-11"));
    off();
    await waitFor(() => expect(tile()!.querySelector('[data-signal="waiting"]')).not.toBeNull());
    const decide = await decideBlock();
    expect(await within(decide).findByText("Claude asks")).toBeInTheDocument();
  });
});

// Task 8: le domande della Chat rivolte a te («Reply» apre il thread,
// «Ignore» la toglie per te, rispondere la chiude) e quelle di @Claude a chi
// l'ha chiamato (R-G4: rispondere qui o nel thread chiude l'altra).
describe("Decide: domande della Chat", () => {
  const ASK = "@Giulia Ferri can you check the desktop build?";
  const FROM_MARCO = /^Question from Marco Bellini/;
  const WHO_TAKES = /^Answer: Who should take AUD-4/;

  // Le richieste di decisione e da trasformare del seme riempirebbero le
  // prime cinque voci: qui contano solo le domande.
  beforeEach(() => {
    state.decisions = [];
    state.requests = [];
  });

  async function marcoAsksGiulia() {
    setSessionPersonId("p-marco");
    const m = await api.chat.sendMessage("ch-stw-desktop", { text: ASK });
    setSessionPersonId("p-giulia");
    return m;
  }

  /** Giulia chiede a @Claude di assegnare AUD-4 senza dire a chi: Claude le chiede a chi. */
  async function claudeAsksGiulia() {
    api.setStreamLatency(0);
    setSessionPersonId("p-giulia");
    await api.chat.sendMessage("ch-aud-general", {
      text: "@Claude assign AUD-4",
      threadOf: "ch-aud-general-m17",
    });
    const reply = state.chatMessages.filter((x) => x.calledById === "p-giulia").at(-1)!;
    await api.chat.whenClaudeIdle(reply.id);
    return reply.id;
  }

  it("compare con chi chiede e il canale; «Reply» apre il thread con la casella a fuoco", async () => {
    const m = await marcoAsksGiulia();
    const router = renderRoute("/home", "p-giulia");
    const decide = await decideBlock();
    const actions = await within(decide).findByRole("group", {
      name: "Question from Marco Bellini in STW · desktop-app",
    });
    const item = actions.closest("[data-chat-question]") as HTMLElement;
    expect(within(item).getByText("Marco Bellini asks you")).toBeInTheDocument();
    expect(within(item).getByText(ASK)).toBeInTheDocument();
    await userEvent.click(within(actions).getByRole("button", { name: "Reply" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/chat/ch-stw-desktop"));
    expect(router.state.location.search).toMatchObject({ thread: m.id, message: m.id });
    // Agganciato (region) o sovrapposto (dialog), secondo la larghezza.
    const panel = await waitFor(() => {
      const found =
        screen.queryByRole("region", { name: "Thread" }) ??
        screen.queryByRole("dialog", { name: "Thread" });
      expect(found).not.toBeNull();
      return found!;
    });
    const box = await within(panel).findByRole("combobox", { name: "Reply…" });
    await waitFor(() => expect(box).toHaveFocus());
  });

  it("rispondere nel thread la chiude, dal vivo", async () => {
    const m = await marcoAsksGiulia();
    renderRoute("/home", "p-giulia");
    const decide = await decideBlock();
    await within(decide).findByRole("group", { name: FROM_MARCO });
    await act(async () => {
      await api.chat.sendMessage("ch-stw-desktop", { text: "On it", threadOf: m.id });
    });
    await waitFor(() =>
      expect(within(decide).queryByRole("group", { name: FROM_MARCO })).toBeNull(),
    );
  });

  it("«Ignore» la toglie solo per chi la ignora", async () => {
    const m = await marcoAsksGiulia();
    renderRoute("/home", "p-giulia");
    const decide = await decideBlock();
    const actions = await within(decide).findByRole("group", { name: FROM_MARCO });
    await userEvent.click(within(actions).getByRole("button", { name: "Ignore" }));
    await waitFor(() =>
      expect(within(decide).queryByRole("group", { name: FROM_MARCO })).toBeNull(),
    );
    expect(screen.getByText("Question ignored")).toBeInTheDocument();
    await waitFor(async () => {
      setSessionPersonId("p-giulia");
      expect((await api.chat.listQuestions()).some((q) => q.messageId === m.id)).toBe(false);
    });
    // Il messaggio resta lì, per tutti.
    expect((await api.chat.getMessage(m.id))?.message.text).toBe(ASK);
  });

  it("cambiare persona cambia le domande: quelle di Giulia non restano a Laura", async () => {
    await marcoAsksGiulia();
    const LAURA = "@Laura Costa is the release note ready?";
    setSessionPersonId("p-marco");
    await api.chat.sendMessage("ch-stw-desktop", { text: LAURA });
    renderRoute("/home", "p-giulia");
    const decide = await decideBlock();
    await within(decide).findByRole("group", { name: FROM_MARCO });
    expect(within(decide).queryByText(LAURA)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Profile and settings" }));
    const menu = await screen.findByRole("dialog", { name: "Profile and settings" });
    await userEvent.click(within(menu).getByRole("radio", { name: /Laura Costa/ }));
    const after = await decideBlock();
    expect(await within(after).findByText(LAURA)).toBeInTheDocument();
    expect(within(after).queryByText(ASK)).toBeNull();
  });

  it("una domanda il cui messaggio viene eliminato sparisce, senza testo", async () => {
    const m = await marcoAsksGiulia();
    renderRoute("/home", "p-giulia");
    const decide = await decideBlock();
    await within(decide).findByText(ASK);
    await act(async () => {
      setSessionPersonId("p-marco");
      await api.chat.deleteMessage(m.id);
      setSessionPersonId("p-giulia");
    });
    await waitFor(() => expect(within(decide).queryByText(ASK)).toBeNull());
  });

  it("@Claude: la domanda al chiamante è anche qui; rispondere qui la chiude nel thread", async () => {
    const replyId = await claudeAsksGiulia();
    renderRoute("/home", "p-giulia");
    const decide = await decideBlock();
    const group = await within(decide).findByRole("group", { name: WHO_TAKES });
    const item = group.closest("[data-chat-claude-question]") as HTMLElement;
    expect(within(item).getByText("Claude asks")).toBeInTheDocument();
    expect(within(item).getByRole("link", { name: /AUD · general/ })).toBeInTheDocument();
    await userEvent.click(within(group).getByRole("button", { name: /^Matteo Conti/ }));
    await waitFor(() => {
      const q = state.chatMessages
        .find((x) => x.id === replyId)!
        .claudeEvents!.find((e) => e.type === "question") as Extract<
        ConversationEvent,
        { type: "question" }
      >;
      expect(q.answer).toMatchObject({ byId: "p-giulia" });
    });
    await waitFor(() =>
      expect(within(decide).queryByRole("group", { name: WHO_TAKES })).toBeNull(),
    );
  });

  it("@Claude: rispondere nel thread la toglie da qui", async () => {
    await claudeAsksGiulia();
    renderRoute("/home", "p-giulia");
    const decide = await decideBlock();
    await within(decide).findByRole("group", { name: WHO_TAKES });
    const [q] = await api.chat.listClaudeQuestions();
    await act(async () => {
      await api.chat.answerChatClaudeQuestion(q!.messageId, q!.questionId, {
        optionIndex: 0,
        text: null,
      });
    });
    await waitFor(() =>
      expect(within(decide).queryByRole("group", { name: WHO_TAKES })).toBeNull(),
    );
  });
});
