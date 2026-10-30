import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetApi, setLatency } from "../data/api";
import { DEPARTMENTS } from "../data/seed/departments";
import { state } from "../data/store";
import { TASKS } from "../data/seed/tasks";
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

/** La ricerca validata dal router (quella che legge `useSearch`), non l'indirizzo grezzo. */
const validSearch = (router: ReturnType<typeof createAppRouter>) =>
  router.state.matches.at(-1)!.search as Record<string, unknown>;

const pathname = (router: ReturnType<typeof createAppRouter>) => router.state.location.pathname;

/** I nomi della legenda dei reparti, in ordine. */
const legendItems = (legend: HTMLElement) =>
  [...legend.querySelectorAll("[data-dept-legend-item]")].map((el) => el.textContent);

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

  it("dentro uno spazio Docs cerca solo lì (gruppo Pages); Tab allarga a tutto e torna", async () => {
    const user = userEvent.setup();
    const router = renderAt("/p/AUD/docs/audin-app");
    await screen.findByRole("heading", { name: "audin-app", level: 1 });
    const dialog = await openWithShortcut(user);
    expect(within(dialog).getByText("In audin-app docs")).toBeInTheDocument();
    expect(within(dialog).getByText("Tab: search everything")).toBeInTheDocument();
    const field = within(dialog).getByRole("combobox");
    await user.type(field, "stall");
    // Nello spazio di audin-app «stall» non c'è: nessun risultato, niente da altri spazi.
    expect(await within(dialog).findByText("No results for “stall”")).toBeInTheDocument();
    expect(within(dialog).queryByRole("group", { name: "Pages" })).toBeNull();
    await user.keyboard("{Tab}");
    expect(within(dialog).getByText("Everywhere")).toBeInTheDocument();
    const pages = await within(dialog).findByRole("group", { name: "Pages" });
    expect(within(pages).getAllByRole("option")[0]).toHaveTextContent(/STW-D\d+/);
    await user.keyboard("{Tab}");
    expect(within(dialog).getByText("In audin-app docs")).toBeInTheDocument();
    await user.clear(field);
    await user.type(field, "export job");
    const scoped = await within(dialog).findByRole("group", { name: "Pages" });
    expect(within(dialog).getAllByRole("group")).toHaveLength(1);
    const option = within(scoped).getByRole("option", { name: /Export job/ });
    expect(option).toHaveTextContent(/AUD-D\d+/);
    // Con l'ambito: codice · titolo · percorso, poi il passaggio.
    expect(option.querySelector("[data-palette-path]")).toHaveTextContent("Services / Reports");
    expect(option.querySelector("mark")).toBeTruthy();
    await user.click(option);
    expect(await screen.findByRole("heading", { name: "Export job", level: 1 })).toBeVisible();
    expect(pathname(router)).toBe("/p/AUD/docs/audin-app/export-job");
  });

  it("uno spazio che non c'è (o che non si legge): niente ambito, la ricerca è quella di sempre", async () => {
    const user = userEvent.setup();
    renderAt("/p/AUD/docs/nope");
    await screen.findByRole("heading", {
      name: "This page doesn't exist or you can't see it",
    });
    const dialog = await openWithShortcut(user);
    expect(within(dialog).queryByText(/In nope docs/)).toBeNull();
    expect(within(dialog).queryByText(/Tab: search everything/)).toBeNull();
    await user.type(within(dialog).getByRole("combobox"), "callback");
    const pages = await within(dialog).findByRole("group", { name: "Pages" });
    expect(within(pages).getByRole("option", { name: /Scheduled callbacks/ })).toBeInTheDocument();
  });

  it("fuori da uno spazio Docs le pagine stanno con gli altri oggetti, senza ambito", async () => {
    const user = userEvent.setup();
    renderAt("/home");
    await screen.findByRole("heading", { name: "Home", level: 1 });
    const dialog = await openWithShortcut(user);
    expect(within(dialog).queryByText(/Tab: search everything/)).toBeNull();
    await user.type(within(dialog).getByRole("combobox"), "callback");
    const pages = await within(dialog).findByRole("group", { name: "Pages" });
    expect(within(pages).getByRole("option", { name: /Scheduled callbacks/ })).toBeInTheDocument();
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

  it("le task hanno la striscia del loro reparto, col nome accessibile; i progetti no", async () => {
    const user = userEvent.setup();
    renderAt("/home");
    await screen.findByRole("heading", { name: "Home", level: 1 });
    const dialog = await openWithShortcut(user);
    await user.type(within(dialog).getByRole("combobox"), "cbv");
    const projects = await within(dialog).findByRole("group", { name: "Projects" });
    const project = within(projects).getByRole("option");
    expect(project.querySelector("[data-dept-strip]")).toBeNull();
    expect(project).not.toHaveAccessibleName(/Department:/);

    const tasks = within(dialog).getByRole("group", { name: "Tasks" });
    for (const option of within(tasks).getAllByRole("option")) {
      const code = /CBV-\d+/.exec(option.textContent ?? "")![0];
      const task = TASKS.find((t) => t.code === code)!;
      const dept = DEPARTMENTS.find((d) => d.id === task.departmentId)!;
      const strip = option.querySelector("[data-dept-strip]");
      expect(strip).toHaveAttribute("data-dept-strip", dept.id);
      expect(strip).toHaveAttribute("aria-hidden", "true");
      expect(option).toHaveAccessibleName(new RegExp("Department: " + dept.name + "$"));
      // Tooltip visibile della riga.
      expect(option).toHaveAttribute("title", "Department: " + dept.name);
    }
    expect(project).not.toHaveAttribute("title");
  });

  it("la legenda nel piede elenca solo i reparti delle task mostrate, in una riga", async () => {
    const user = userEvent.setup();
    renderAt("/home");
    await screen.findByRole("heading", { name: "Home", level: 1 });
    const dialog = await openWithShortcut(user);
    expect(within(dialog).queryByRole("group", { name: "Departments" })).toBeNull();
    await user.type(within(dialog).getByRole("combobox"), "cbv-1");
    const tasks = await within(dialog).findByRole("group", { name: "Tasks" });
    await waitFor(() => expect(within(tasks).getAllByRole("option")).toHaveLength(1));
    const legend = within(dialog).getByRole("group", { name: "Departments" });
    const cbv1 = TASKS.find((t) => t.code === "CBV-1")!;
    expect(legendItems(legend)).toEqual([
      DEPARTMENTS.find((d) => d.id === cbv1.departmentId)!.name,
    ]);
    expect(legend).toHaveClass("whitespace-nowrap", "text-xs");

    await user.clear(within(dialog).getByRole("combobox"));
    await user.type(within(dialog).getByRole("combobox"), "cbv");
    await waitFor(() =>
      expect(legendItems(within(dialog).getByRole("group", { name: "Departments" }))).toHaveLength(
        new Set(TASKS.filter((t) => t.code.startsWith("CBV-")).map((t) => t.departmentId)).size,
      ),
    );
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

  it("risultati della query precedente: opachi e non selezionabili con Invio finché non arrivano i nuovi", async () => {
    const user = userEvent.setup();
    const router = renderAt("/home");
    await screen.findByRole("heading", { name: "Home", level: 1 });
    const dialog = await openWithShortcut(user);
    const input = within(dialog).getByRole("combobox");
    await user.type(input, "cbv");
    const projects = await within(dialog).findByRole("group", { name: "Projects" });
    const row = within(projects).getByRole("option");
    await waitFor(() => expect(row).toHaveAttribute("aria-selected", "true"));
    expect(within(dialog).getByRole("listbox")).toHaveAttribute("aria-busy", "false");
    // Un altro carattere: la query digitata non è più quella cercata.
    await user.type(input, "x");
    expect(within(dialog).getByRole("listbox")).toHaveAttribute("aria-busy", "true");
    expect(row).toHaveClass("opacity-50");
    await user.keyboard("{Enter}");
    expect(pathname(router)).toBe("/home");
    expect(screen.getByRole("dialog", { name: "Search and commands" })).toBeInTheDocument();
    // Quando la ricerca si è assestata la palette non è più occupata.
    await waitFor(() =>
      expect(within(dialog).getByRole("listbox")).toHaveAttribute("aria-busy", "false"),
    );
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

  it("«New task» resta sulla route e aggiunge ?newTask=1&project=<CODE> dentro un progetto", async () => {
    const user = userEvent.setup();
    const router = renderAt("/p/AUD/overview");
    await screen.findByRole("heading", { name: "Overview", level: 1 });
    const dialog = await openWithShortcut(user);
    await user.type(within(dialog).getByRole("combobox"), "new task");
    await within(dialog).findByRole("option", { name: /New task/, selected: true });
    await user.keyboard("{Enter}");
    await waitFor(() => expect(validSearch(router)).toMatchObject({ newTask: "1" }));
    expect(pathname(router)).toBe("/p/AUD/overview");
    expect(validSearch(router)).toMatchObject({ project: "AUD" });
  });

  it("«New task» fuori da un progetto: ?newTask=1 sulla route corrente, senza project", async () => {
    const user = userEvent.setup();
    const router = renderAt("/home");
    await screen.findByRole("heading", { name: "Home", level: 1 });
    const dialog = await openWithShortcut(user);
    await user.type(within(dialog).getByRole("combobox"), "new task");
    await within(dialog).findByRole("option", { name: /New task/, selected: true });
    await user.keyboard("{Enter}");
    await waitFor(() => expect(validSearch(router)).toMatchObject({ newTask: "1" }));
    expect(pathname(router)).toBe("/home");
    expect(validSearch(router).project).toBeUndefined();
  });

  it("«New request» porta ?newRequest=<CODE> dentro un progetto", async () => {
    const user = userEvent.setup();
    const router = renderAt("/p/AUD/tasks");
    await screen.findByRole("heading", { name: "Tasks", level: 1 });
    const dialog = await openWithShortcut(user);
    await user.type(within(dialog).getByRole("combobox"), "new request");
    await within(dialog).findByRole("option", { name: /New request/, selected: true });
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(validSearch(router)).toMatchObject({ newRequest: "AUD" }),
    );
    expect(pathname(router)).toBe("/p/AUD/tasks");
  });

  it("«Open filter…» apre il secondo passo coi filtri visibili; Invio porta a #/filters/<id>", async () => {
    const user = userEvent.setup();
    const router = renderAt("/home");
    await screen.findByRole("heading", { name: "Home", level: 1 });
    const dialog = await openWithShortcut(user);
    await user.type(within(dialog).getByRole("combobox"), "open filter");
    await within(dialog).findByRole("option", { name: /Open filter…/, selected: true });
    await user.keyboard("{Enter}");
    const group = await within(dialog).findByRole("group", { name: "Filters" });
    expect(within(group).getByRole("option", { name: /Closed this month/ })).toBeInTheDocument();
    await user.type(within(dialog).getByRole("combobox"), "closed this");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(pathname(router)).toBe("/filters/flt-closed-month"));
  });

  it("«Go to channel…» elenca i canali di chi guarda; «New message» apre il dialogo sopra la pagina", async () => {
    const user = userEvent.setup();
    const router = renderAt("/home");
    await screen.findByRole("heading", { name: "Home", level: 1 });
    let dialog = await openWithShortcut(user);
    await user.type(within(dialog).getByRole("combobox"), "go to channel");
    await within(dialog).findByRole("option", { name: /Go to channel…/, selected: true });
    await user.keyboard("{Enter}");
    const group = await within(dialog).findByRole("group", { name: "Channels" });
    await user.type(within(dialog).getByRole("combobox"), "grafica");
    await within(group).findByRole("option", { name: /grafica/ });
    // Un DM altrui non c'è (Giulia non è nel DM fra Davide e Sara).
    expect(within(group).queryByRole("option", { name: /Davide/ })).toBeNull();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(pathname(router)).toBe("/chat/ch-mkx-grafica"));

    dialog = await openWithShortcut(user);
    await user.type(within(dialog).getByRole("combobox"), "new message");
    await within(dialog).findByRole("option", { name: /New message/, selected: true });
    await user.keyboard("{Enter}");
    await waitFor(() => expect(validSearch(router).newMessage).toBe("1"));
    expect(pathname(router)).toBe("/chat/ch-mkx-grafica");
    expect(await screen.findByRole("dialog", { name: "New message" })).toBeInTheDocument();
  });

  it("un risultato task porta a #/p/<CODE>/tasks?task=<CODE-n>", async () => {
    const user = userEvent.setup();
    const router = renderAt("/home");
    await screen.findByRole("heading", { name: "Home", level: 1 });
    const dialog = await openWithShortcut(user);
    const code = TASKS[0]!.code;
    await user.type(within(dialog).getByRole("combobox"), code);
    const group = await within(dialog).findByRole("group", { name: "Tasks" });
    await user.click(
      await within(group).findByRole("option", { name: new RegExp(`^${code}(?!\\d)`) }),
    );
    await waitFor(() => expect(validSearch(router)).toMatchObject({ task: code }));
    expect(pathname(router)).toBe(`/p/${code.split("-")[0]}/tasks`);
  });

  it("una richiesta si trova per codice e apre il suo pannello (?request=)", async () => {
    const user = userEvent.setup();
    const router = renderAt("/home");
    await screen.findByRole("heading", { name: "Home", level: 1 });
    const dialog = await openWithShortcut(user);
    await user.type(within(dialog).getByRole("combobox"), "STW-R2");
    const group = await within(dialog).findByRole("group", { name: "Requests" });
    await user.click(await within(group).findByRole("option", { name: /^STW-R2/ }));
    await waitFor(() => expect(validSearch(router)).toMatchObject({ request: "req-stw-2" }));
    expect(pathname(router)).toBe("/p/STW/requests");
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
    expect(within(group).getAllByRole("option")).toHaveLength(6);
    expect(within(group).getByRole("option", { name: /Matteo Conti/ })).toBeInTheDocument();
    expect(within(dialog).getByRole("combobox")).toHaveValue("");
    await user.keyboard("{Escape}");
    expect(within(dialog).queryByRole("group", { name: "View as" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Search and commands" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("scegliere una persona cambia il viewer (Roberta vede Roles)", async () => {
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
    // Roles (area 9a) chiede `roles.manage`: Giulia non la vede, Roberta sì.
    await act(() => router.navigate({ to: "/admin/$section", params: { section: "roles" } }));
    expect(await screen.findByRole("heading", { name: "Roles", level: 1 })).toBeVisible();
    dialog = await openWithShortcut(user);
    expect(dialog).toBeInTheDocument();
  });
});

describe("CommandPalette — la riga che parte selezionata (R-H4)", () => {
  /** Un messaggio della Chat che cita il testo cercato, nel canale grafica di MKX (Giulia ci è). */
  function message(id: string, text: string) {
    state.chatMessages.push({
      id,
      channelId: "ch-mkx-grafica",
      createdAt: "2026-10-23T08:00:00Z",
      threadOf: null,
      authorId: "p-marco",
      kind: "person",
      text,
      attachments: [],
      citations: [],
      reactions: [],
      asksReplyOf: [],
      linkedCodes: [],
      editedAt: null,
      deletedAt: null,
      deletedById: null,
    });
  }

  /** Aspetta che le ricerche (oggetti, Chat, Docs, Drive) siano arrivate. */
  const settle = () => act(() => new Promise((r) => setTimeout(r, 250)));

  it("«theme» con un messaggio che lo cita: parte selezionato il comando, Invio cambia tema", async () => {
    message("theme-1", "the theme of the campaign is spring");
    const user = userEvent.setup();
    renderAt("/home");
    await screen.findByRole("heading", { name: "Home", level: 1 });
    const dialog = await openWithShortcut(user);
    await user.type(within(dialog).getByRole("combobox"), "theme");
    await within(dialog).findByRole("group", { name: "Messages" });
    await settle();
    // L'ordine visivo resta A5: i messaggi stanno sopra le azioni.
    const groups = within(dialog)
      .getAllByRole("group")
      .map((g) => g.querySelector(".heading-group")?.textContent);
    expect(groups.indexOf("Messages")).toBeLessThan(groups.indexOf("Actions"));
    expect(within(dialog).getByRole("option", { selected: true })).toHaveTextContent(/Switch theme/);
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("in italiano «tema» fa lo stesso", async () => {
    act(() => setLanguage("it"));
    message("theme-2", "il tema della campagna è la primavera");
    const user = userEvent.setup();
    renderAt("/home");
    await screen.findByRole("heading", { level: 1 });
    await user.keyboard("{Control>}k{/Control}");
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByRole("combobox"), "tema");
    await within(dialog).findByRole("group", { name: "Messaggi" });
    await settle();
    expect(within(dialog).getByRole("option", { selected: true })).toHaveTextContent(/Cambia tema/);
  });

  it("una task il cui titolo comincia come un comando: vince la task", async () => {
    const task = state.tasks.find((x) => x.code === "AUD-1")!;
    task.title = "New task template for onboarding";
    const user = userEvent.setup();
    renderAt("/home");
    await screen.findByRole("heading", { name: "Home", level: 1 });
    const dialog = await openWithShortcut(user);
    await user.type(within(dialog).getByRole("combobox"), "new task");
    const tasks = await within(dialog).findByRole("group", { name: "Tasks" });
    await settle();
    expect(within(dialog).getByRole("option", { selected: true })).toBe(
      within(tasks).getAllByRole("option")[0],
    );
    expect(within(dialog).getByRole("option", { name: /^New task$/ })).toBeInTheDocument();
  });

  it("«Search all…» non parte mai selezionato se c'è altro", async () => {
    const user = userEvent.setup();
    renderAt("/p/AUD/drive");
    await screen.findByRole("heading", { name: "Drive", level: 1 });
    const dialog = await openWithShortcut(user);
    await user.type(within(dialog).getByRole("combobox"), "penalty");
    await within(dialog).findByRole("group", { name: "Files" });
    await settle();
    const selected = within(dialog).getByRole("option", { selected: true });
    expect(selected).toHaveTextContent(/AUD-F7/);
    expect(selected).not.toHaveTextContent(/Search all/);
  });
});
