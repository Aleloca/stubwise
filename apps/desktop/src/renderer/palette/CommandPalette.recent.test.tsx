import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failNext, resetApi, setLatency } from "../data/api";
import { state } from "../data/store";
import { ViewerProvider } from "../data/viewer";
import { setLanguage } from "../i18n";
import { createAppRouter } from "../router";
import { ThemeProvider } from "../theme/ThemeProvider";

// I risultati aperti di recente nella ⌘K (shape `search-history.md`): a query
// vuota in testa, togliere una voce (✕ e ⌘⌫), «Clear all», la riga sulla
// privacy, e cosa si ricorda aprendo un risultato. Laura ha tre recenti nel seme.

function renderAt(path: string, personId = "p-laura") {
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createAppRouter(history);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ViewerProvider initialPersonId={personId}>
        <ThemeProvider>
          <RouterProvider router={router} />
        </ThemeProvider>
      </ViewerProvider>
    </QueryClientProvider>,
  );
  return router;
}

async function open(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole("heading", { name: "Home", level: 1 });
  await user.keyboard("{Control>}k{/Control}");
  return screen.findByRole("dialog", { name: "Search and commands" });
}

const recentGroup = (dialog: HTMLElement) => within(dialog).findByRole("group", { name: "Recent" });

beforeEach(() => {
  setLatency(0);
  resetApi();
  window.localStorage.clear();
});
afterEach(() => act(() => setLanguage("en")));

describe("⌘K, i risultati recenti", () => {
  it("a query vuota il gruppo Recent sta in testa, con la riga sulla privacy; scrivendo sparisce", async () => {
    const user = userEvent.setup();
    renderAt("/home");
    const dialog = await open(user);
    const recent = await recentGroup(dialog);
    const groups = within(dialog).getAllByRole("group");
    expect(groups[0]).toBe(recent);
    expect(within(recent).getAllByRole("option")).toHaveLength(3);
    expect(within(recent).getByText("Only you see these: the results you opened, kept for your account.")).toBeInTheDocument();
    await user.type(within(dialog).getByRole("combobox"), "cbv");
    await waitFor(() => expect(within(dialog).queryByRole("group", { name: "Recent" })).toBeNull());
  });

  it("chi non ha recenti non vede il gruppo", async () => {
    const user = userEvent.setup();
    renderAt("/home", "p-giulia");
    const dialog = await open(user);
    await within(dialog).findAllByRole("option");
    expect(within(dialog).queryByRole("group", { name: "Recent" })).toBeNull();
  });

  it("✕ toglie una voce; ⌘⌫ toglie quella selezionata, e la barra dei tasti lo dice", async () => {
    const user = userEvent.setup();
    renderAt("/home");
    const dialog = await open(user);
    const recent = await recentGroup(dialog);
    const [first] = within(recent).getAllByRole("option");
    const title = first!.textContent!;
    await user.click(within(recent).getAllByRole("button", { name: /from recent$/ })[0]!);
    await waitFor(() => expect(within(recent).getAllByRole("option")).toHaveLength(2));
    expect(recent).not.toHaveTextContent(title);
    await user.keyboard("{ArrowDown}");
    expect(within(dialog).getByText("to remove")).toBeInTheDocument();
    await user.keyboard("{Meta>}{Backspace}{/Meta}");
    await waitFor(() => expect(within(recent).getAllByRole("option")).toHaveLength(1));
    expect(state.searchHistory.filter((e) => e.personId === "p-laura")).toHaveLength(1);
  });

  it("M3: togliere è ottimistico — la riga esce subito; se la scrittura fallisce torna, poi il toast", async () => {
    const user = userEvent.setup();
    renderAt("/home");
    const dialog = await open(user);
    const recent = await recentGroup(dialog);
    setLatency(300);
    failNext("searchHistory.forgetResult");
    await user.click(within(recent).getAllByRole("button", { name: /from recent$/ })[0]!);
    expect(within(recent).getAllByRole("option")).toHaveLength(2);
    expect(await screen.findByText("Couldn't remove it from recent.")).toBeInTheDocument();
    await waitFor(() => expect(within(recent).getAllByRole("option")).toHaveLength(3));
  });

  it("Clear all svuota tutto, senza conferma; il gruppo sparisce", async () => {
    const user = userEvent.setup();
    renderAt("/home");
    const dialog = await open(user);
    const recent = await recentGroup(dialog);
    await user.click(within(recent).getByRole("button", { name: "Clear all" }));
    await waitFor(() => expect(within(dialog).queryByRole("group", { name: "Recent" })).toBeNull());
    expect(state.searchHistory.filter((e) => e.personId === "p-laura")).toEqual([]);
  });

  it("aprire una task trovata la ricorda in cima; riaprire un recente lo riporta in cima", async () => {
    const user = userEvent.setup();
    // Roberta (full admin) vede ogni task: il filtro a lettura del server (`tickets.view_all`) la lascia.
    renderAt("/home", "p-roberta");
    let dialog = await open(user);
    await user.type(within(dialog).getByRole("combobox"), "cbv");
    const tasks = await within(dialog).findByRole("group", { name: "Tasks" });
    const task = within(tasks).getAllByRole("option")[0]!;
    const code = /CBV-\d+/.exec(task.textContent!)![0];
    await user.click(task);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Search and commands" })).toBeNull());
    await waitFor(() => expect(state.searchHistory.filter((e) => e.personId === "p-roberta")).toHaveLength(1));
    expect(state.searchHistory.find((e) => e.personId === "p-roberta")).toMatchObject({ type: "ticket", subtitle: code });
    await user.keyboard("{Control>}k{/Control}");
    dialog = await screen.findByRole("dialog", { name: "Search and commands" });
    const recent = await recentGroup(dialog);
    expect(within(recent).getAllByRole("option")[0]).toHaveTextContent(code);
  });

  it("la posta MAI: aprire un'email dalla ⌘K non lascia traccia (invariante)", async () => {
    const user = userEvent.setup();
    renderAt("/home", "p-giulia");
    const dialog = await open(user);
    await user.type(within(dialog).getByRole("combobox"), "VAT number");
    const group = await within(dialog).findByRole("group", { name: "Mail" });
    const row = await waitFor(() => {
      const el = group.querySelector<HTMLElement>("[data-palette-mail]");
      if (!el) throw new Error("no mail yet");
      return el;
    });
    await user.click(row);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Search and commands" })).toBeNull());
    await new Promise((r) => setTimeout(r, 50));
    expect(state.searchHistory.filter((e) => e.personId === "p-giulia")).toEqual([]);
  });
});
