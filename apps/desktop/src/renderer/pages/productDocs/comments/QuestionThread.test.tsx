import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { productDocs, resetApi, setLatency } from "../../../data/api";
import { state } from "../../../data/store";
import type { ProductBlock } from "../../../data/types";
import { plain } from "../../../domain/productDocs/richText";
import { setLanguage } from "../../../i18n";
import { CLAUDE_PANEL_ID, openClaudePanel } from "../../../layout/claudePanel/panelEvents";
import { DOCKED_PANEL_QUERY } from "../../../layout/useDetailPanel";
import { setMatchMedia } from "../../../test/setup";
import { renderRoute } from "../../../test/renderRoute";

// Le domande di Claude nella colonna dei commenti (11b, Task 10; shape
// product-claude-questions.md §3.1–3.3). Nel seme: Bills ha una domanda
// vaga da una riunione (una frase da AGGIUNGERE: solo «Proposed», con una
// richiesta da aprire, consigliata «Leave it as is»); Meter reading una
// divergenza da una task chiusa (ACQ-8: «The page says» / «Was built» /
// «Proposed», consigliata «Update it»). Laura scrive, Marco risponde prima
// di lei, Sara legge soltanto.

const LAURA = "p-laura";
const MARCO = "p-marco";
const SARA = "p-sara";
const BILLS = "ACQ-D6";
const METER = "ACQ-D7";
const BILLS_Q = "pc-acq11b-bills-q";
const METER_Q = "pc-acq11b-meter-q";
const METER_LINE = "A reading lower than the previous one is refused, with a message that says why.";
const METER_APPLY =
  "A reading lower than the previous one is refused, with a message that says why, unless the meter was replaced in the same month.";
const BILLS_INSERT = "The reminder also goes out by email, a week before the due date.";

beforeEach(() => {
  setLatency(0);
  resetApi();
  window.localStorage.clear();
  setMatchMedia(DOCKED_PANEL_QUERY, true);
});
afterEach(() => {
  act(() => setLanguage("en"));
});

async function open(code: string, person = LAURA, search = "") {
  renderRoute(`/p/ACQ/docs/product/${code}${search}`, person);
  const title = state.productPages.find((p) => p.code === code)!.title;
  await screen.findByRole("heading", { level: 1, name: title });
}

const column = () => screen.findByRole("region", { name: /^(Comments|Commenti)$/ });
const thread = (id: string) => document.querySelector<HTMLElement>(`[data-thread="${id}"]`);
const panel = () => document.getElementById(CLAUDE_PANEL_ID)!;
const flat = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ");

async function questionThread(code: string, id: string, person = LAURA) {
  await open(code, person, `?comment=${id}`);
  await column();
  await waitFor(() => expect(thread(id)).not.toBeNull());
  return thread(id)!;
}

describe("il filo-domanda", () => {
  it("Meter reading: Claude, la fonte, la domanda con ACQ-8, «The page says» / «Was built» / «Proposed», «Update it» consigliata per prima; nessun «Resolve»", async () => {
    const th = await questionThread(METER, METER_Q);
    expect(th).toHaveAttribute("aria-label", `Claude's question on “${METER_LINE}”`);
    const text = flat(th);
    expect(text).toContain("Claude");
    expect(th.querySelector("[data-source-line]")).not.toBeNull();
    expect(text).toContain(
      "ACQ-8 was built differently from what the page says. Should I update the page, or open a request?",
    );
    expect(text).toContain(`The page says${METER_LINE}`);
    expect(text).toContain("Was builtA reading lower than the previous one is accepted when the meter was replaced in the same month.");
    expect(text).toContain(`Proposed${METER_APPLY}`);
    const group = within(th).getByRole("group", { name: "Answers to Claude's question" });
    const buttons = within(group).getAllByRole("button");
    expect(buttons.map((b) => flat(b))).toEqual(["Update itRecommended", "Leave it as is"]);
    expect(within(th).queryByRole("button", { name: "Resolve" })).toBeNull();
  });

  it("Bills (una frase da aggiungere): solo «Proposed», i tre bottoni con «Leave it as is» consigliata per prima", async () => {
    const th = await questionThread(BILLS, BILLS_Q);
    const text = flat(th);
    expect(text).toContain("The source isn't clear on this. Should the page say this?");
    expect(text).toContain(`Proposed${BILLS_INSERT}`);
    expect(text).not.toContain("Now");
    const group = within(th).getByRole("group", { name: "Answers to Claude's question" });
    expect(within(group).getAllByRole("button").map((b) => flat(b))).toEqual([
      "Leave it as isRecommended",
      "Update it",
      "Open a request",
    ]);
  });

  it("in it: «Domanda di Claude su …», «Aggiorna così» · «Lascia com'è», «La pagina dice»", async () => {
    act(() => setLanguage("it"));
    const th = await questionThread(METER, METER_Q);
    expect(th).toHaveAttribute("aria-label", `Domanda di Claude su «${METER_LINE}»`);
    expect(flat(th)).toContain("La pagina dice");
    const group = within(th).getByRole("group", { name: "Risposte alla domanda di Claude" });
    expect(within(group).getAllByRole("button").map((b) => flat(b))).toEqual([
      "Aggiorna cosìConsigliata",
      "Lascia com'è",
    ]);
  });

  it("«Update it»: la frase cambia, il filo va fra i risolti con «Answered by Laura Costa: Update it», il fuoco sul blocco", async () => {
    const th = await questionThread(METER, METER_Q);
    const user = userEvent.setup();
    await user.click(within(th).getByRole("button", { name: /^Update it/ }));
    await waitFor(() =>
      expect(document.querySelector("[data-editor-body]")!.textContent).toContain(METER_APPLY),
    );
    const col = await column();
    await waitFor(() => expect(within(col).queryByRole("group", { name: "Answers to Claude's question" })).toBeNull());
    // Il fuoco sul blocco aggiornato (il suo gruppo), mai sul body.
    const active = document.activeElement as HTMLElement;
    expect(active).toHaveAttribute("data-block-id", "blk-acq-meter-4");
    expect(active.closest("[data-editor-body]")).not.toBeNull();
    await user.click(within(col).getByRole("button", { name: /resolved/ }));
    await waitFor(() => expect(flat(col)).toContain("Answered by Laura Costa: Update it"));
    // Chiusa, la frase di adesso (già quella proposta) non si mostra più come «The page says».
    expect(flat(thread(METER_Q)!)).not.toContain("The page says");
    expect(flat(thread(METER_Q)!)).toContain(`Proposed${METER_APPLY}`);
    expect(state.productComments.find((c) => c.id === METER_Q)!.question!.answer!.option).toBe("apply");
  });

  it("«Leave it as is»: nessuna revisione, il filo fra i risolti con «Answered by Laura Costa: Leave it as is», il fuoco mai sul body", async () => {
    const before = state.productRevisions.length;
    const th = await questionThread(BILLS, BILLS_Q);
    const user = userEvent.setup();
    await user.click(within(th).getByRole("button", { name: /^Leave it as is/ }));
    const col = await column();
    await waitFor(() => expect(thread(BILLS_Q)).toBeNull());
    expect(document.activeElement).not.toBe(document.body);
    await user.click(within(col).getByRole("button", { name: /resolved/ }));
    await waitFor(() => expect(flat(col)).toContain("Answered by Laura Costa: Leave it as is"));
    expect(state.productRevisions.length).toBe(before);
  });

  it("un doppio clic su «Leave it as is» risponde una volta sola", async () => {
    const th = await questionThread(BILLS, BILLS_Q);
    const button = within(th).getByRole("button", { name: /^Leave it as is/ });
    act(() => {
      button.click();
      button.click();
    });
    await waitFor(() => expect(state.productComments.find((c) => c.id === BILLS_Q)!.question!.answer).not.toBeNull());
    expect(document.querySelector("[role=alert]")).toBeNull();
  });

  it("`alreadyAnswered`: Marco ha risposto prima; Laura legge «Marco Bellini answered first: Leave it as is», il filo si ricarica risolto col fuoco sopra", async () => {
    const th = await questionThread(METER, METER_Q);
    // Marco risponde fra la lettura di Laura e il suo clic: nessun avviso alla
    // pagina (con l'avviso il filo si chiuderebbe davanti a lei prima del clic).
    const comment = state.productComments.find((c) => c.id === METER_Q)!;
    comment.question!.answer = { byId: MARCO, option: "keep", seq: 9_999, revisionId: null };
    comment.resolved = { byId: MARCO, at: comment.createdAt };
    const user = userEvent.setup();
    await user.click(within(th).getByRole("button", { name: /^Update it/ }));
    const col = await column();
    await waitFor(() => expect(flat(col)).toContain("Marco Bellini answered first: Leave it as is"));
    await waitFor(() => expect(document.activeElement).toBe(thread(METER_Q)));
    expect(within(col).queryByRole("group", { name: "Answers to Claude's question" })).toBeNull();
    // Niente è cambiato nella pagina.
    expect(document.querySelector("[data-editor-body]")!.textContent).toContain(METER_LINE);
    expect(document.querySelector("[data-editor-body]")!.textContent).not.toContain(METER_APPLY);
  });

  it("la frase cambiata dopo la domanda: «Update it» spento con «The sentence changed after the question: Marco Bellini edited it»; gli altri restano", async () => {
    const meter = state.productPages.find((p) => p.code === METER)!;
    const current = meter.blocks.find((b) => b.id === "blk-acq-meter-4")!;
    productDocs.writeProductBlocksAs(
      MARCO,
      meter.id,
      [{ op: "set", block: { ...current, content: plain("A lower reading is checked by hand.") } as ProductBlock }],
      {},
    );
    const th = await questionThread(METER, METER_Q);
    const update = within(th).getByRole("button", { name: /^Update it/ });
    expect(update).toHaveAttribute("aria-disabled", "true");
    expect(flat(th)).toContain("The sentence changed after the question: Marco Bellini edited it");
    expect(within(th).getByRole("button", { name: /^Leave it as is/ })).not.toHaveAttribute("aria-disabled");
  });

  it("Sara legge soltanto: il filo intero, nessun bottone né casella, «Answering is for people with Edit docs in ACQ · Who?»", async () => {
    const th = await questionThread(METER, METER_Q, SARA);
    expect(flat(th)).toContain("ACQ-8 was built differently");
    expect(within(th).queryByRole("group", { name: "Answers to Claude's question" })).toBeNull();
    expect(within(th).queryByRole("combobox")).toBeNull();
    expect(flat(th)).toContain("Answering is for people with Edit docs in ACQ");
    expect(within(th).getByRole("button", { name: /who can/i })).toHaveTextContent("Who?");
  });
});

describe("«Open a request»", () => {
  it("apre il riquadro con la scheda B, il fuoco sulla scheda; il filo dice che è in preparazione, e annullata la riga sparisce", async () => {
    const th = await questionThread(BILLS, BILLS_Q);
    const user = userEvent.setup();
    await user.click(within(th).getByRole("button", { name: "Open a request" }));
    await waitFor(() => expect(panel().getAttribute("data-claude-panel")).toBe("open"));
    expect(await within(panel()).findByText("Open a request from question pc-acq11b-bills-q")).toBeInTheDocument();
    await waitFor(() => expect(panel().querySelector("[data-proposal]")).not.toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(panel().querySelector("[data-proposal]")));
    await waitFor(() => expect(flat(thread(BILLS_Q)!)).toContain("A request is being prepared in Claude's panel"));
    await user.click(within(panel().querySelector<HTMLElement>("[data-proposal]")!).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(flat(thread(BILLS_Q)!)).not.toContain("A request is being prepared"));
    expect(state.productComments.find((c) => c.id === BILLS_Q)!.question!.answer).toBeNull();
  });
});

describe("«Open a request» confermata", () => {
  it("la scheda confermata chiude il filo con «Answered by Laura Costa: Open a request · ACQ-R<n>»", async () => {
    const th = await questionThread(BILLS, BILLS_Q);
    const user = userEvent.setup();
    await user.click(within(th).getByRole("button", { name: "Open a request" }));
    await waitFor(() => expect(panel().querySelector("[data-proposal]")).not.toBeNull());
    await user.click(within(panel().querySelector<HTMLElement>("[data-proposal]")!).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(state.productComments.find((c) => c.id === BILLS_Q)!.question!.answer?.option).toBe("request"));
    const col = await column();
    await waitFor(() => expect(thread(BILLS_Q)).toBeNull());
    await user.click(within(col).getByRole("button", { name: /resolved/ }));
    await waitFor(() => expect(flat(col)).toMatch(/Answered by Laura Costa: Open a request · ACQ-R\d+/));
  });
});

describe("«N questions to close» nel riquadro di Claude", () => {
  const row = () => panel().querySelector<HTMLButtonElement>("[data-questions-to-close]");

  it("su una pagina di ACQ Laura legge «2 questions to close in ACQ's docs»; aperta, le righe portano al filo e il riquadro resta aperto", async () => {
    await open(METER, LAURA);
    act(() => openClaudePanel());
    await waitFor(() => expect(row()).not.toBeNull());
    expect(flat(row()!)).toBe("2 questions to close in ACQ's docs");
    expect(row()).toHaveAttribute("aria-expanded", "false");
    const user = userEvent.setup();
    await user.click(row()!);
    expect(row()).toHaveAttribute("aria-expanded", "true");
    const links = within(panel()).getAllByRole("link", { name: /ACQ-D\d+/ });
    expect(links.map((l) => flat(l))).toEqual([
      expect.stringContaining(`${BILLS}Bills`),
      expect.stringContaining(`${METER}Meter reading`),
    ]);
    await user.click(links[0]!);
    await screen.findByRole("heading", { level: 1, name: "Bills" });
    await waitFor(() => expect(thread(BILLS_Q)).not.toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(thread(BILLS_Q)));
    expect(panel().getAttribute("data-claude-panel")).toBe("open");
  });

  it("in it «2 domande da chiudere nei Docs di ACQ»; una risposta la fa scendere a 1", async () => {
    act(() => setLanguage("it"));
    await open(METER, LAURA);
    act(() => openClaudePanel());
    await waitFor(() => expect(row()).not.toBeNull());
    expect(flat(row()!)).toBe("2 domande da chiudere nei Docs di ACQ");
    act(() => productDocs.answerProductQuestionAs(LAURA, BILLS_Q, "keep"));
    await waitFor(() => expect(flat(row()!)).toBe("1 domanda da chiudere nei Docs di ACQ"));
  });

  it("Sara (senza Modifica Docs) non ha la riga", async () => {
    await open(METER, SARA);
    act(() => openClaudePanel());
    await waitFor(() => expect(panel().getAttribute("data-claude-panel")).toBe("open"));
    await act(async () => {});
    expect(row()).toBeNull();
  });
});
