import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetApi, setLatency } from "../data/api";
import { ViewerProvider } from "../data/viewer";
import { setLanguage } from "../i18n";
import { createAppRouter } from "../router";
import { ThemeProvider } from "../theme/ThemeProvider";

function renderAt(path: string) {
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createAppRouter(history);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ViewerProvider>
        <ThemeProvider>
          <RouterProvider router={router} />
        </ThemeProvider>
      </ViewerProvider>
    </QueryClientProvider>,
  );
  return router;
}

const pathname = (router: ReturnType<typeof createAppRouter>) => router.state.location.pathname;

async function openWithShortcut(user: ReturnType<typeof userEvent.setup>) {
  await user.keyboard("{Control>}k{/Control}");
  return screen.findByRole("dialog", { name: "Search and commands" });
}

beforeEach(() => {
  setLatency(0);
  resetApi();
  window.localStorage.clear();
});

afterEach(() => {
  act(() => setLanguage("en"));
});

describe("CommandPalette", () => {
  it("⌘K apre una sola palette, col fuoco nel campo e i ruoli ARIA giusti", async () => {
    const user = userEvent.setup();
    renderAt("/home");
    await screen.findByRole("heading", { name: "Home", level: 1 });
    const dialog = await openWithShortcut(user);
    expect(screen.getAllByRole("dialog", { name: "Search and commands" })).toHaveLength(1);
    const input = within(dialog).getByRole("combobox");
    expect(input).toHaveFocus();
    const listbox = within(dialog).getByRole("listbox");
    expect(input).toHaveAttribute("aria-controls", listbox.id);
    expect(input).toHaveAttribute("aria-expanded", "true");
    // Senza ricerca: le azioni, e la prima è selezionata.
    const selected = within(listbox).getAllByRole("option", { selected: true });
    expect(selected).toHaveLength(1);
    expect(input).toHaveAttribute("aria-activedescendant", selected[0]!.id);
  });

  it("il bottone del binario apre la palette", async () => {
    const user = userEvent.setup();
    renderAt("/home");
    await user.click(await screen.findByRole("button", { name: "Search and commands" }));
    expect(await screen.findByRole("dialog", { name: "Search and commands" })).toBeInTheDocument();
  });

  it("«cbv» mostra il progetto (codice + nome) e le sue task, in gruppi", async () => {
    const user = userEvent.setup();
    renderAt("/home");
    await screen.findByRole("heading", { name: "Home", level: 1 });
    const dialog = await openWithShortcut(user);
    await user.type(within(dialog).getByRole("combobox"), "cbv");
    const projects = await within(dialog).findByRole("group", { name: "Projects" });
    const project = within(projects).getByRole("option");
    expect(project).toHaveTextContent("CBV");
    expect(project).toHaveTextContent("Store online Cantina Bellavista");
    const tasks = within(dialog).getByRole("group", { name: "Tasks" });
    const taskOptions = within(tasks).getAllByRole("option");
    expect(taskOptions.length).toBeGreaterThan(0);
    expect(taskOptions.length).toBeLessThanOrEqual(5);
    for (const o of taskOptions) expect(o).toHaveTextContent(/CBV-\d+/);
  });

  it("ogni gruppo mostra al più 5 risultati", async () => {
    const user = userEvent.setup();
    renderAt("/home");
    await screen.findByRole("heading", { name: "Home", level: 1 });
    const dialog = await openWithShortcut(user);
    // «-1» è in un codice task di ogni progetto: ben più di 5 risultati.
    await user.type(within(dialog).getByRole("combobox"), "-1");
    const tasks = await within(dialog).findByRole("group", { name: "Tasks" });
    expect(within(tasks).getAllByRole("option")).toHaveLength(5);
  });

  it("↓/↑ spostano la selezione e Invio naviga alla route del risultato e chiude", async () => {
    const user = userEvent.setup();
    const router = renderAt("/home");
    await screen.findByRole("heading", { name: "Home", level: 1 });
    const dialog = await openWithShortcut(user);
    const input = within(dialog).getByRole("combobox");
    await user.type(input, "cbv");
    const projects = await within(dialog).findByRole("group", { name: "Projects" });
    const project = within(projects).getByRole("option");
    await waitFor(() => expect(project).toHaveAttribute("aria-selected", "true"));
    await user.keyboard("{ArrowDown}");
    const firstTask = within(within(dialog).getByRole("group", { name: "Tasks" })).getAllByRole(
      "option",
    )[0]!;
    expect(firstTask).toHaveAttribute("aria-selected", "true");
    expect(input).toHaveAttribute("aria-activedescendant", firstTask.id);
    await user.keyboard("{ArrowUp}");
    expect(project).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => expect(pathname(router)).toBe("/p/CBV/tasks"));
    expect(screen.queryByRole("dialog", { name: "Search and commands" })).not.toBeInTheDocument();
  });

  it("Esc chiude e riporta il fuoco dov'era", async () => {
    const user = userEvent.setup();
    renderAt("/home");
    const trigger = await screen.findByRole("button", { name: "Search and commands" });
    await user.click(trigger);
    await screen.findByRole("dialog", { name: "Search and commands" });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Search and commands" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("«theme» mostra l'azione e Invio cambia data-theme", async () => {
    const user = userEvent.setup();
    renderAt("/home");
    await screen.findByRole("heading", { name: "Home", level: 1 });
    expect(document.documentElement.dataset.theme).toBe("light");
    const dialog = await openWithShortcut(user);
    await user.type(within(dialog).getByRole("combobox"), "theme");
    const actions = await within(dialog).findByRole("group", { name: "Actions" });
    const dark = within(actions).getByRole("option", { name: /Switch theme: dark/ });
    while (dark.getAttribute("aria-selected") !== "true") await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("una ricerca senza risultati lo dice e suggerisce codice o nome", async () => {
    const user = userEvent.setup();
    renderAt("/home");
    await screen.findByRole("heading", { name: "Home", level: 1 });
    const dialog = await openWithShortcut(user);
    await user.type(within(dialog).getByRole("combobox"), "zzqx");
    expect(await within(dialog).findByText("No results for “zzqx”")).toBeInTheDocument();
    expect(within(dialog).getByText(/Try a code like .* or a name/)).toBeInTheDocument();
  });

  it("«New task» dentro un progetto porta alle task di quel progetto", async () => {
    const user = userEvent.setup();
    const router = renderAt("/p/AUD/overview");
    await screen.findByRole("heading", { name: "Overview", level: 1 });
    const dialog = await openWithShortcut(user);
    await user.type(within(dialog).getByRole("combobox"), "new task");
    await within(dialog).findByRole("option", { name: /New task/, selected: true });
    await user.keyboard("{Enter}");
    await waitFor(() => expect(pathname(router)).toBe("/p/AUD/tasks"));
  });

  it("«View as…» apre il secondo passo; Esc torna indietro, poi chiude", async () => {
    const user = userEvent.setup();
    renderAt("/home");
    await screen.findByRole("heading", { name: "Home", level: 1 });
    const dialog = await openWithShortcut(user);
    await user.type(within(dialog).getByRole("combobox"), "view as");
    await within(dialog).findByRole("option", { name: /View as…/, selected: true });
    await user.keyboard("{Enter}");
    const group = await within(dialog).findByRole("group", { name: "View as" });
    expect(within(group).getAllByRole("option")).toHaveLength(4);
    expect(within(dialog).getByRole("combobox")).toHaveValue("");
    await user.keyboard("{Escape}");
    expect(within(dialog).queryByRole("group", { name: "View as" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Search and commands" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("scegliere una persona cambia il viewer (Roberta vede Amministrazione)", async () => {
    const user = userEvent.setup();
    const router = renderAt("/home");
    await screen.findByRole("heading", { name: "Home", level: 1 });
    let dialog = await openWithShortcut(user);
    await user.type(within(dialog).getByRole("combobox"), "view as");
    await within(dialog).findByRole("option", { name: /View as…/, selected: true });
    await user.keyboard("{Enter}");
    await user.type(within(dialog).getByRole("combobox"), "roberta");
    await within(dialog).findByRole("option", { name: /Roberta/, selected: true });
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await act(() => router.navigate({ to: "/admin" }));
    expect(await screen.findByRole("heading", { name: "Administration", level: 1 })).toBeVisible();
    dialog = await openWithShortcut(user);
    expect(dialog).toBeInTheDocument();
  });
});
