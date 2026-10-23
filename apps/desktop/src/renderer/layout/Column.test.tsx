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
import { setLanguage } from "../i18n";
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

  it("il nome più lungo del seed è troncato con ellissi e intero nel title", async () => {
    const longest = [...PROJECTS].sort((a, b) => b.name.length - a.name.length)[0]!;
    expect(longest.name.length).toBeGreaterThanOrEqual(34);
    await renderAt(`/p/${longest.code}/overview`);
    const name = await within(column()).findByText(longest.name);
    expect(name).toHaveAttribute("title", longest.name);
    expect(name).toHaveStyle({
      textOverflow: "ellipsis",
      overflow: "hidden",
      whiteSpace: "nowrap",
    });
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
    expect(await within(column()).findByRole("heading", { level: 2, name: "Home" })).toBeVisible();
    const nav = within(column()).getByRole("navigation", { name: "Views" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["Assigned to me", "Delegated", "Following"]);
    await waitFor(() => expect(links[0]).toHaveAttribute("aria-current", "page"));
    expect(screen.queryByRole("navigation", { name: "Project sections" })).toBeNull();
  });

  it("una sottovista resta sulla stessa route e diventa corrente", async () => {
    const router = await renderAt("/home");
    const nav = await within(column()).findByRole("navigation", { name: "Views" });
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

  it("Chat ha Channels e Direct messages; Mail solo il titolo", async () => {
    const router = await renderAt("/chat");
    const nav = await within(column()).findByRole("navigation", { name: "Views" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["Channels", "Direct messages"]);
    await act(() => router.navigate({ to: "/mail" }));
    expect(await within(column()).findByRole("heading", { level: 2, name: "Mail" })).toBeVisible();
    expect(within(column()).queryByRole("navigation", { name: "Views" })).toBeNull();
  });
});

describe("cambio di contesto", () => {
  const surface = () => column().querySelector<HTMLElement>("[data-context]")!;

  it("passando da un progetto alla Home, la colonna entra con la transizione CSS", async () => {
    const router = await renderAt("/p/AUD/tasks");
    await sectionLinks();
    expect(surface()).not.toHaveClass("context-enter");
    await act(() => router.navigate({ to: "/home" }));
    await within(column()).findByRole("heading", { level: 2, name: "Home" });
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
    await within(column()).findByRole("heading", { level: 2, name: "Home" });
    expect(start).toHaveBeenCalledTimes(1);
    expect(surface()).not.toHaveClass("context-enter");
  });

  it("con movimento ridotto non applica la transizione", async () => {
    setMatchMedia("(prefers-reduced-motion: reduce)", true);
    const start = vi.fn((cb: () => void) => ({ finished: Promise.resolve().then(cb) }));
    const router = await renderAt("/p/AUD/tasks");
    await sectionLinks();
    await act(() => router.navigate({ to: "/home" }));
    await within(column()).findByRole("heading", { level: 2, name: "Home" });
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
