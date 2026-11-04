import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as api from "../../../data/api";
import { setSessionPersonId } from "../../../data/session";
import { state, visibleProjectIds } from "../../../data/store";
import type { ContextRef, ConversationEvent, EventDraft, TrialOutcome } from "../../../data/types";
import i18n from "../../../i18n";
import { renderWithData } from "../../../test/renderWithData";
import { Conversation } from "./Conversation";

// La riga della prova di Claude (area 10b, Task 11; shape
// `claude-automations.md` §3.3): in testa «Tested on 2 examples · nothing was
// created», una riga per esempio — segno, esempio (codice apribile, titolo,
// i dati del filtro fra parentesi letti dalla prova), esito al condizionale,
// «Open the test» — e nessun «Turn on» nel flusso. Gli esiti si leggono da
// `trial.results`, mai rifatti qui.

const LAURA = "p-laura";
const ACQ = "prj-acq";
const SUPPORT = "dep-support";
const SUPPORT_PAGE: ContextRef = { kind: "page", route: "support", projectId: ACQ };

beforeEach(async () => {
  api.setLatency(0);
  api.setStreamLatency(null);
  api.resetApi();
  await i18n.changeLanguage("en");
});
afterEach(async () => {
  await i18n.changeLanguage("en");
});

const as = (personId: string) => setSessionPersonId(personId);
type Trial = Extract<ConversationEvent, { type: "trial" }>;
const trialOf = (id: string) =>
  (state.conversationEvents.get(id) ?? []).find((e): e is Trial => e.type === "trial")!;

/** Chi riceverebbe l'avviso a Support in ACQ, calcolato a parte. */
const supportSeeingAcq = () =>
  state.access.departments
    .find((d) => d.departmentId === SUPPORT)!
    .memberIds.filter((m) => m !== "p-claude" && visibleProjectIds(m).has(ACQ)).length;

async function settle(id: string) {
  for (let i = 0; i < 10; i++) {
    await api.whenIdle(id);
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** S1 per Laura dalla pagina Support di ACQ, fino alla prova (Support scelto nella scheda). */
async function s1(text: string): Promise<string> {
  as(LAURA);
  const c = await api.createConversation();
  await api.sendMessage(c.id, { text }, { context: SUPPORT_PAGE });
  await settle(c.id);
  const q = (state.conversationEvents.get(c.id) ?? []).find(
    (e): e is Extract<ConversationEvent, { type: "question" }> => e.type === "question",
  )!;
  await api.answerQuestion(c.id, q.questionId, {
    optionIndex: q.options.findIndex((o) => o.label === "Support"),
    text: null,
  });
  await settle(c.id);
  return c.id;
}

function mount(id: string, personId = LAURA) {
  as(personId);
  return renderWithData(
    <div style={{ height: 900 }}>
      <Conversation id={id} />
    </div>,
    { personId },
  );
}

const trialRow = () => document.querySelector<HTMLElement>("[data-trial]");
const exampleRows = () => [...document.querySelectorAll<HTMLElement>("[data-trial-example]")];

describe("S1: la riga della prova", () => {
  it("en: testa, due esempi (il secondo «Wouldn't start»), i dati del filtro, «Open the test»", async () => {
    const id = await s1(
      "When an urgent support request arrives, create a task and notify the department",
    );
    const trial = trialOf(id);
    mount(id);
    await waitFor(() => expect(trialRow()).not.toBeNull());
    const row = trialRow()!;
    expect(row).toHaveTextContent("Tested on 2 examples · nothing was created");
    await waitFor(() => expect(exampleRows()).toHaveLength(2));
    const [first, second] = exampleRows();

    // L'esempio vero: il codice apribile, il titolo fra virgolette, i dati del filtro.
    const label = trial.results![0]!.label.params!;
    await waitFor(() =>
      expect(within(first!).getByRole("link", { name: String(label.code) })).toBeInTheDocument(),
    );
    expect(first).toHaveTextContent(`“${label.title}”`);
    await waitFor(() => expect(first).toHaveTextContent("(urgent, from support)"));
    expect(first).toHaveTextContent(
      `would create 1 task for Support and notify ${supportSeeingAcq()} people`,
    );
    expect(within(first!).getByRole("link", { name: "Open the test" })).toHaveAttribute(
      "href",
      `#/automations/${trial.code}/test?sim=${trial.results![0]!.simId}`,
    );
    // D3: il secondo non partirebbe.
    expect(second).toHaveTextContent("Wouldn't start: the start filter doesn't match this example");
    await waitFor(() => expect(second).toHaveTextContent(/\((low|medium) urgency, from support\)/));

    // Nessun «Turn on» / «Activate» nel flusso, e nessun codice di task o notifica nella riga.
    const flow = document.querySelector("[data-conversation]")!;
    expect(
      within(flow as HTMLElement).queryByRole("button", { name: /turn on|activate/i }),
    ).toBeNull();
    expect(
      within(flow as HTMLElement).queryByRole("link", { name: /turn on|activate/i }),
    ).toBeNull();
    expect(row.textContent).not.toMatch(/\bACQ-\d+\b/);
    // «It's off…» dopo la prova, solo testo.
    expect(flow).toHaveTextContent("It's off: turn it on from the builder when you're ready.");
  });

  it("it: «Non partirebbe» per il secondo, la testa in italiano", async () => {
    await i18n.changeLanguage("it");
    const id = await s1(
      "Quando arriva una richiesta di supporto urgente, crea una task e avvisa il reparto",
    );
    mount(id);
    await waitFor(() => expect(exampleRows()).toHaveLength(2));
    expect(trialRow()).toHaveTextContent("Provata su 2 esempi · non è nato niente");
    // Le virgolette della lingua di chi legge.
    const title = String(trialOf(id).results![0]!.label.params!.title);
    expect(exampleRows()[0]).toHaveTextContent(`«${title}»`);
    expect(exampleRows()[0]).toHaveTextContent(
      `creerebbe 1 task per Support e avviserebbe ${supportSeeingAcq()} persone`,
    );
    await waitFor(() => expect(exampleRows()[0]).toHaveTextContent("(urgente, dal supporto)"));
    expect(exampleRows()[1]).toHaveTextContent(
      "Non partirebbe: il filtro dell'inizio non vale per questo esempio",
    );
    expect(within(exampleRows()[0]!).getByRole("link", { name: "Apri la prova" })).toBeTruthy();
  });

  it("annullata la creazione: la riga resta, «Open the test» diventa testo", async () => {
    const id = await s1(
      "When an urgent support request arrives, create a task and notify the department",
    );
    const trial = trialOf(id);
    const a = state.automations.find((x) => x.id === trial.automationId)!;
    state.automations.splice(state.automations.indexOf(a), 1);
    mount(id);
    await waitFor(() => expect(exampleRows()).toHaveLength(2));
    await waitFor(() =>
      expect(within(exampleRows()[0]!).queryByRole("link", { name: "Open the test" })).toBeNull(),
    );
    expect(exampleRows()[0]).toHaveTextContent("Open the test");
  });
});

/** Una prova iniettata nel flusso di Laura, coi risultati scritti a mano. */
async function injected(trial: Omit<Extract<EventDraft, { type: "trial" }>, "type">) {
  as(LAURA);
  const c = await api.createConversation();
  await api.runScript(c.id, [{ step: "event", event: { type: "trial", ...trial } }]);
  mount(c.id);
  return c.id;
}

const outcome = (o: Partial<TrialOutcome>): TrialOutcome => ({
  simId: "sim-none",
  status: "done",
  tasks: 0,
  notifications: 0,
  emails: 0,
  requests: 0,
  milestones: 0,
  approverId: null,
  stoppedAtClaude: false,
  ...o,
});

const label = { key: "claude.trial.example", params: { code: "ACQ-R7", title: "Export bookings" } };

describe("gli stati di un esempio", () => {
  it("approvazione con chi approva, senza, il passo di Claude, fallita, nulla da fare", async () => {
    await injected({
      status: "done",
      wants: ["passes", "passes", "passes", "passes", "passes"],
      automationId: "aut-none",
      code: "ACQ-A99",
      openSimId: null,
      results: [
        {
          ...outcome({ status: "waiting_approval", tasks: 1, notifications: 3, approverId: LAURA }),
          label,
          written: false,
        },
        {
          ...outcome({ status: "waiting_approval", tasks: 1, notifications: 3 }),
          label,
          written: false,
        },
        { ...outcome({ status: "running", stoppedAtClaude: true }), label, written: false },
        { ...outcome({ status: "failed" }), label, written: false },
        { ...outcome({}), label: { key: "claude.trial.exampleWritten" }, written: true },
      ],
    });
    await waitFor(() => expect(exampleRows()).toHaveLength(5));
    const [approval, anyApproval, claude, failed, written] = exampleRows();
    expect(approval).toHaveTextContent(
      "would create 1 task and notify 3 people, then stop here for Laura Costa's approval",
    );
    expect(anyApproval).toHaveTextContent(
      "would create 1 task and notify 3 people, then stop here for an approval",
    );
    expect(claude).toHaveTextContent(
      "would stop at the step where Claude reads and decides: open the test to go on",
    );
    expect(failed).toHaveTextContent("would fail");
    expect(failed!.querySelector("[data-trial-mark='failed']")).not.toBeNull();
    // Scritto da Claude: niente codice, la frase in `ink-muted`.
    expect(written).toHaveTextContent("Example written by Claude");
    expect(written).toHaveTextContent("nothing would happen with this example");
    expect(within(written!).queryByRole("link", { name: /ACQ-R/ })).toBeNull();
    // Un'automazione che non c'è: nessun link alla prova.
    expect(within(approval!).queryByRole("link", { name: "Open the test" })).toBeNull();
  });

  it("in corso: «Testing on 2 examples…»; `skipped`: nessuna riga", async () => {
    const id = await injected({ status: "pending", wants: ["passes", "fails"] });
    await waitFor(() => expect(trialRow()).toHaveTextContent("Testing on 2 examples…"));
    await act(() =>
      api.runScript(id, [
        { step: "event", event: { type: "trial", status: "skipped", wants: ["passes"] } },
      ]),
    );
    // La prova `skipped` non lascia righe: resta solo quella `pending` di prima.
    expect(document.querySelectorAll("[data-trial]")).toHaveLength(1);
    expect(screen.queryByText(/Tested on/)).toBeNull();
  });
});
