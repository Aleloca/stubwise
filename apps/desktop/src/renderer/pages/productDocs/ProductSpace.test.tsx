import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../data/api";
import { resetApi, setLatency } from "../../data/api";
import { emitProductPage } from "../../data/productDocs/events";
import { state } from "../../data/store";
import { can, resetViewerGrants, viewerFor } from "../../data/viewer";
import { setLanguage } from "../../i18n";
import { DOCKED_PANEL_QUERY } from "../../layout/useDetailPanel";
import { setMatchMedia } from "../../test/setup";
import { renderRoute } from "../../test/renderRoute";

// Lo spazio Prodotto nei Docs (area 11a, Task 7; shape product-space.md):
// la pagina iniziale con PRODUCT sopra CODE, il modulo Docs spento e
// riacceso (sul posto e da General), lo spazio vuoto per chi scrive e per
// chi legge, la riga di sola lettura, e la pagina che non c'è — identica
// per un codice inventato, una pagina eliminata, il modulo spento e un
// progetto che chi guarda non vede (R-G5).

const LAURA = "p-laura";
const SARA = "p-sara";
const GIULIA = "p-giulia";
// Un membro di MKX che non gestisce le sue impostazioni (lo verifica il test).
const ELENA = "p-elena";

const page = (code: string) => state.productPages.find((p) => p.code === code)!;
const groupHeadings = () =>
  screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent?.toLowerCase());

async function switchPersona(name: RegExp) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Profile and settings" }));
  const menu = await screen.findByRole("dialog", { name: "Profile and settings" });
  await user.click(within(menu).getByRole("radio", { name }));
}

beforeEach(() => {
  setLatency(0);
  resetApi();
  window.localStorage.clear();
  setMatchMedia(DOCKED_PANEL_QUERY, true);
});
afterEach(() => {
  resetViewerGrants();
  vi.restoreAllMocks();
  act(() => setLanguage("en"));
});

describe("pagina iniziale dei Docs: PRODUCT e CODE", () => {
  it("ACQ: PRODUCT sopra CODE, col numero di pagine; la prima pagina radice apre START HERE", async () => {
    renderRoute("/p/ACQ/docs", LAURA);
    const product = await screen.findByRole("list", { name: "Product" });
    const code = screen.getByRole("list", { name: "Code" });
    const headings = groupHeadings();
    expect(headings.indexOf("product")).toBeGreaterThan(-1);
    expect(headings.indexOf("product")).toBeLessThan(headings.indexOf("code"));
    expect(headings.indexOf("start here")).toBeLessThan(headings.indexOf("product"));
    const row = within(product).getByRole("link", { name: /Product/ });
    expect(row).toHaveTextContent("9 pages");
    expect(row).toHaveTextContent(/Updated .+ by /);
    expect(row).toHaveAttribute("href", "/p/ACQ/docs/product");
    expect(within(code).getByRole("link", { name: /portale-utenti/ })).toBeInTheDocument();
    // START HERE: per prima la prima pagina radice del Prodotto, con «Product».
    const start = await screen.findByRole("list", { name: "Start here" });
    const first = within(start).getAllByRole("listitem")[0]!;
    expect(first).toHaveTextContent(page("ACQ-D3").code);
    expect(first).toHaveTextContent("Overview");
    expect(first).toHaveTextContent("Product");
  });

  it("VRD (nessun repository): solo PRODUCT, nessun CODE e nessun invito ad aggiungere un repository", async () => {
    renderRoute("/p/VRD/docs", LAURA);
    const product = await screen.findByRole("list", { name: "Product" });
    expect(within(product).getByText("No pages yet")).toBeInTheDocument();
    expect(within(product).getByRole("button", { name: "Start from a blank page" })).toBeEnabled();
    expect(screen.queryByRole("list", { name: "Code" })).toBeNull();
    expect(groupHeadings()).not.toContain("code");
    expect(screen.queryByText(/no repository has documentation yet/i)).toBeNull();
    expect(screen.queryByRole("link", { name: /add a repository/i })).toBeNull();
    // Niente pagine e niente repository: START HERE non c'è.
    expect(screen.queryByRole("list", { name: "Start here" })).toBeNull();
    // La chat del progetto c'è anche con le sole pagine di prodotto.
    expect(screen.getByPlaceholderText("Ask about VRD…")).toBeInTheDocument();
  });

  it("una lettura senza `product` (fixture, apposta): la pagina si disegna come prima", async () => {
    const real = api.docs.getProjectDocsHome;
    vi.spyOn(api.docs, "getProjectDocsHome").mockImplementation(async (projectId) => {
      const home = await real(projectId);
      if (!home) return home;
      const rest = { ...home };
      delete rest.product;
      return rest;
    });
    renderRoute("/p/ACQ/docs", LAURA);
    expect(await screen.findByRole("list", { name: "Code" })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Product" })).toBeNull();
    expect(groupHeadings()).not.toContain("product");
  });

  it("in italiano: «Prodotto» e «Codice», la riga composta in lettura", async () => {
    act(() => setLanguage("it"));
    renderRoute("/p/ACQ/docs", LAURA);
    const product = await screen.findByRole("list", { name: "Prodotto" });
    expect(screen.getByRole("list", { name: "Codice" })).toBeInTheDocument();
    expect(within(product).getByRole("link", { name: /Prodotto/ })).toHaveTextContent(
      /9 pagine.*Aggiornata il .+ da /,
    );
  });
});

describe("il modulo Docs spento", () => {
  it("Giulia (gestisce MKX): «Turn on Docs» lo accende sul posto, e c'è lo spazio vuoto", async () => {
    const user = userEvent.setup();
    renderRoute("/p/MKX/docs", GIULIA);
    await screen.findByRole("heading", { level: 1, name: "Docs isn't turned on for MKX" });
    expect(
      screen.getByText(
        "This project doesn't use the documentation yet. Turn it on to write product pages and read the repositories' docs.",
      ),
    ).toBeInTheDocument();
    // La stringa vecchia e il suo link alle impostazioni non ci sono più (P27).
    expect(screen.queryByRole("link", { name: /turn it on in settings/i })).toBeNull();
    const setDocs = vi.spyOn(api.projectSettings, "setDocsModule");
    await user.dblClick(screen.getByRole("button", { name: "Turn on Docs" }));
    const start = await screen.findByRole("button", { name: "Start from a blank page" });
    expect(state.projectsById.get("prj-mkx")!.modules).toContain("docs");
    // Un doppio clic accende una volta sola: una sola scrittura. (Il registro
    // non lo direbbe: il livello dati non scrive una seconda accensione.)
    expect(setDocs).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(start).toHaveFocus());
    const sections = screen.getByRole("navigation", { name: /sections/i });
    expect(within(sections).getByRole("link", { name: "Docs" })).toBeInTheDocument();
  });

  it("un membro di MKX senza project.settings.manage (Elena): la frase e «Who?», nessun bottone", async () => {
    expect(can(viewerFor(ELENA), "project.settings.manage", "prj-mkx")).toBe(false);
    expect(state.projectsById.get("prj-mkx")!.memberIds).toContain(ELENA);
    renderRoute("/p/MKX/docs", ELENA);
    await screen.findByRole("heading", { level: 1, name: "Docs isn't turned on for MKX" });
    expect(
      screen.getByText(/It can be turned on by people who manage MKX's settings\./),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Who can change the project settings/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /turn on docs/i })).toBeNull();
  });

  it("General: un doppio clic sull'interruttore fa una scrittura sola", async () => {
    const user = userEvent.setup();
    const setDocs = vi.spyOn(api.projectSettings, "setDocsModule");
    renderRoute("/p/MKX/settings/general", GIULIA);
    const toggle = await screen.findByRole("switch", { name: "Docs" });
    await user.dblClick(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    expect(setDocs).toHaveBeenCalledTimes(1);
    expect(setDocs).toHaveBeenCalledWith("prj-mkx", true);
  });

  it("General: Giulia spegne i Docs di MKX, la colonna perde «Docs»; riacceso le pagine ci sono", async () => {
    const user = userEvent.setup();
    renderRoute("/p/MKX/settings/general", GIULIA);
    const toggle = await screen.findByRole("switch", { name: "Docs" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("Pages are kept. Turning Docs back on shows them again.")).toBeInTheDocument();
    const sections = () => screen.getByRole("navigation", { name: /sections/i });
    expect(within(sections()).queryByRole("link", { name: "Docs" })).toBeNull();

    await user.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    await within(sections()).findByRole("link", { name: "Docs" });
    expect(screen.queryByText("Pages are kept. Turning Docs back on shows them again.")).toBeNull();
    const created = await api.productDocs.createProductPage("prj-mkx", { title: "Spring campaign" });

    await user.click(toggle);
    await waitFor(() => expect(within(sections()).queryByRole("link", { name: "Docs" })).toBeNull());
    expect(screen.getByText("Pages are kept. Turning Docs back on shows them again.")).toBeInTheDocument();

    await user.click(toggle);
    await within(sections()).findByRole("link", { name: "Docs" });
    expect(state.productPages.some((p) => p.id === created.id)).toBe(true);
    cleanup();
    renderRoute(`/p/MKX/docs/product/${created.code}`, GIULIA);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Spring campaign" }),
    ).toBeInTheDocument();
  });
});

describe("lo spazio Prodotto", () => {
  it("VRD vuoto, Laura: «Start from a blank page» crea «Untitled» e la apre", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/p/VRD/docs/product", LAURA);
    await screen.findByRole("heading", { level: 1, name: "Product" });
    expect(screen.getByRole("heading", { name: "No product pages yet" })).toBeInTheDocument();
    await user.dblClick(screen.getByRole("button", { name: "Start from a blank page" }));
    const title = await screen.findByRole("heading", { level: 1, name: "Untitled" });
    const pages = state.productPages.filter((p) => p.projectId === "prj-vrd");
    // Un doppio clic crea una pagina sola.
    expect(pages).toHaveLength(1);
    expect(router.state.location.pathname).toBe(`/p/VRD/docs/product/${pages[0]!.code}`);
    // Il fuoco va al titolo della pagina nuova, mai sul body (il titolo
    // modificabile arriva col Task 8, P17).
    await waitFor(() => expect(title).toHaveFocus());
  });

  it("in italiano la pagina nuova si chiama «Senza titolo»", async () => {
    act(() => setLanguage("it"));
    const user = userEvent.setup();
    renderRoute("/p/VRD/docs/product", LAURA);
    await user.click(await screen.findByRole("button", { name: "Inizia da una pagina vuota" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Senza titolo" })).toBeInTheDocument();
  });

  it("VRD vuoto, Sara: «No product pages yet», nessun bottone, nessun «Who?»", async () => {
    renderRoute("/p/VRD/docs/product", SARA);
    await screen.findByRole("heading", { name: "No product pages yet" });
    expect(screen.getByText("When someone writes the first page, it shows up here.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /start from a blank page/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /new page/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^who/i })).toBeNull();
  });

  it("l'indice di ACQ: aggiornate di recente e tutte le pagine, «New page» per chi scrive", async () => {
    renderRoute("/p/ACQ/docs/product", LAURA);
    await screen.findByRole("heading", { level: 1, name: "Product" });
    expect(screen.getByText(/^9 pages · Updated .+ by /)).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Recently updated" })).getAllByRole("listitem")).toHaveLength(5);
    const all = screen.getByRole("list", { name: "All pages" });
    expect(within(all).getAllByRole("listitem")).toHaveLength(9);
    expect(within(all).getByRole("link", { name: /Sign-in/ })).toHaveAttribute(
      "href",
      `/p/ACQ/docs/product/${page("ACQ-D5").code}`,
    );
    expect(screen.getAllByRole("button", { name: /new page/i }).length).toBeGreaterThan(0);
  });

  it("Sara su «Sign-in»: la riga di sola lettura con «Who?» (editDocs), en e it", async () => {
    renderRoute("/p/ACQ/docs/product/ACQ-D5", SARA);
    await screen.findByRole("heading", { level: 1, name: "Sign-in" });
    const line = screen.getByText(
      "You can read this page. Editing is for people with Edit docs in ACQ",
    ).parentElement!;
    expect(within(line).getByRole("button", { name: /^Who can edit the docs/ })).toHaveAttribute(
      "data-who-can",
      "editDocs",
    );
    cleanup();
    act(() => setLanguage("it"));
    renderRoute("/p/ACQ/docs/product/ACQ-D5", SARA);
    await screen.findByRole("heading", { level: 1, name: "Sign-in" });
    expect(
      screen.getByText("Puoi leggere questa pagina. Scrivere è di chi ha Modifica Docs in ACQ"),
    ).toBeInTheDocument();
  });

  it("Laura non ha la riga di sola lettura; la testata dice codice · Product, la meta chi ha aggiornato", async () => {
    renderRoute("/p/ACQ/docs/product/ACQ-D5", LAURA);
    const h1 = await screen.findByRole("heading", { level: 1, name: "Sign-in" });
    expect(screen.queryByText(/you can read this page/i)).toBeNull();
    const header = h1.closest("header")!;
    expect(within(header).getByRole("button", { name: /ACQ-D5/ })).toBeInTheDocument();
    expect(header).toHaveTextContent("Product");
    expect(header).toHaveTextContent(/Updated .+ by .+·\s*Created by Laura Costa/);
    // Le briciole nella barra: Features › Sign-in.
    const crumbs = screen.getByRole("navigation", { name: "Where this page is" });
    expect(crumbs).toHaveTextContent("Features");
    expect(crumbs).toHaveTextContent("Sign-in");
  });
});

describe("la pagina che non c'è (R-G5, Review Focus 5)", () => {
  const NOT_FOUND = "This page doesn't exist or you can't see it";

  it("un codice inventato", async () => {
    renderRoute("/p/ACQ/docs/product/ACQ-D999", LAURA);
    expect(await screen.findByRole("heading", { level: 1, name: NOT_FOUND })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to the index" })).toHaveAttribute(
      "href",
      "/p/ACQ/docs/product",
    );
  });

  it("eliminata da un altro mentre è aperta: la stessa frase, la barra senza gesti", async () => {
    renderRoute("/p/ACQ/docs/product/ACQ-D7", LAURA);
    await screen.findByRole("heading", { level: 1, name: "Meter reading" });
    const id = page("ACQ-D7").id;
    act(() => {
      // Marco la elimina: il livello dati la toglie e avvisa chi è iscritto.
      state.productPages = state.productPages.filter((p) => p.id !== id);
      emitProductPage(id, "gone");
    });
    expect(await screen.findByRole("heading", { level: 1, name: NOT_FOUND })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /more for this page/i })).toBeNull();
    expect(screen.queryByRole("navigation", { name: /where this page is/i })).toBeNull();
  });

  it("il modulo spento: la stessa frase", async () => {
    state.projectsById.get("prj-acq")!.modules = state.projectsById
      .get("prj-acq")!
      .modules.filter((m) => m !== "docs");
    renderRoute("/p/ACQ/docs/product/ACQ-D5", LAURA);
    expect(await screen.findByRole("heading", { level: 1, name: NOT_FOUND })).toBeInTheDocument();
    expect(screen.queryByText(/sign-in/i)).toBeNull();
  });

  it("«vedi come» su chi non vede ACQ: la stessa frase, nessun titolo", async () => {
    renderRoute("/p/ACQ/docs/product/ACQ-D5", LAURA);
    await screen.findByRole("heading", { level: 1, name: "Sign-in" });
    await switchPersona(/Giulia/);
    expect(await screen.findByRole("heading", { level: 1, name: NOT_FOUND })).toBeInTheDocument();
    expect(screen.queryByText(/sign-in/i)).toBeNull();
    expect(screen.queryByText(/acq-d5/i)).toBeNull();
  });
});

describe("⌘K porta alla pagina (il link del Task 6)", () => {
  it("dall'indice di ACQ, «bill» → Bills: la rotta apre la pagina", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/p/ACQ/docs/product", LAURA);
    await screen.findByRole("heading", { level: 1, name: "Product" });
    await user.keyboard("{Control>}k{/Control}");
    const dialog = await screen.findByRole("dialog", { name: "Search and commands" });
    await user.type(within(dialog).getByRole("combobox"), "bill");
    const group = await within(dialog).findByRole("group", { name: "Product pages" });
    await user.click(within(group).getByRole("option", { name: `${page("ACQ-D6").code} Bills` }));
    expect(await screen.findByRole("heading", { level: 1, name: "Bills" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/p/ACQ/docs/product/ACQ-D6");
  });
});
