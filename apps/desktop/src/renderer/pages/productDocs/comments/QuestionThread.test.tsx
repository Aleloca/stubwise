import * as React from "react";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failNext, productDocs, resetApi, setLatency } from "../../../data/api";
import { state } from "../../../data/store";
import { revokeProjectPermission } from "../../../data/viewer";
import type { ProductBlock } from "../../../data/types";
import { plain } from "../../../domain/productDocs/richText";
import { setLanguage } from "../../../i18n";
import { CLAUDE_PANEL_ID, openClaudePanel } from "../../../layout/claudePanel/panelEvents";
import { DOCKED_PANEL_QUERY } from "../../../layout/useDetailPanel";
import { setMatchMedia } from "../../../test/setup";
import { renderRoute } from "../../../test/renderRoute";
import { renderWithData } from "../../../test/renderWithData";
import { setSessionPersonId } from "../../../data/session";
import { answerProductQuestionAs } from "../../../data/productDocs/questions";
import { QuestionThread } from "./QuestionThread";

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

/**
 * Il fuoco perso sul body anche per un solo giro (fix round 1): a ogni
 * mutazione del DOM, dopo il commit, si guarda dov'è il fuoco. Un fuoco
 * rimesso nel layout dello stesso commit non si vede; uno che aspetta la
 * rilettura sì.
 */
function watchBody() {
  const hits: number[] = [];
  const observer = new MutationObserver(() => {
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) hits.push(hits.length);
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
  return { hits, stop: () => observer.disconnect() };
}

/** Il fuoco è su un elemento vivo della pagina, non sul body né su un nodo tolto. */
function expectFocusAlive() {
  const active = document.activeElement;
  expect(active && active !== document.body && active.isConnected).toBe(true);
}

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
    // Nel seme la divergenza non ha una richiesta da proporre: la frase non la offre (fix round 1, I4).
    expect(text).toContain("ACQ-8 was built differently from what the page says. Should I update the page?");
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
    const update = within(th).getByRole("button", { name: /^Update it/ });
    act(() => update.focus());
    // Una rilettura lenta: la finestra fra il rifiuto e il filo ricaricato si vede.
    setLatency(300);
    // Dove passa il fuoco: mai sul body (un nodo tolto), mai sul blocco della pagina
    // (la frase non è cambiata: niente da guardare lì).
    const visited: HTMLElement[] = [];
    const onFocusIn = (e: FocusEvent) => visited.push(e.target as HTMLElement);
    document.addEventListener("focusin", onFocusIn);
    const body = watchBody();
    await user.click(update);
    const col = await column();
    await waitFor(() => expect(flat(col)).toContain("Marco Bellini answered first: Leave it as is"));
    // Mai sul body, nemmeno mentre il filo si ricarica (fix round 1, I1): il fuoco è già sul filo.
    expectFocusAlive();
    expect(document.activeElement).toBe(thread(METER_Q));
    await waitFor(() => expect(within(col).getByRole("button", { name: /resolved/ })).toHaveAttribute("aria-expanded", "true"));
    await waitFor(() => expect(document.activeElement).toBe(thread(METER_Q)));
    expectFocusAlive();
    document.removeEventListener("focusin", onFocusIn);
    body.stop();
    expect(body.hits).toEqual([]);
    expect(visited.filter((el) => el.closest("[data-editor-body]"))).toEqual([]);
    expect(within(col).queryByRole("group", { name: "Answers to Claude's question" })).toBeNull();
    // Niente è cambiato nella pagina.
    expect(document.querySelector("[data-editor-body]")!.textContent).toContain(METER_LINE);
    expect(document.querySelector("[data-editor-body]")!.textContent).not.toContain(METER_APPLY);
  });

  it("revisione finale: la rilettura arriva PRIMA del rifiuto (Marco risponde mentre la risposta di Laura viaggia): il fuoco va al filo fra i risolti, mai al blocco né al body", async () => {
    const th = await questionThread(METER, METER_Q);
    const user = userEvent.setup();
    const update = within(th).getByRole("button", { name: /^Update it/ });
    act(() => update.focus());
    // La risposta di Laura è lenta; la rilettura che segue quella di Marco no.
    setLatency(300);
    const visited: HTMLElement[] = [];
    const onFocusIn = (e: FocusEvent) => visited.push(e.target as HTMLElement);
    document.addEventListener("focusin", onFocusIn);
    const body = watchBody();
    await user.click(update);
    setLatency(0);
    act(() => {
      answerProductQuestionAs(MARCO, METER_Q, "keep");
    });
    const col = await column();
    await waitFor(() => expect(within(col).getByRole("button", { name: /resolved/ })).toHaveAttribute("aria-expanded", "true"));
    await waitFor(() => expect(document.activeElement).toBe(thread(METER_Q)));
    expectFocusAlive();
    // Il rifiuto arriva dopo, e il fuoco resta sul filo.
    await waitFor(() => expect(flat(col)).toContain("Marco Bellini answered first: Leave it as is"));
    expect(document.activeElement).toBe(thread(METER_Q));
    document.removeEventListener("focusin", onFocusIn);
    body.stop();
    expect(body.hits).toEqual([]);
    expect(visited.filter((el) => el.closest("[data-editor-body]"))).toEqual([]);
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

  it("I3: «Show all 7» porta il fuoco alla prima riga nuova, mai sul body", async () => {
    const bills = state.productComments.find((c) => c.id === BILLS_Q)!;
    for (let i = 1; i <= 5; i++) {
      state.productComments.push({ ...structuredClone(bills), id: `pc-extra-q-${i}`, seq: bills.seq + 1000 + i });
    }
    await open(METER, LAURA);
    act(() => openClaudePanel());
    await waitFor(() => expect(row()).not.toBeNull());
    expect(flat(row()!)).toBe("7 questions to close in ACQ's docs");
    const user = userEvent.setup();
    await user.click(row()!);
    expect(within(panel()).getAllByRole("link", { name: /ACQ-D\d+/ })).toHaveLength(5);
    const all = within(panel()).getByRole("button", { name: "Show all 7" });
    act(() => all.focus());
    const body = watchBody();
    await user.click(all);
    const links = within(panel()).getAllByRole("link", { name: /ACQ-D\d+/ });
    expect(links).toHaveLength(7);
    body.stop();
    expect(body.hits).toEqual([]);
    expect(document.activeElement).toBe(links[5]);
  });

  it("M1: tolto il chip («×»), la riga non c'è più; rimesso, torna", async () => {
    await open(METER, LAURA);
    act(() => openClaudePanel());
    await waitFor(() => expect(row()).not.toBeNull());
    const user = userEvent.setup();
    await user.click(within(panel()).getByRole("button", { name: /^(Don't use this page|Non usare questa pagina)$/ }));
    await waitFor(() => expect(row()).toBeNull());
    await user.click(within(panel()).getByRole("button", { name: /^(Use it|Usala)$/ }));
    await waitFor(() => expect(row()).not.toBeNull());
  });

  it("Sara (senza Modifica Docs) non ha la riga", async () => {
    await open(METER, SARA);
    act(() => openClaudePanel());
    await waitFor(() => expect(panel().getAttribute("data-claude-panel")).toBe("open"));
    await act(async () => {});
    expect(row()).toBeNull();
  });
});

describe("fix round 1", () => {
  it("I2: «Retry» dopo un errore: il fuoco torna al bottone della risposta, mai sul body, e la risposta parte", async () => {
    const th = await questionThread(BILLS, BILLS_Q);
    failNext("productDocs.answerProductQuestion");
    const user = userEvent.setup();
    await user.click(within(th).getByRole("button", { name: /^Leave it as is/ }));
    const alert = await within(th).findByRole("alert");
    expect(flat(alert)).toContain("Couldn't send the answer");
    const retry = within(alert).getByRole("button", { name: "Retry" });
    act(() => retry.focus());
    setLatency(300);
    await user.click(retry);
    // Subito, con la risposta in volo: il fuoco sul bottone della risposta, non sul body.
    expectFocusAlive();
    expect(document.activeElement).toBe(within(thread(BILLS_Q)!).getByRole("button", { name: /^(Leave it as is|Answering…)/ }));
    const body = watchBody();
    await waitFor(() => expect(state.productComments.find((c) => c.id === BILLS_Q)!.question!.answer?.option).toBe("keep"));
    await waitFor(() => expect(thread(BILLS_Q)).toBeNull());
    body.stop();
    expect(body.hits).toEqual([]);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("I4: la divergenza senza strada per una richiesta non la offre: «Should I update the page?»; in it «Aggiorno la pagina?»", async () => {
    const th = await questionThread(METER, METER_Q);
    expect(flat(th)).toContain("ACQ-8 was built differently from what the page says. Should I update the page?");
    expect(flat(th)).not.toContain("open a request");
    act(() => setLanguage("it"));
    await waitFor(() =>
      expect(flat(thread(METER_Q)!)).toContain("ACQ-8 è stata fatta diversamente da come dice la pagina. Aggiorno la pagina?"),
    );
    expect(flat(thread(METER_Q)!)).not.toContain("apro una richiesta");
  });

  it("I4: con una richiesta da proporre la frase la offre, e c'è il bottone (en e it)", async () => {
    state.productComments.find((c) => c.id === METER_Q)!.question!.request = {
      title: "Lower readings after a meter change",
      description: "Decide whether a lower reading is accepted.",
    };
    const th = await questionThread(METER, METER_Q);
    expect(flat(th)).toContain("Should I update the page, or open a request?");
    expect(within(th).getByRole("button", { name: "Open a request" })).toBeInTheDocument();
    act(() => setLanguage("it"));
    await waitFor(() => expect(flat(thread(METER_Q)!)).toContain("Aggiorno la pagina o apro una richiesta?"));
  });

  it("M5a: ←/→ fra i bottoni delle risposte", async () => {
    const th = await questionThread(BILLS, BILLS_Q);
    const buttons = within(within(th).getByRole("group", { name: "Answers to Claude's question" })).getAllByRole("button");
    act(() => buttons[0]!.focus());
    const user = userEvent.setup();
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(buttons[1]);
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(document.activeElement).toBe(buttons[0]);
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(buttons[2]);
  });

  it("M5b: annullata la scheda, il fuoco torna a «Open a request» nel filo", async () => {
    const th = await questionThread(BILLS, BILLS_Q);
    const user = userEvent.setup();
    await user.click(within(th).getByRole("button", { name: "Open a request" }));
    await waitFor(() => expect(document.activeElement).toBe(panel().querySelector("[data-proposal]")));
    await waitFor(() => expect(flat(thread(BILLS_Q)!)).toContain("A request is being prepared"));
    await user.click(within(panel().querySelector<HTMLElement>("[data-proposal]")!).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(within(thread(BILLS_Q)!).getByRole("button", { name: "Open a request" })),
    );
  });

  it("M6: `forbidden` fra lettura e clic: la frase col «Who?», nessun bottone attivo, il fuoco mai sul body", async () => {
    const th = await questionThread(METER, METER_Q);
    const update = within(th).getByRole("button", { name: /^Update it/ });
    // Il permesso si perde fra la lettura e il clic: proprio al clic, prima della chiamata.
    update.addEventListener("click", () => revokeProjectPermission(LAURA, "prj-acq", "docs.edit" as never), {
      capture: true,
      once: true,
    });
    act(() => update.focus());
    const body = watchBody();
    const user = userEvent.setup();
    await user.click(update);
    await waitFor(() => expect(flat(thread(METER_Q)!)).toContain("You can no longer answer in ACQ."));
    expectFocusAlive();
    await waitFor(() =>
      expect(within(thread(METER_Q)!).queryByRole("group", { name: "Answers to Claude's question" })).toBeNull(),
    );
    body.stop();
    expect(body.hits).toEqual([]);
    expect(within(thread(METER_Q)!).getByRole("button", { name: /who can/i })).toBeInTheDocument();
  });
});

describe("fix round 1, I1: il filo da solo, senza rilettura", () => {
  it("un `already_answered` sposta il fuoco sul filo nello stesso giro in cui i bottoni spariscono", async () => {
    setSessionPersonId(LAURA);
    const meter = state.productPages.find((p) => p.code === METER)!;
    const { open: threads } = await productDocs.listProductComments(meter.id);
    const th = threads.find((x) => x.root.id === METER_Q)!;
    const rejected = Object.assign(new Error("already_answered"), { byId: MARCO, option: "keep" as const });
    let first: unknown = null;
    function Host() {
      const [answer, setAnswer] = React.useState<{ byId: string | null; option: "keep" } | null>(null);
      return (
        <QuestionThread
          thread={th}
          projectId="prj-acq"
          projectCode="ACQ"
          canComment
          active={false}
          preparing={false}
          firstAnswer={answer}
          onAnswer={() => Promise.reject(rejected)}
          onRequest={() => {}}
          // La colonna rilegge il filo DOPO: qui la rilettura non arriva mai.
          onAlreadyAnswered={(f) => {
            first = f;
            setAnswer(f as { byId: string | null; option: "keep" });
          }}
          onStale={() => {}}
        />
      );
    }
    renderWithData(<Host />, { personId: LAURA });
    const update = screen.getByRole("button", { name: /^Update it/ });
    act(() => update.focus());
    const user = userEvent.setup();
    await user.click(update);
    await waitFor(() => expect(first).not.toBeNull());
    await waitFor(() => expect(screen.queryByRole("group", { name: "Answers to Claude's question" })).toBeNull());
    expectFocusAlive();
    expect(document.activeElement).toBe(document.querySelector(`[data-thread="${METER_Q}"]`));
  });
});
