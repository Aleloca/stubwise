import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../../data/api";
import { resetApi, setLatency } from "../../../data/api";
import { PHASE_HEADINGS } from "../../../data/seed/productDocs/acq";
import { getSessionPersonId, setSessionPersonId } from "../../../data/session";
import { failNext, state } from "../../../data/store";
import { setLanguage } from "../../../i18n";
import { CLAUDE_PANEL_ID } from "../../../layout/claudePanel/panelEvents";
import { DOCKED_PANEL_QUERY } from "../../../layout/useDetailPanel";
import { setMatchMedia } from "../../../test/setup";
import { renderRoute } from "../../../test/renderRoute";

// Dalla doc al backlog (11b, Task 12; shape product-claude-backlog.md
// §3.1–3.3): «⋯» → «Propose backlog items» e, dal titolo di una fase,
// «Propose backlog items from this section» aprono il riquadro di Claude con
// la scheda in blocco (la frase della persona inviata, il fuoco sulla
// scheda); confermata, le richieste compaiono in fondo alla pagina sotto
// «From this page». Pagina: Phases di ACQ (seme 11a/11b), cinque passi in
// tre fasi; due richieste del seme ne nascono già (le due della fase 2), e
// dalla prima è nata una task. Laura scrive, Sara legge soltanto.

const LAURA = "p-laura";
const SARA = "p-sara";
const PHASES = "pp-acq-phases";

const phases = () => state.productPages.find((p) => p.id === PHASES)!;
const request = (id: string) => state.requests.find((r) => r.id === id)!;
const panel = () => document.getElementById(CLAUDE_PANEL_ID)!;
const card = () => panel().querySelector<HTMLElement>("[data-proposal]");
const flat = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ");
const linked = () => screen.queryByRole("region", { name: /^From this page/ });

beforeEach(() => {
  setLatency(0);
  resetApi();
  window.localStorage.clear();
  setMatchMedia(DOCKED_PANEL_QUERY, true);
});
afterEach(() => {
  vi.restoreAllMocks();
  act(() => setLanguage("en"));
});

async function open(pageId = PHASES, person = LAURA) {
  const page = state.productPages.find((p) => p.id === pageId)!;
  renderRoute(`/p/ACQ/docs/product/${page.code}`, person);
  await screen.findByRole("heading", { level: 1, name: page.title });
  return page;
}

async function pageMenu() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "More for this page" }));
  return { user, menu: await screen.findByRole("menu", { name: "More for this page" }) };
}

async function budgetUsedUp() {
  const before = getSessionPersonId();
  setSessionPersonId("p-roberta");
  try {
    await api.instance.simulateBudgetReached(true);
  } finally {
    setSessionPersonId(before);
  }
}

describe("«⋯» → «Propose backlog items»", () => {
  it("il gruppo Claude prima di Copy link; le voci da proporre si leggono all'apertura del menu, non al montaggio", async () => {
    const propose = vi.spyOn(api.productDocs, "proposeBacklogFromPage");
    await open();
    await new Promise((r) => setTimeout(r, 20));
    expect(propose).not.toHaveBeenCalled();
    const { menu } = await pageMenu();
    const group = within(menu).getByRole("group", { name: "Claude" });
    expect(within(group).getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "Propose backlog items",
      "Draw this screen",
    ]);
    const items = within(menu).getAllByRole("menuitem").map((i) => i.textContent);
    expect(items.indexOf("Propose backlog items")).toBeLessThan(items.indexOf("Copy link"));
    await waitFor(() => expect(propose).toHaveBeenCalledWith(PHASES, undefined));
  });

  it("apre il riquadro con la frase di Laura e la scheda; il fuoco va alla scheda, con la nota delle già proposte; confermata, le voci compaiono in fondo alla pagina", async () => {
    const page = await open();
    expect(linked()).not.toBeNull();
    const before = state.requests.length;
    const { user, menu } = await pageMenu();
    await user.click(within(menu).getByRole("menuitem", { name: "Propose backlog items" }));
    await waitFor(() => expect(panel().getAttribute("data-claude-panel")).toBe("open"));
    await waitFor(() =>
      expect(panel().querySelector("[data-user-message]")).toHaveTextContent(`Propose backlog items from ${page.code} Phases`),
    );
    await waitFor(() => expect(card()).not.toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(card()));
    // La frase della pagina sotto ogni riga, e le due della fase 2 nella nota.
    expect(flat(card()!)).toContain("From the page: “Phase 1: sign-in and bills”");
    expect(flat(card()!)).toContain("From the page: “Phase 3: a dark appearance”");
    expect(flat(card()!)).not.toContain("Phase 2: fault reports");
    const note = panel().querySelector<HTMLElement>('[data-note="already_proposed"]')!;
    expect(flat(note)).toBe(
      `Already proposed from this page: ${request("req-acq-7").code}, ${request("req-acq-6").code}`,
    );
    await user.click(within(card()!).getByRole("button", { name: /^Confirm/ }));
    await waitFor(() => expect(state.requests.length).toBe(before + 3));
    const region = await screen.findByRole("region", { name: /^From this page/ });
    await waitFor(() => expect(within(region).getAllByRole("listitem")).toHaveLength(5));
    expect(flat(region)).toContain("Phase 3: a dark appearance");
    // R-G5: la descrizione salvata è la sola frase.
    const created = state.requests.at(-1)!;
    expect(created.description).toBe("Phase 3: a dark appearance");
  });

  it("una pagina senza elenchi né liste di controllo: la voce è spenta con la sua frase, senza «Who?»", async () => {
    await open("pp-acq-bills");
    const { menu } = await pageMenu();
    const item = within(menu).getByRole("menuitem", { name: "Propose backlog items" });
    await waitFor(() => expect(item).toHaveAttribute("aria-disabled", "true"));
    expect(item).toHaveAccessibleDescription("No list items or to-dos on this page");
    expect(within(menu).queryByRole("menuitem", { name: /who can/i })).toBeNull();
    const user = userEvent.setup();
    await user.click(item);
    expect(panel()?.getAttribute("data-claude-panel")).not.toBe("open");
  });

  it("col budget finito: spenta con «The monthly AI budget is used up» e il «Who?»", async () => {
    await budgetUsedUp();
    await open();
    const { menu } = await pageMenu();
    const item = within(menu).getByRole("menuitem", { name: "Propose backlog items" });
    await waitFor(() => expect(item).toHaveAttribute("aria-disabled", "true"));
    expect(item).toHaveAccessibleDescription("The monthly AI budget is used up");
    expect(within(menu).getAllByRole("menuitem", { name: /who can/i })).toHaveLength(2);
  });
});

describe("dal titolo di una fase: «Propose backlog items from this section»", () => {
  async function headingMenu(level: string) {
    const user = userEvent.setup();
    const shell = document.querySelector<HTMLElement>(`[data-block-id="${level}"]`)!;
    await user.click(within(shell).getByRole("button", { name: /^Block menu/ }));
    return { user, menu: await screen.findByRole("menu", { name: "Block menu" }) };
  }

  it("dopo «Comment»; la scheda ha solo le voci di quella fase", async () => {
    const page = await open();
    const { user, menu } = await headingMenu(PHASE_HEADINGS.phase1);
    const items = within(menu).getAllByRole("menuitem").map((i) => i.textContent);
    expect(items.indexOf("Propose backlog items from this section")).toBe(items.indexOf("Comment") + 1);
    await user.click(within(menu).getByRole("menuitem", { name: "Propose backlog items from this section" }));
    expect(
      await within(panel()).findByText(`Propose backlog items from the section “Phase 1” of ${page.code}`),
    ).toBeInTheDocument();
    await waitFor(() => expect(card()).not.toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(card()));
    expect(flat(card()!)).toContain("Phase 1: sign-in and bills");
    expect(flat(card()!)).toContain("Phase 1: meter readings");
    expect(flat(card()!)).not.toContain("Phase 3");
  });

  it("un titolo senza voci sotto: spenta con «No list items or to-dos in this section»", async () => {
    await open("pp-acq-bills");
    const heading = state.productPages.find((p) => p.id === "pp-acq-bills")!.blocks.find((b) => b.type === "heading")!;
    const { menu } = await headingMenu(heading.id);
    const item = within(menu).getByRole("menuitem", { name: "Propose backlog items from this section" });
    await waitFor(() => expect(item).toHaveAttribute("aria-disabled", "true"));
    expect(item).toHaveAccessibleDescription("No list items or to-dos in this section");
  });

  it("un paragrafo non ha la voce", async () => {
    await open();
    const first = phases().blocks[0]!;
    const { menu } = await headingMenu(first.id);
    expect(within(menu).queryByRole("menuitem", { name: /Propose backlog items/ })).toBeNull();
  });
});

describe("«From this page» in fondo alla pagina", () => {
  it("le richieste nate dalla pagina: codice, titolo, e a destra la task nata o lo stato", async () => {
    await open(PHASES, SARA);
    const region = await screen.findByRole("region", { name: /^From this page/ });
    expect(within(region).getByRole("heading", { level: 2 })).toHaveTextContent("From this page2");
    const rows = within(region).getAllByRole("listitem");
    const task = state.tasks.find((t) => t.requestId === "req-acq-6")!;
    expect(flat(rows[0]!)).toBe(`${request("req-acq-6").code}${request("req-acq-6").title}→ ${task.code}`);
    expect(flat(rows[1]!)).toBe(`${request("req-acq-7").code}${request("req-acq-7").title}Open`);
    expect(within(rows[0]!).getByRole("link", { name: request("req-acq-6").code })).toBeInTheDocument();
  });

  it("una pagina senza richieste nate da lei: la sezione non c'è", async () => {
    await open("pp-acq-bills");
    await new Promise((r) => setTimeout(r, 20));
    expect(linked()).toBeNull();
  });

  it("in italiano: «Da questa pagina» e «Aperta»", async () => {
    await open(PHASES, SARA);
    act(() => setLanguage("it"));
    const region = await screen.findByRole("region", { name: /^Da questa pagina/ });
    expect(flat(within(region).getAllByRole("listitem")[1]!)).toMatch(/Aperta$/);
  });

  it("la lettura non riesce: «Couldn't load the linked requests · Retry», e Retry la rilegge", async () => {
    failNext("productDocs.listProductLinkedRequests");
    await open(PHASES, SARA);
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(flat(retry.parentElement!)).toMatch(/^Couldn't load the linked requests\s*·\s*Retry$/);
    const user = userEvent.setup();
    await user.click(retry);
    expect(await screen.findByRole("region", { name: /^From this page/ })).toBeInTheDocument();
  });
});
