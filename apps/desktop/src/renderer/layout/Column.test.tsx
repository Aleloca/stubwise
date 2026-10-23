import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetApi, setLatency } from "../data/api";
import { PROJECT_SECTIONS } from "../data/routes";
import { PROJECTS } from "../data/seed/projects";
import { ViewerProvider } from "../data/viewer";
import i18n, { setLanguage } from "../i18n";
import { APP_ROUTES } from "../data/routes";
import { createAppRouter } from "../router";
import { setMatchMedia } from "../test/setup";
import { ThemeProvider } from "../theme/ThemeProvider";
import { DetailPanel, useDetailPanel } from "./useDetailPanel";

async function renderAt(path: string, personId?: string) {
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
  await waitFor(() => expect(column()).not.toBeNull());
  return router;
}

const column = () => document.querySelector<HTMLElement>('[data-zone="column"]')!;

async function sectionLinks(name = "Project sections") {
  const nav = await screen.findByRole("navigation", { name });
  return within(nav).getAllByRole("link");
}

beforeEach(() => {
  setLatency(0);
  resetApi();
  window.localStorage.clear();
});

afterEach(() => {
  act(() => setLanguage("en"));
  delete (document as { startViewTransition?: unknown }).startViewTransition;
});

describe("ProjectColumn", () => {
  it("su /p/AUD/tasks mostra codice e nome, e le sezioni nell'ordine con Tasks corrente", async () => {
    await renderAt("/p/AUD/tasks");
    const heading = await within(column()).findByRole("heading", { level: 2 });
    expect(heading).toHaveTextContent("AUD");
    expect(heading).toHaveTextContent("Audin 2.0");
    expect(within(column()).getByText("Internal")).toBeInTheDocument();

    const links = await sectionLinks();
    expect(links.map((l) => l.getAttribute("data-section"))).toEqual(
      PROJECT_SECTIONS.map((s) => s.id),
    );
    const tasks = links.find((l) => l.getAttribute("data-section") === "tasks")!;
    expect(tasks).toHaveAttribute("href", "/p/AUD/tasks");
    await waitFor(() => expect(tasks).toHaveAttribute("aria-current", "page"));
    expect(links.filter((l) => l.getAttribute("aria-current") === "page")).toHaveLength(1);
  });

  it("su un progetto marketing non compaiono Releases e Servers", async () => {
    await renderAt("/p/MKX/overview");
    const ids = (await sectionLinks()).map((l) => l.getAttribute("data-section"));
    expect(ids).not.toContain("releases");
    expect(ids).not.toContain("servers");
    expect(ids).toContain("docs");
    expect(ids).toContain("settings");
    expect(within(column()).getByText(/Client/)).toHaveTextContent("Mix Cucine Srl");
  });

  it("il nome più lungo del seed va a capo su due righe al massimo, intero nel title", async () => {
    const longest = [...PROJECTS].sort((a, b) => b.name.length - a.name.length)[0]!;
    expect(longest.name.length).toBeGreaterThanOrEqual(34);
    await renderAt(`/p/${longest.code}/overview`);
    const name = await within(column()).findByText(longest.name);
    expect(name).toHaveAttribute("title", longest.name);
    // `line-clamp-2` di Tailwind: due righe, ellissi in fondo (happy-dom non
    // espone le proprietà -webkit, quindi si guarda la classe).
    expect(name).toHaveClass("line-clamp-2");
    expect(name).not.toHaveClass("truncate");
    expect(name).not.toHaveStyle({ whiteSpace: "nowrap" });
  });

  it("il codice è l'ancora della testata: riga sua, a scala di titolo, sopra il nome", async () => {
    await renderAt("/p/AUD/tasks");
    const heading = await within(column()).findByRole("heading", { level: 2 });
    expect(heading).toHaveAccessibleName("AUD Audin 2.0");
    const code = heading.querySelector<HTMLElement>("[data-column-code]")!;
    expect(code).toHaveTextContent(/^AUD$/);
    expect(code).toHaveClass("text-2xl", "num");
    const name = within(heading).getByText("Audin 2.0");
    expect(name).not.toBe(code);
    expect(name).toHaveClass("text-lg");
    // Il codice viene prima del nome, in colonna.
    expect(heading).toHaveClass("flex-col");
    expect(code.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("in italiano le voci restano su una riga", async () => {
    act(() => setLanguage("it"));
    await renderAt("/p/AUD/tasks");
    const links = await sectionLinks("Sezioni del progetto");
    expect(within(links[0]!).getByText("Panoramica")).toBeInTheDocument();
    for (const link of links) {
      expect(link).toHaveStyle({ whiteSpace: "nowrap" });
    }
  });

  it("Settings è sempre visibile; senza project.settings.manage è in sola lettura", async () => {
    // Sara è Contributor su tutto: niente project.settings.manage.
    await renderAt("/p/AUD/overview", "p-sara");
    let settings = (await sectionLinks()).find(
      (l) => l.getAttribute("data-section") === "settings",
    )!;
    expect(settings).toHaveTextContent("View only");
    await cleanupAndRender("/p/AUD/overview", "p-roberta");
    settings = (await sectionLinks()).find((l) => l.getAttribute("data-section") === "settings")!;
    expect(settings).not.toHaveTextContent("View only");
  });
});

async function cleanupAndRender(path: string, personId: string) {
  cleanup();
  await renderAt(path, personId);
}

describe("PersonalColumn", () => {
  it("su /home mostra la colonna personale con le sottoviste", async () => {
    await renderAt("/home");
    const nav = await within(column()).findByRole("navigation", { name: "Home views" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["Assigned to me", "Delegated", "Following"]);
    await waitFor(() => expect(links[0]).toHaveAttribute("aria-current", "page"));
    expect(screen.queryByRole("navigation", { name: "Project sections" })).toBeNull();
  });

  it("una sottovista resta sulla stessa route e diventa corrente", async () => {
    const router = await renderAt("/home");
    const nav = await within(column()).findByRole("navigation", { name: "Home views" });
    await userEvent.click(within(nav).getByRole("link", { name: "Delegated" }));
    await waitFor(() =>
      expect(within(nav).getByRole("link", { name: "Delegated" })).toHaveAttribute(
        "aria-current",
        "page",
      ),
    );
    expect(within(nav).getByRole("link", { name: "Assigned to me" })).not.toHaveAttribute(
      "aria-current",
    );
    expect(router.state.location.pathname).toBe("/home");
    expect(screen.getByRole("heading", { level: 1, name: "Home" })).toBeInTheDocument();
  });

  it("sulle destinazioni personali la colonna non ha titolo: il nome è l'h1 a 28 px", async () => {
    await renderAt("/home");
    await within(column()).findByRole("navigation", { name: "Home views" });
    expect(within(column()).queryByRole("heading")).toBeNull();
    expect(within(column()).queryByText("Home")).toBeNull();
    const h1 = await screen.findByRole("heading", { level: 1, name: "Home" });
    expect(h1).toHaveClass("text-2xl");
    cleanup();
    await renderAt("/p/AUD/tasks");
    // In un progetto la colonna tiene codice e nome, l'h1 dice la sezione, stesso stile.
    expect(await within(column()).findByRole("heading", { level: 2 })).toHaveTextContent("AUD");
    expect(await screen.findByRole("heading", { level: 1, name: "Tasks" })).toHaveClass("text-2xl");
  });

  it("l'etichetta della navigazione personale segue la lingua", async () => {
    act(() => setLanguage("it"));
    await renderAt("/chat");
    expect(
      await within(column()).findByRole("navigation", { name: "Viste di Chat" }),
    ).toBeInTheDocument();
  });

  it("ogni destinazione ha un h1 a 28 px nell'area di lavoro", async () => {
    const router = await renderAt("/home", "p-roberta");
    for (const name of APP_ROUTES) {
      await act(() => router.navigate({ to: `/${name}` }));
      const h1 = await screen.findByRole("heading", { level: 1 });
      expect(h1).toHaveTextContent(i18n.t(`nav.${name}`));
      expect(h1).toHaveClass("text-2xl");
      expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    }
  });

  it("senza sottoviste la colonna ha uno stato neutro, larga uguale e senza titolo", async () => {
    await renderAt("/home");
    await within(column()).findByRole("navigation", { name: "Home views" });
    const homeColumnClass = column().className;
    const grid = column().parentElement!;
    const homeGridClass = grid.className;
    cleanup();
    await renderAt("/mail");
    const nav = await within(column()).findByRole("navigation", { name: "Mail views" });
    expect(nav).toHaveTextContent("Views for this area haven’t been designed yet");
    expect(within(column()).queryByRole("heading")).toBeNull();
    expect(within(nav).queryByRole("link")).toBeNull();
    // Stesso contenitore e stessa colonna di griglia a 240 px: niente collasso.
    expect(column().className).toBe(homeColumnClass);
    expect(column().parentElement!.className).toBe(homeGridClass);
    expect(homeGridClass).toContain("240px");
    expect(screen.getByRole("heading", { level: 1, name: "Mail" })).toHaveClass("text-2xl");
  });

  it("lo stato neutro segue la lingua", async () => {
    act(() => setLanguage("it"));
    await renderAt("/calendar");
    expect(
      await within(column()).findByRole("navigation", { name: "Viste di Calendario" }),
    ).toHaveTextContent("Le viste di quest’area non sono ancora progettate");
  });

  it("Chat ha Channels e Direct messages; Mail nessuna sottovista e nessun titolo", async () => {
    const router = await renderAt("/chat");
    const nav = await within(column()).findByRole("navigation", { name: "Chat views" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["Channels", "Direct messages"]);
    await act(() => router.navigate({ to: "/mail" }));
    await waitFor(() =>
      expect(column().querySelector("[data-context]")).toHaveAttribute("data-context", "mail"),
    );
    expect(within(column()).queryByRole("link")).toBeNull();
    expect(within(column()).queryByRole("heading")).toBeNull();
    expect(await screen.findByRole("heading", { level: 1, name: "Mail" })).toBeInTheDocument();
  });
});

describe("cambio di contesto", () => {
  const surface = () => column().querySelector<HTMLElement>("[data-context]")!;

  it("passando da un progetto alla Home, la colonna entra con la transizione CSS", async () => {
    const router = await renderAt("/p/AUD/tasks");
    await sectionLinks();
    expect(surface()).not.toHaveClass("context-enter");
    await act(() => router.navigate({ to: "/home" }));
    await within(column()).findByRole("navigation", { name: "Home views" });
    expect(surface()).toHaveClass("context-enter");
    fireEvent.animationEnd(surface());
    expect(surface()).not.toHaveClass("context-enter");
  });

  it("dentro lo stesso progetto non c'è transizione", async () => {
    const router = await renderAt("/p/AUD/tasks");
    await sectionLinks();
    await act(() =>
      router.navigate({ to: "/p/$code/$section", params: { code: "AUD", section: "docs" } }),
    );
    expect(surface()).not.toHaveClass("context-enter");
  });

  it("con la View Transitions API la usa al posto della classe CSS", async () => {
    const start = vi.fn((cb: () => void) => ({ finished: Promise.resolve().then(cb) }));
    (document as { startViewTransition?: unknown }).startViewTransition = start;
    const router = await renderAt("/p/AUD/tasks");
    await sectionLinks();
    await act(() => router.navigate({ to: "/home" }));
    await within(column()).findByRole("navigation", { name: "Home views" });
    expect(start).toHaveBeenCalledTimes(1);
    expect(surface()).not.toHaveClass("context-enter");
  });

  it("con movimento ridotto non applica la transizione", async () => {
    setMatchMedia("(prefers-reduced-motion: reduce)", true);
    const start = vi.fn((cb: () => void) => ({ finished: Promise.resolve().then(cb) }));
    const router = await renderAt("/p/AUD/tasks");
    await sectionLinks();
    await act(() => router.navigate({ to: "/home" }));
    await within(column()).findByRole("navigation", { name: "Home views" });
    expect(surface()).not.toHaveClass("context-enter");

    (document as { startViewTransition?: unknown }).startViewTransition = start;
    await act(() => router.navigate({ to: "/p/$code", params: { code: "MKX" } }));
    await within(column()).findByText("Campagne primavera Mix Cucine");
    expect(start).not.toHaveBeenCalled();
    expect(surface()).not.toHaveClass("context-enter");
  });
});

describe("useDetailPanel", () => {
  it("sotto i 1200 px il pannello è sovrapposto", () => {
    setMatchMedia("(min-width: 1200px)", false);
    const { result } = renderHook(() => useDetailPanel());
    expect(result.current.mode).toBe("overlay");
    expect(result.current.isOpen).toBe(false);
  });

  it("da 1200 px in su è affiancato, e segue i cambi di larghezza", () => {
    setMatchMedia("(min-width: 1200px)", true);
    const { result } = renderHook(() => useDetailPanel());
    expect(result.current.mode).toBe("docked");
    act(() => setMatchMedia("(min-width: 1200px)", false));
    expect(result.current.mode).toBe("overlay");
  });

  it("si apre e si chiude; il contenitore riflette la modalità ed Esc chiude", async () => {
    setMatchMedia("(min-width: 1200px)", false);
    function Harness() {
      const panel = useDetailPanel();
      return (
        <>
          <button type="button" onClick={panel.open}>
            open
          </button>
          {panel.isOpen && (
            <DetailPanel mode={panel.mode} label="Details" onClose={panel.close}>
              body
            </DetailPanel>
          )}
        </>
      );
    }
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "open" }));
    const dialog = screen.getByRole("dialog", { name: "Details" });
    expect(dialog).toHaveAttribute("data-mode", "overlay");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Details" })).toBeNull();
  });
});
