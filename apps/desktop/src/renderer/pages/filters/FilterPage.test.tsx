import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { failNext, getPersonalHome, listTasks, resetApi, setLatency } from "../../data/api";
import { setSessionPersonId } from "../../data/session";
import { state } from "../../data/store";
import { renderRoute } from "../../test/renderRoute";

const GIULIA_PUBLIC = "flt-no-estimate";

/** Le task che una persona vede con i criteri di un filtro (la verità del livello dati). */
async function tasksFor(personId: string, filterId: string) {
  setSessionPersonId(personId);
  const filter = state.filters.find((f) => f.id === filterId)!;
  return listTasks(filter.criteria);
}

const rowCodes = () =>
  [...document.querySelectorAll("[data-task-row]")].map((el) => el.getAttribute("data-task-row"));

beforeEach(() => {
  setLatency(0);
  resetApi();
});

describe("FilterPage", () => {
  it("testata: nome, «Public · by Giulia Ferri» e le azioni", async () => {
    renderRoute(`/filters/${GIULIA_PUBLIC}`, "p-giulia");
    expect(await screen.findByRole("heading", { level: 1, name: "No estimate" })).toBeInTheDocument();
    expect(screen.getByText("Public · by Giulia Ferri")).toBeInTheDocument();
    const actions = screen.getByRole("group", { name: "Filter actions" });
    expect(within(actions).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Edit",
      "Unpin from column",
      "On your Home",
      "Delete",
    ]);
  });

  it("un filtro privato dice «Private»", async () => {
    renderRoute("/filters/flt-giulia-mkx", "p-giulia");
    expect(await screen.findByText("Private")).toBeInTheDocument();
  });

  it("Review Focus 2: il filtro pubblico di Giulia, aperto da Sara, mostra solo le task di Sara", async () => {
    const giulia = await tasksFor("p-giulia", GIULIA_PUBLIC);
    const sara = await tasksFor("p-sara", GIULIA_PUBLIC);
    // Il test ha senso solo se le due persone vedono insiemi diversi.
    expect(sara.length).not.toBe(giulia.length);
    renderRoute(`/filters/${GIULIA_PUBLIC}`, "p-sara");
    await screen.findByRole("heading", { level: 1, name: "No estimate" });
    await waitFor(() => expect(rowCodes()).toHaveLength(sara.length));
    expect(new Set(rowCodes())).toEqual(new Set(sara.map((t) => t.code)));
    expect(screen.getByText(`${sara.length} tasks`)).toBeInTheDocument();
  });

  it("Sara non vede «Delete» né «Edit» sul filtro pubblico di Giulia; Roberta (full admin) sì", async () => {
    renderRoute(`/filters/${GIULIA_PUBLIC}`, "p-sara");
    const actions = await screen.findByRole("group", { name: "Filter actions" });
    expect(within(actions).queryByRole("button", { name: "Delete" })).toBeNull();
    expect(within(actions).queryByRole("button", { name: "Edit" })).toBeNull();
    cleanup();
    renderRoute(`/filters/${GIULIA_PUBLIC}`, "p-roberta");
    const admin = await screen.findByRole("group", { name: "Filter actions" });
    expect(within(admin).getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(within(admin).getByRole("button", { name: "Edit" })).toBeInTheDocument();
  });

  it("«Pin to column» aggiunge il filtro alla colonna della Home", async () => {
    const router = renderRoute("/filters/flt-open", "p-sara");
    const actions = await screen.findByRole("group", { name: "Filter actions" });
    const nav = await screen.findByRole("navigation", { name: "Home views" });
    expect(within(nav).queryByRole("link", { name: "Open" })).toBeNull();
    await userEvent.click(within(actions).getByRole("button", { name: "Pin to column" }));
    const link = await within(nav).findByRole("link", { name: "Open" });
    expect(link).toHaveAttribute("href", "/filters/flt-open");
    // Sulla pagina del filtro è lui la voce corrente, non «Home».
    await waitFor(() => expect(link).toHaveAttribute("aria-current", "page"));
    expect(within(nav).getByRole("link", { name: "Home" })).not.toHaveAttribute("aria-current");
    expect(within(actions).getByRole("button", { name: "Unpin from column" })).toBeInTheDocument();
    await router.navigate({ to: "/home" });
    const home = await screen.findByRole("navigation", { name: "Home views" });
    expect(within(home).getByRole("link", { name: "Open" })).toBeInTheDocument();
  });

  it("«Pin to column» che fallisce torna indietro e lo dice", async () => {
    renderRoute("/filters/flt-open", "p-sara");
    const actions = await screen.findByRole("group", { name: "Filter actions" });
    failNext("setFilterPinned");
    await userEvent.click(within(actions).getByRole("button", { name: "Pin to column" }));
    expect(
      await screen.findByText("Couldn't pin Open. It's back as it was."),
    ).toBeInTheDocument();
    expect(within(actions).getByRole("button", { name: "Pin to column" })).toBeInTheDocument();
  });

  it("«Add to Home» senza Home personale parte da quella del reparto e aggiunge il blocco", async () => {
    renderRoute("/filters/flt-open", "p-sara");
    const actions = await screen.findByRole("group", { name: "Filter actions" });
    await userEvent.click(within(actions).getByRole("button", { name: "Add to Home" }));
    await screen.findByText("Added Open to your Home.");
    setSessionPersonId("p-sara");
    const home = await getPersonalHome();
    expect(home?.blocks.at(-1)).toEqual({ kind: "filter", filterId: "flt-open" });
    // Sara è dell'assistenza: la sua Home parte da quella del reparto.
    expect(home?.blocks.slice(0, 5)).toEqual([
      { kind: "decide" },
      { kind: "myWeek" },
      { kind: "upcomingEvents" },
      { kind: "importantMail" },
      { kind: "myTasks" },
    ]);
    expect(within(actions).getByRole("button", { name: "On your Home" })).toBeDisabled();
  });

  it("«Delete» chiede conferma, elimina e porta a tutti i filtri", async () => {
    const router = renderRoute(`/filters/${GIULIA_PUBLIC}`, "p-giulia");
    const actions = await screen.findByRole("group", { name: "Filter actions" });
    await userEvent.click(within(actions).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete No estimate?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete filter" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/filters"));
    expect(state.filters.some((f) => f.id === GIULIA_PUBLIC)).toBe(false);
  });

  it("«Edit» rinomina e rende privato", async () => {
    renderRoute(`/filters/${GIULIA_PUBLIC}`, "p-giulia");
    const actions = await screen.findByRole("group", { name: "Filter actions" });
    await userEvent.click(within(actions).getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit filter" });
    const name = within(dialog).getByRole("textbox", { name: "Name" });
    await userEvent.clear(name);
    await userEvent.type(name, "Senza stima");
    await userEvent.click(within(dialog).getByRole("radio", { name: /Private/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Senza stima" })).toBeInTheDocument();
    expect(state.filters.find((f) => f.id === GIULIA_PUBLIC)).toMatchObject({
      name: "Senza stima",
      visibility: "private",
    });
  });

  it("errore con Retry, e il filtro che non esiste", async () => {
    failNext("getSavedFilter");
    renderRoute("/filters/flt-open", "p-giulia");
    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Open" })).toBeInTheDocument();
    cleanup();
    renderRoute("/filters/flt-nope", "p-giulia");
    expect(await screen.findByRole("heading", { name: "Filter not found" })).toBeInTheDocument();
  });
});
