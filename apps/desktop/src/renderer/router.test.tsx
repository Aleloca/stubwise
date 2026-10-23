import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { failNext, getTaskByCode, resetApi, setLatency } from "./data/api";
import { ViewerProvider } from "./data/viewer";
import { createAppRouter } from "./router";
import { ThemeProvider } from "./theme/ThemeProvider";

function renderAt(path: string, personId?: string) {
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createAppRouter(history);
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ViewerProvider initialPersonId={personId}>
        <ThemeProvider>
          <RouterProvider router={router} />
        </ThemeProvider>
      </ViewerProvider>
    </QueryClientProvider>,
  );
  return router;
}

beforeEach(() => {
  setLatency(0);
  resetApi();
});

describe("router", () => {
  it("/ porta a /home", async () => {
    const router = renderAt("/");
    expect(await screen.findByRole("heading", { level: 1, name: "Home" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/home");
  });

  it("/p/AUD porta a /p/AUD/overview", async () => {
    const router = renderAt("/p/AUD");
    expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/p/AUD/overview");
  });

  it("#/p/aud (minuscolo) reindirizza a #/p/AUD, conservando sezione e ricerca", async () => {
    const router = renderAt("/p/aud/tasks?task=AUD-1");
    expect(await screen.findByRole("heading", { name: "Tasks" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/p/AUD/tasks");
    expect(router.state.location.search).toEqual({ task: "AUD-1" });
    cleanup();
    const bare = renderAt("/p/aud");
    await waitFor(() => expect(bare.state.location.pathname).toBe("/p/AUD/overview"));
  });

  it("?task= valido su ogni route; un valore malformato viene scartato", async () => {
    const router = renderAt("/home?task=AUD-1");
    await screen.findByRole("heading", { level: 1, name: "Home" });
    expect(router.state.location.search).toEqual({ task: "AUD-1" });
    cleanup();
    const bad = renderAt("/chat?task=nope");
    await screen.findByRole("heading", { level: 1, name: "Chat" });
    // `location.search` è la ricerca grezza; quella validata sta nei match.
    expect(bad.state.matches.at(-1)!.search).toEqual({});
  });

  it("#/filters/<id>: un filtro pubblico si apre, il privato di un altro è «Filter not found»", async () => {
    renderAt("/filters/flt-open");
    expect(await screen.findByRole("heading", { level: 1, name: "Open" })).toBeInTheDocument();
    cleanup();
    // flt-giulia-week è privato di Giulia: Marco non lo vede.
    renderAt("/filters/flt-giulia-week", "p-marco");
    expect(await screen.findByRole("heading", { name: "Filter not found" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Home" })).toHaveAttribute("href", "/home");
    cleanup();
    renderAt("/filters/flt-giulia-week", "p-giulia");
    expect(await screen.findByRole("heading", { level: 1, name: /./ })).not.toHaveTextContent(
      "Filter not found",
    );
  });

  it("#/planning senza planning.others in nessun progetto rimanda alla Home", async () => {
    const router = renderAt("/planning", "p-marco");
    await waitFor(() => expect(router.state.location.pathname).toBe("/home"));
    cleanup();
    const lead = renderAt("/planning", "p-laura");
    expect(await screen.findByRole("heading", { level: 1, name: "Planning" })).toBeInTheDocument();
    expect(lead.state.location.pathname).toBe("/planning");
  });

  it("una sezione il cui modulo manca reindirizza a overview", async () => {
    const router = renderAt("/p/MKX/releases");
    expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/p/MKX/overview");
  });

  it("un progetto inesistente mostra «Project not found» con il link alla Home", async () => {
    renderAt("/p/ZZZZ/tasks");
    expect(await screen.findByText("Project not found")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Home" })).toHaveAttribute("href", "/home");
  });

  it("mentre il progetto carica c'è una riga calma, non una pagina vuota", async () => {
    setLatency(30);
    renderAt("/p/AUD/tasks");
    expect(await screen.findByText("Loading project…")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Tasks" })).toBeInTheDocument();
  });

  it("una query di progetto FALLITA mostra l'errore con Try again, non «not found»", async () => {
    const user = userEvent.setup();
    failNext("getProjectByCode");
    renderAt("/p/AUD/tasks");
    expect(await screen.findByText("Couldn't load this project.")).toBeInTheDocument();
    expect(screen.queryByText("Project not found")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Tasks" })).toBeInTheDocument();
  });

  it("un indirizzo sconosciuto mostra «Page not found» con il link alla Home", async () => {
    renderAt("/foo");
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Home" })).toHaveAttribute("href", "/home");
  });

  it("una sezione sconosciuta reindirizza a overview", async () => {
    const router = renderAt("/p/AUD/bogus");
    expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/p/AUD/overview");
  });

  it("/admin: il Developer torna a /home", async () => {
    const router = renderAt("/admin", "p-marco");
    expect(await screen.findByRole("heading", { level: 1, name: "Home" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/home");
  });

  it("cambiare persona con una task aperta: chi non vede il progetto non vede i dati vecchi", async () => {
    const user = userEvent.setup();
    const task = (await getTaskByCode("MKX-2"))!;
    // Il pannello si monta su `?task=` in ogni route: con la persona nuova né
    // la pagina né il pannello mostrano dati della task.
    renderAt("/p/MKX/overview?task=MKX-2");
    expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument();
    // Precondizione: come Giulia il progetto c'è (nome nella colonna) e il
    // pannello mostra il titolo della task.
    const column = document.querySelector<HTMLElement>('[data-zone="column"]')!;
    expect(await within(column).findByText("Campagne primavera Mix Cucine")).toBeInTheDocument();
    const panel = await screen.findByRole("dialog", { name: "Task MKX-2" });
    expect(await within(panel).findByRole("heading", { name: task.title })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Profile and settings" }));
    const menu = await screen.findByRole("dialog", { name: "Profile and settings" });
    await user.click(within(menu).getByRole("radio", { name: /Sara Montanari/ }));
    expect(await screen.findByText("Project not found")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Overview" })).toBeNull();
    expect(screen.queryByText(task.title)).toBeNull();
    expect(screen.queryByText(/Campagne primavera Mix Cucine/)).toBeNull();
    const after = screen.getByRole("dialog", { name: "Task MKX-2" });
    expect(
      await within(after).findByText("This task doesn't exist or you can't see it."),
    ).toBeInTheDocument();
    expect(screen.queryByText(task.title)).toBeNull();
  });

  it("/admin: il full admin vede il placeholder", async () => {
    renderAt("/admin", "p-roberta");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Administration" }),
    ).toBeInTheDocument();
    expect(screen.getByText("This area hasn't been designed yet")).toBeInTheDocument();
  });
});
