import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failNext, resetApi, setLatency } from "../../data/api";
import { state } from "../../data/store";
import { DOCKED_PANEL_QUERY } from "../../layout/useDetailPanel";
import { setMatchMedia } from "../../test/setup";
import { renderRoute } from "../../test/renderRoute";
import { clearToasts } from "../../tasks-ui/Toast";
import { WEEKS_2_QUERY, WEEKS_3_QUERY } from "./PlanningPage";

beforeEach(() => {
  setLatency(0);
  resetApi();
});

afterEach(() => clearToasts());

const chip = (code: string) =>
  screen.findByRole("button", { name: new RegExp(`^${code} `) });
/** La riga (persona) in cui sta la carta, o «pool» se è nella vasca. */
const placeOf = (code: string) => {
  const el = document.querySelector(`[data-chip="${code}"]`);
  if (!el) return null;
  if (el.closest("[data-pool]")) return "pool";
  return el.closest<HTMLElement>("[data-person]")?.dataset.person ?? null;
};
const taskOf = (code: string) => state.tasks.find((t) => t.code === code)!;

/** «P» sulla carta, poi persona e settimana dal menu. */
async function planViaKeyboard(code: string, person: string, week: RegExp) {
  const el = await chip(code);
  el.focus();
  fireEvent.keyDown(el, { key: "p" });
  const menu = await screen.findByRole("menu", { name: `Plan ${code}` });
  fireEvent.click(within(menu).getByRole("menuitemradio", { name: new RegExp(person) }));
  const weeks = await screen.findByRole("menu", { name: `Plan ${code} for ${person}` });
  fireEvent.click(within(weeks).getByRole("menuitemradio", { name: week }));
}

describe("PlanningPage di progetto", () => {
  it("vasca a sinistra, matrice persone × settimane a destra, Claude per ultimo", async () => {
    renderRoute("/p/MKX/planning");
    expect(await screen.findByRole("heading", { level: 1, name: "Planning" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "To plan" })).toBeInTheDocument();
    const grid = await screen.findByRole("grid", { name: "People and weeks" });
    const people = [...grid.querySelectorAll<HTMLElement>("[data-person]")].map((r) => r.dataset.person);
    expect(people.at(-1)).toBe("p-claude");
    expect(people).toContain("p-paolo");
    // La slittata e la non assegnata stanno nella vasca.
    await chip("MKX-8");
    expect(placeOf("MKX-8")).toBe("pool");
    expect(placeOf("MKX-5")).toBe("pool");
    // L'intestazione di riga: aperte qui · ovunque.
    const paolo = grid.querySelector<HTMLElement>('[data-row-head="p-paolo"]')!;
    expect(paolo).toHaveTextContent(/\d+ open here · \d+ everywhere/);
  });

  it("Giulia pianifica (da tastiera) una task per Paolo questa settimana: la cella si aggiorna e Paolo è avvisato", async () => {
    renderRoute("/p/MKX/planning");
    await planViaKeyboard("MKX-8", "Paolo Gatti", /^W43 /);
    await waitFor(() => expect(placeOf("MKX-8")).toBe("p-paolo"));
    expect(screen.getByTestId("planning-announcer")).toHaveTextContent("MKX-8 moved to Paolo Gatti, W43.");
    // Il fuoco resta sulla carta, rinata nella cella.
    await waitFor(() => expect(document.activeElement?.getAttribute("data-chip")).toBe("MKX-8"));
    await waitFor(() => expect(taskOf("MKX-8").assigneeId).toBe("p-paolo"));
    expect(await screen.findByText("MKX-8 planned for Paolo Gatti · W43")).toBeInTheDocument();

    // Cambio di persona: Paolo vede la notifica nel pannello.
    cleanup();
    renderRoute("/home", "p-paolo");
    await userEvent.click(await screen.findByRole("button", { name: /^Notifications/ }));
    const panel = await screen.findByRole("dialog", { name: "Notifications" });
    expect(await within(panel).findByText("Giulia Ferri planned MKX-8 for 2026-W43.")).toBeInTheDocument();
  });

  it("Sara vede le righe altrui in sola lettura; la sua resta viva", async () => {
    renderRoute("/p/STW/planning", "p-sara");
    const grid = await screen.findByRole("grid");
    const marco = grid.querySelector<HTMLElement>('[data-row-head="p-marco"]')!;
    expect(marco).toHaveAttribute("title", "You can only plan your own tasks here");
    const sara = grid.querySelector<HTMLElement>('[data-row-head="p-sara"]')!;
    expect(sara).not.toHaveAttribute("title");
    // La task di Simone non si sposta: niente menu, e il motivo nel title.
    const stw3 = await chip("STW-3");
    expect(stw3.getAttribute("title")).toMatch(/You can only plan your own tasks here/);
    stw3.focus();
    fireEvent.keyDown(stw3, { key: "p" });
    expect(screen.queryByRole("menu")).toBeNull();
    // La propria sì: e il menu offre solo lei.
    const stw6 = await chip("STW-6");
    stw6.focus();
    fireEvent.keyDown(stw6, { key: "p" });
    const menu = await screen.findByRole("menu", { name: "Plan STW-6" });
    expect(within(menu).getAllByRole("menuitemradio").map((i) => i.textContent)).toEqual([
      expect.stringMatching(/Sara Montanari/),
    ]);
  });

  it("uno spostamento che non riesce torna indietro e un messaggio lo dice", async () => {
    renderRoute("/p/MKX/planning");
    await chip("MKX-8");
    failNext("planTask");
    await planViaKeyboard("MKX-8", "Paolo Gatti", /^W43 /);
    expect(
      await screen.findByText("Couldn't move MKX-8. It's back where it was."),
    ).toBeInTheDocument();
    await waitFor(() => expect(placeOf("MKX-8")).toBe("pool"));
    expect(taskOf("MKX-8").assigneeId).toBeNull();
  });

  it("dalla cella alla vasca: toglie la settimana, tiene la persona", async () => {
    renderRoute("/p/MKX/planning");
    const mkx3 = await chip("MKX-3");
    expect(placeOf("MKX-3")).toBe("p-paolo");
    mkx3.focus();
    fireEvent.keyDown(mkx3, { key: "p" });
    const menu = await screen.findByRole("menu", { name: "Plan MKX-3" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Back to To plan/ }));
    await waitFor(() => expect(placeOf("MKX-3")).toBe("pool"));
    await waitFor(() => expect(taskOf("MKX-3").plannedWeek).toBeNull());
    expect(taskOf("MKX-3").assigneeId).toBe("p-paolo");
  });

  it("Esc chiude il menu senza chiudere il pannello della task aperto", async () => {
    renderRoute("/p/MKX/planning?task=MKX-2");
    const panel = await screen.findByRole("dialog", { name: "Task MKX-2" });
    const mkx8 = await chip("MKX-8");
    mkx8.focus();
    fireEvent.keyDown(mkx8, { key: "p" });
    const menu = await screen.findByRole("menu", { name: "Plan MKX-8" });
    fireEvent.keyDown(within(menu).getAllByRole("menuitemradio")[0]!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    // Chiudere il pannello passa dal router (asincrono): si lascia il tempo di farlo.
    await new Promise((r) => setTimeout(r, 50));
    expect(panel).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Task MKX-2" })).toBeInTheDocument();
    expect(document.activeElement?.getAttribute("data-chip")).toBe("MKX-8");
  });

  it("nella matrice le frecce passano fra le celle; Invio apre il dettaglio", async () => {
    const router = renderRoute("/p/MKX/planning");
    const mkx2 = await chip("MKX-2");
    expect(placeOf("MKX-2")).toBe("p-chiara");
    mkx2.focus();
    // Chiara → Elena, stessa settimana.
    fireEvent.keyDown(mkx2, { key: "ArrowDown" });
    expect(document.activeElement?.getAttribute("data-chip")).toBe("MKX-6");
    // Elena → Francesca: cella vuota, prende il fuoco la cella.
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toHaveAttribute("role", "gridcell");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement?.getAttribute("data-chip")).toBe("MKX-6");
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    await waitFor(() =>
      expect((router.state.location.search as { task?: string }).task).toBe("MKX-6"),
    );
  });

  it("il pannello della task si apre sempre sovrapposto, anche largo", async () => {
    setMatchMedia(DOCKED_PANEL_QUERY, true);
    renderRoute("/p/MKX/planning?task=MKX-2");
    const panel = await screen.findByRole("dialog", { name: "Task MKX-2" });
    expect(panel).toHaveAttribute("data-mode", "overlay");
  });

  it("una settimana a 1024, due da 1280, tre da 1440", async () => {
    renderRoute("/p/MKX/planning");
    const grid = await screen.findByRole("grid");
    expect(within(grid).getAllByRole("columnheader")).toHaveLength(2);
    setMatchMedia(WEEKS_2_QUERY, true);
    await waitFor(() => expect(within(grid).getAllByRole("columnheader")).toHaveLength(3));
    setMatchMedia(WEEKS_3_QUERY, true);
    await waitFor(() => expect(within(grid).getAllByRole("columnheader")).toHaveLength(4));
  });

  it("un errore della matrice mostra «Retry» e la vasca resta", async () => {
    failNext("listTasks");
    renderRoute("/p/MKX/planning");
    expect(await screen.findByRole("alert")).toHaveTextContent(/Couldn't load/);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("grid")).toBeInTheDocument();
  });
});

describe("PlanningPage trasversale", () => {
  it("reparto di chi guarda in testa; una task di un progetto senza planning.others non si sposta", async () => {
    renderRoute("/planning");
    expect(await screen.findByRole("button", { name: /Department: Marketing/ })).toBeInTheDocument();
    const grid = await screen.findByRole("grid");
    expect(grid.querySelector('[data-row-head="p-paolo"]')).not.toBeNull();
    expect(grid.querySelector('[data-row-head="p-marco"]')).toBeNull();
    // STW-4 è di Elena in STW, dove Giulia non è Project Lead.
    const stw4 = await chip("STW-4");
    expect(placeOf("STW-4")).toBe("p-elena");
    expect(stw4.getAttribute("title")).toMatch(/You can't plan tasks in /);
    stw4.focus();
    fireEvent.keyDown(stw4, { key: "p" });
    expect(screen.queryByRole("menu")).toBeNull();
    // MKX-6 è di Elena in MKX, dove Giulia è Project Lead: si sposta.
    const mkx6 = await chip("MKX-6");
    mkx6.focus();
    fireEvent.keyDown(mkx6, { key: "p" });
    expect(await screen.findByRole("menu", { name: "Plan MKX-6" })).toBeInTheDocument();
    // La vista trasversale sta nella colonna della Home, con «Planning» corrente.
    const nav = screen.getByRole("navigation", { name: "Home views" });
    expect(within(nav).getByRole("link", { name: "Planning" })).toHaveAttribute("aria-current", "page");
  });

  it("senza planning.others in nessun progetto si torna alla Home", async () => {
    const router = renderRoute("/planning", "p-sara");
    await waitFor(() => expect(router.state.location.pathname).toBe("/home"));
  });
});
