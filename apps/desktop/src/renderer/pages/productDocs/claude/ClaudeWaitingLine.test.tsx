import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetApi, setLatency } from "../../../data/api";
import { applyProductSource, whenProductClaudeIdle } from "../../../data/productDocs/claude";
import { pauseQueueAs, releaseBudgetHolds } from "../../../data/instance/queue";
import { done, ext, mail, person } from "../../../data/seed/mail/helpers";
import { withoutSeed11b } from "../../../data/seed/productDocs/without11b";
import { notifyInstanceChange, state } from "../../../data/store";
import type { ProductFact } from "../../../data/types";
import { setLanguage } from "../../../i18n";
import { DOCKED_PANEL_QUERY } from "../../../layout/useDetailPanel";
import { setMatchMedia } from "../../../test/setup";
import { renderRoute } from "../../../test/renderRoute";

// La riga dell'attesa in cima allo spazio (11b, Task 11; shape
// product-claude-questions.md §3.8, [PQ 11]): quando aggiornamenti di Claude
// aspettano il budget o la ripresa della coda, una riga sotto la barra dello
// spazio li conta (senza nominare le fonti) e dice quando ripartono, col
// «Who?». Senza attese non c'è, anche col budget finito.

const LAURA = "p-laura";
const SARA = "p-sara";
const ROBERTA = "p-roberta";
const ACQ = "prj-acq";
const SIGNIN = "/p/ACQ/docs/product/ACQ-D5";
const PAGE = "pp-acq-sign-in";

const flat = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ").trim();

function email(id: string) {
  return mail({
    id,
    threadId: `th-${id}`,
    from: ext("Fabio Rossi", "fabio@cliente.example"),
    to: [person(LAURA)],
    subject: `Subject of ${id}`,
    at: "2026-11-04T09:30:00Z",
    text: "body",
    mailboxPersonIds: [LAURA],
    classification: done([ACQ], "normal"),
  });
}

let n = 0;
const fact = (anchorId: string, text: string): ProductFact => ({
  id: `fact-wait-${++n}`,
  pageId: PAGE,
  anchorId,
  clarity: "clear",
  change: { kind: "replace", text: { text, marks: [] } },
});

/** Due fonti ferme sulla pagina Sign-in: due aggiornamenti in attesa. */
function twoWaiting() {
  state.mailMessages.push(email("mm-wait-1"), email("mm-wait-2"));
  applyProductSource({ kind: "email", id: "mm-wait-1" }, ACQ, [fact("blk-acq-signin-2", "Google only.")]);
  applyProductSource({ kind: "email", id: "mm-wait-2" }, ACQ, [fact("blk-acq-signin-4", "Only the name.")]);
}

const line = () => document.querySelector<HTMLElement>("[data-claude-waiting]");

beforeEach(() => {
  setLatency(0);
  resetApi();
  withoutSeed11b();
  window.localStorage.clear();
  setMatchMedia(DOCKED_PANEL_QUERY, true);
});
afterEach(async () => {
  await whenProductClaudeIdle();
  act(() => setLanguage("en"));
});

async function open(path = SIGNIN, who = LAURA) {
  renderRoute(path, who);
  await screen.findByRole("heading", { level: 1 });
}

describe("la riga dell'attesa", () => {
  it("budget finito con due aggiornamenti fermi: la frase del budget, il conteggio e «Who?»; l'orologio, non ▲", async () => {
    state.instance.simulate.budgetReached = true;
    twoWaiting();
    await open();
    await waitFor(() => expect(line()).not.toBeNull());
    expect(flat(line()!)).toBe(
      "Claude will resume updating the doc when the budget is back · 2 updates waiting · Who?",
    );
    expect(within(line()!).getByRole("button", { name: /^Who/ })).toBeInTheDocument();
    expect(line()!.textContent).not.toContain("▲");
    expect(line()!.querySelector("svg")).not.toBeNull();
    // Nessuna fonte è nominata.
    expect(line()!.textContent).not.toMatch(/Subject of|mm-wait/);
  });

  it("anche sull'indice dello spazio, e la vede chi legge soltanto (Sara)", async () => {
    state.instance.simulate.budgetReached = true;
    twoWaiting();
    await open("/p/ACQ/docs/product", SARA);
    await waitFor(() => expect(line()).not.toBeNull());
    expect(flat(line()!)).toContain("2 updates waiting");
  });

  it("in italiano, composta in lettura", async () => {
    act(() => setLanguage("it"));
    state.instance.simulate.budgetReached = true;
    twoWaiting();
    await open();
    await waitFor(() => expect(line()).not.toBeNull());
    expect(flat(line()!)).toBe(
      "Claude riprenderà ad aggiornare la doc quando torna il budget · 2 aggiornamenti in attesa · Chi?",
    );
  });

  it("la coda in pausa: la frase col nome di chi l'ha messa", async () => {
    expect(pauseQueueAs(ROBERTA, ACQ)).toEqual({ ok: true });
    twoWaiting();
    await open();
    await waitFor(() => expect(line()).not.toBeNull());
    expect(flat(line()!)).toBe(
      "Claude will resume updating the doc when Roberta Fontana resumes the queue · 2 updates waiting · Who?",
    );
  });

  it("la pausa in italiano", async () => {
    act(() => setLanguage("it"));
    expect(pauseQueueAs(ROBERTA, ACQ)).toEqual({ ok: true });
    twoWaiting();
    await open();
    await waitFor(() => expect(line()).not.toBeNull());
    expect(flat(line()!)).toBe(
      "Claude riprenderà ad aggiornare la doc quando Roberta Fontana riprende la coda · 2 aggiornamenti in attesa · Chi?",
    );
  });

  it("un solo aggiornamento: «1 update waiting»", async () => {
    state.instance.simulate.budgetReached = true;
    state.mailMessages.push(email("mm-wait-1"));
    applyProductSource({ kind: "email", id: "mm-wait-1" }, ACQ, [fact("blk-acq-signin-2", "Google only.")]);
    await open();
    await waitFor(() => expect(line()).not.toBeNull());
    expect(flat(line()!)).toContain("· 1 update waiting ·");
  });

  it("senza aggiornamenti in attesa la riga non c'è, anche col budget finito", async () => {
    state.instance.simulate.budgetReached = true;
    await open();
    await screen.findByRole("navigation", { name: /Product pages of/ });
    expect(line()).toBeNull();
  });

  it("al ritorno del budget la riga sparisce", async () => {
    state.instance.simulate.budgetReached = true;
    twoWaiting();
    await open();
    await waitFor(() => expect(line()).not.toBeNull());
    act(() => {
      state.instance.simulate.budgetReached = false;
      releaseBudgetHolds();
      notifyInstanceChange();
    });
    await waitFor(() => expect(line()).toBeNull());
  });

  it("a 1024 la frase va a capo e «Who?» resta attaccato all'ultima parola", async () => {
    setMatchMedia(DOCKED_PANEL_QUERY, false);
    state.instance.simulate.budgetReached = true;
    twoWaiting();
    await open();
    await waitFor(() => expect(line()).not.toBeNull());
    const who = within(line()!).getByRole("button", { name: /^Who/ });
    expect(who.closest(".whitespace-nowrap")).not.toBeNull();
    expect(line()!.className).not.toMatch(/truncate|whitespace-nowrap/);
  });
});
