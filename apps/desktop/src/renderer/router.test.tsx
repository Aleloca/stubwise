import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { failNext, resetApi, setLatency } from "./data/api";
import { ViewerProvider } from "./data/viewer";
import { createAppRouter } from "./router";
import { ThemeProvider } from "./theme/ThemeProvider";

function renderAt(path: string, personId?: string) {
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createAppRouter(history);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
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

  it("/admin: il full admin vede il placeholder", async () => {
    renderAt("/admin", "p-roberta");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Administration" }),
    ).toBeInTheDocument();
    expect(screen.getByText("This area hasn't been designed yet")).toBeInTheDocument();
  });
});
