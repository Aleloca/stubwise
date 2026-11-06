import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as api from "../../../data/api";
import { state } from "../../../data/store";
import { CLAUDE_PANEL_ID } from "../../../layout/claudePanel/panelEvents";
import { clearToasts } from "../../../tasks-ui/Toast";
import { renderRoute } from "../../../test/renderRoute";
import { clearPendingAnswers, setUndoWindow } from "../pendingAnswers";

// Le domande di Claude sulla doc di prodotto in «Decide» (11b, Task 10; shape
// product-claude-questions.md §3.4): nella cornice delle domande di Claude
// sui task, con la fonte, la frase proposta, l'oggetto (la pagina) e gli
// stessi tre bottoni del filo con la stessa consigliata. «Update it» parte
// SUBITO (niente finestra dell'«Undo»: la modifica si annulla dalla
// cronologia, scelta del costruttore); «Leave it as is» segue la finestra
// come le altre risposte di «Decide». Laura riceve le due domande del seme,
// Sara (sola lettura) nessuna.

const LAURA = "p-laura";
const SARA = "p-sara";
const BILLS_Q = "pc-acq11b-bills-q";
const METER_Q = "pc-acq11b-meter-q";
const METER_APPLY =
  "A reading lower than the previous one is refused, with a message that says why, unless the meter was replaced in the same month.";

beforeEach(() => {
  api.setLatency(0);
  api.resetApi();
  // Le altre voci di «Decide» (posta, domande dei task) qui non servono.
  state.mailProposals.length = 0;
  setUndoWindow(0);
});
afterEach(() => {
  clearPendingAnswers();
  clearToasts();
  setUndoWindow(null);
});

const decideBlock = () => screen.findByRole("region", { name: "Decide" });
const question = (id: string) => state.productComments.find((c) => c.id === id)!.question!;
const flat = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ");

let router: ReturnType<typeof renderRoute>;

async function item(id: string, person = LAURA): Promise<HTMLElement> {
  router = renderRoute("/home", person);
  const decide = await decideBlock();
  await waitFor(async () => {
    const more = within(decide).queryByRole("button", { name: /^Show \d+ more$/ });
    if (more && !decide.querySelector(`[data-claude-decision="product:${id}"]`)) await userEvent.click(more);
    expect(decide.querySelector(`[data-claude-decision="product:${id}"]`)).not.toBeNull();
  });
  return decide.querySelector<HTMLElement>(`[data-claude-decision="product:${id}"]`)!;
}

describe("Decide: le domande di Claude sulla doc", () => {
  it("la voce: «Claude asks», la domanda, la fonte, «Proposed: …», la pagina col codice, i bottoni del filo con la stessa consigliata", async () => {
    const el = await item(METER_Q);
    const meter = state.productPages.find((p) => p.title === "Meter reading")!;
    expect(within(el).getByText("Claude asks")).toBeInTheDocument();
    expect(flat(el)).toContain("ACQ-8 was built differently from what the page says. Should I update the page?");
    expect(flat(el)).not.toContain("open a request");
    expect(el.querySelector("[data-source-line]")).not.toBeNull();
    expect(flat(el)).toContain(`Proposed: “${METER_APPLY}”`);
    const link = within(el).getByRole("link", { name: new RegExp(`${meter.code}.*Meter reading`) });
    expect(link.getAttribute("href")).toContain(`?comment=${METER_Q}`);
    const group = within(el).getByRole("group", { name: "Answers to Claude's question" });
    expect(within(group).getAllByRole("button").map((b) => flat(b))).toEqual(["Update itRecommended", "Leave it as is"]);
    expect(within(el).queryByRole("button", { name: "Other…" })).toBeNull();
  });

  it("«Update it» parte subito, anche con la finestra dell'«Undo»: il toast rimanda alla cronologia, nessun «Undo»; la voce sparisce", async () => {
    setUndoWindow(60_000);
    const el = await item(METER_Q);
    await userEvent.click(within(el).getByRole("button", { name: /^Update it/ }));
    await waitFor(() => expect(question(METER_Q).answer).toMatchObject({ byId: LAURA, option: "apply" }));
    const toast = await screen.findByText(/^Updated ACQ-D\d+ · Meter reading\. To undo it, open the page history\.$/);
    const box = toast.closest("[data-toast]") as HTMLElement;
    expect(within(box).getByRole("button", { name: "Open history" })).toBeInTheDocument();
    expect(within(box).queryByRole("button", { name: "Undo" })).toBeNull();
    const decide = await decideBlock();
    await waitFor(() => expect(decide.querySelector(`[data-claude-decision="product:${METER_Q}"]`)).toBeNull());
    // Il fuoco alla voce dopo (o al titolo di «Decide»), mai sul body.
    expect(document.activeElement).not.toBe(document.body);
    expect(decide.contains(document.activeElement)).toBe(true);
  });

  it("«Open history» apre la pagina sulla riga della risposta in cronologia", async () => {
    const el = await item(METER_Q);
    await userEvent.click(within(el).getByRole("button", { name: /^Update it/ }));
    const revisionId = await waitFor(() => {
      const id = question(METER_Q).answer?.revisionId;
      expect(id).toBeTruthy();
      return id!;
    });
    await userEvent.click(await screen.findByRole("button", { name: "Open history" }));
    await screen.findByRole("heading", { level: 1, name: "Meter reading" });
    expect(router.state.location.search).toMatchObject({ history: revisionId });
  });

  it("«Leave it as is» segue la finestra dell'«Undo» di «Decide»: «Undo» la riporta e niente parte", async () => {
    setUndoWindow(60_000);
    const el = await item(BILLS_Q);
    await userEvent.click(within(el).getByRole("button", { name: /^Leave it as is/ }));
    const toast = await screen.findByText(/^Answered on ACQ-D\d+$/);
    expect(question(BILLS_Q).answer).toBeNull();
    await userEvent.click(within(toast.closest("[data-toast]") as HTMLElement).getByRole("button", { name: "Undo" }));
    const decide = await decideBlock();
    await waitFor(() => expect(decide.querySelector(`[data-claude-decision="product:${BILLS_Q}"]`)).not.toBeNull());
    expect(question(BILLS_Q).answer).toBeNull();
  });

  it("«Leave it as is» allo scadere risponde a nome di Laura, e la voce non torna", async () => {
    const el = await item(BILLS_Q);
    await userEvent.click(within(el).getByRole("button", { name: /^Leave it as is/ }));
    await waitFor(() => expect(question(BILLS_Q).answer).toMatchObject({ byId: LAURA, option: "keep" }));
    const decide = await decideBlock();
    await waitFor(() => expect(decide.querySelector(`[data-claude-decision="product:${BILLS_Q}"]`)).toBeNull());
  });

  it("già risposta da un altro: «Already answered by Marco Bellini.» e la voce se ne va", async () => {
    const el = await item(METER_Q);
    const comment = state.productComments.find((c) => c.id === METER_Q)!;
    comment.question!.answer = { byId: "p-marco", option: "keep", seq: 9_999, revisionId: null };
    comment.resolved = { byId: "p-marco", at: comment.createdAt };
    await userEvent.click(within(el).getByRole("button", { name: /^Update it/ }));
    expect(await screen.findByText("Already answered by Marco Bellini.")).toBeInTheDocument();
    const decide = await decideBlock();
    await waitFor(() => expect(decide.querySelector(`[data-claude-decision="product:${METER_Q}"]`)).toBeNull());
  });

  it("«Open a request» apre il riquadro con la scheda B; la voce resta in «Decide»", async () => {
    const el = await item(BILLS_Q);
    await userEvent.click(within(el).getByRole("button", { name: "Open a request" }));
    const panel = document.getElementById(CLAUDE_PANEL_ID)!;
    await waitFor(() => expect(panel.getAttribute("data-claude-panel")).toBe("open"));
    await waitFor(() => expect(panel.querySelector("[data-proposal]")).not.toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(panel.querySelector("[data-proposal]")));
    const decide = await decideBlock();
    expect(decide.querySelector(`[data-claude-decision="product:${BILLS_Q}"]`)).not.toBeNull();
  });

  it("fix round 1, I4: con una richiesta da proporre la frase la offre e c'è «Open a request»", async () => {
    state.productComments.find((c) => c.id === METER_Q)!.question!.request = {
      title: "Lower readings after a meter change",
      description: "Decide whether a lower reading is accepted.",
    };
    const el = await item(METER_Q);
    expect(flat(el)).toContain("Should I update the page, or open a request?");
    expect(within(el).getByRole("button", { name: "Open a request" })).toBeInTheDocument();
  });

  it("Sara (sola lettura) non ha le domande della doc in «Decide»", async () => {
    renderRoute("/home", SARA);
    const decide = await decideBlock();
    await act(async () => {});
    expect(decide.querySelector("[data-claude-decision^='product:']")).toBeNull();
  });
});
