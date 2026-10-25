import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failNext, resetApi, setLatency } from "../../data/api";
import { state } from "../../data/store";
import { revokeProjectPermission, resetViewerGrants } from "../../data/viewer";
import { DOCKED_PANEL_QUERY } from "../../layout/useDetailPanel";
import { setMatchMedia } from "../../test/setup";
import { renderRoute } from "../../test/renderRoute";

const path = (router: ReturnType<typeof renderRoute>) => router.state.location.pathname;
const views = (id: string) => state.docPages.find((p) => p.id === id)!.views;

async function switchPersona(name: RegExp) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Profile and settings" }));
  const menu = await screen.findByRole("dialog", { name: "Profile and settings" });
  await user.click(within(menu).getByRole("radio", { name }));
}

/** Apre una pagina e aspetta il suo titolo. */
async function openPage(url: string, title: string, personId = "p-laura") {
  const router = renderRoute(url, personId);
  await screen.findByRole("heading", { level: 1, name: title });
  return router;
}

beforeEach(() => {
  setLatency(0);
  resetApi();
  // 1440: l'albero sta accanto alla lettura (sotto i 1200 è un cassetto).
  setMatchMedia(DOCKED_PANEL_QUERY, true);
});
afterEach(() => resetViewerGrants());

describe("Docs — pagina iniziale", () => {
  it("identità, inizia da qui, spazi con lo stato in parole, decisioni e novità", async () => {
    renderRoute("/p/AUD/docs", "p-laura");
    expect(await screen.findByRole("heading", { level: 1, name: "Docs" })).toBeInTheDocument();
    const spaces = await screen.findByRole("list", { name: "Spaces" });
    const row = within(spaces).getByRole("link", { name: /audin-app/ });
    expect(row).toHaveTextContent("Paused: usage limit");
    expect(row).toHaveTextContent(/\d+ pages/);
    expect(screen.getByRole("list", { name: "Start here" })).toHaveTextContent("AUD-D7");
    expect(screen.getByRole("link", { name: "See the whole register" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "What's new" })).toHaveTextContent("2.4.0");
  });

  it("uno spazio porta all'indice del repository", async () => {
    const router = renderRoute("/p/AUD/docs", "p-laura");
    const spaces = await screen.findByRole("list", { name: "Spaces" });
    await userEvent.click(within(spaces).getByRole("link", { name: /audin-app/ }));
    expect(await screen.findByRole("heading", { level: 1, name: "audin-app" })).toBeInTheDocument();
    expect(path(router)).toBe("/p/AUD/docs/audin-app");
    expect(await screen.findByRole("list", { name: "Recently updated" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Most read" })).toHaveTextContent(
      "Scheduled callbacks",
    );
  });

  it("vuoto: nessun repository con documentazione", async () => {
    state.docSpaces = state.docSpaces.filter((s) => s.projectId !== "prj-cbv");
    renderRoute("/p/CBV/docs", "p-roberta");
    expect(await screen.findByText("No repository has documentation yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add a repository" })).toBeInTheDocument();
  });

  it("senza docs.view: lo dice, senza titoli né conteggi", async () => {
    revokeProjectPermission("p-giulia", "prj-aud", "docs.view" as never);
    renderRoute("/p/AUD/docs", "p-giulia");
    expect(await screen.findByText("You can't see this project's docs")).toBeInTheDocument();
    expect(screen.queryByText(/audin-app/)).toBeNull();
  });

  it("errore di caricamento con Retry", async () => {
    failNext("docs.getProjectDocsHome");
    renderRoute("/p/AUD/docs", "p-laura");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load the docs.");
    await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("list", { name: "Spaces" })).toBeInTheDocument();
  });

  it("un progetto senza il modulo Docs: la colonna non ha la sezione, l'indirizzo lo dice", async () => {
    const router = renderRoute("/p/MKX/docs", "p-roberta");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Docs isn't turned on for MKX" }),
    ).toBeInTheDocument();
    expect(path(router)).toBe("/p/MKX/docs");
    await userEvent.click(screen.getByRole("link", { name: "Turn it on in Settings" }));
    await screen.findByRole("heading", { level: 1, name: "Settings" });
    expect(path(router)).toBe("/p/MKX/settings");
    const sections = screen.getByRole("navigation", { name: /sections/i });
    expect(within(sections).queryByRole("link", { name: "Docs" })).toBeNull();
  });

  it("modulo spento, senza project.settings.manage: nessun «Turn it on»", async () => {
    revokeProjectPermission("p-giulia", "prj-mkx", "project.settings.manage" as never);
    renderRoute("/p/MKX/docs/whatever", "p-giulia");
    await screen.findByRole("heading", { level: 1, name: "Docs isn't turned on for MKX" });
    expect(screen.queryByRole("link", { name: "Turn it on in Settings" })).toBeNull();
  });
});

describe("Docs — spazio e albero", () => {
  it("dall'albero alla pagina: il treeitem porta selezione, livello ed espansione", async () => {
    const router = renderRoute("/p/AUD/docs/audin-app", "p-laura");
    const tree = await screen.findByRole("tree", { name: "Functional" });
    const leaf = within(tree).getByRole("treeitem", { name: "Scheduled callbacks" });
    expect(leaf).toHaveAttribute("aria-selected", "false");
    expect(leaf).toHaveAttribute("aria-level", "3");
    await userEvent.click(within(leaf).getByText("Scheduled callbacks"));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Scheduled callbacks" }),
    ).toBeInTheDocument();
    expect(path(router)).toBe("/p/AUD/docs/audin-app/scheduled-callbacks");
    expect(screen.getByRole("button", { name: /AUD-D1/ })).toBeInTheDocument();
    // La pagina corrente è il treeitem selezionato, ed è lei a prendere il fuoco con Tab.
    const current = within(tree).getByRole("treeitem", { name: "Scheduled callbacks" });
    expect(current).toHaveAttribute("aria-selected", "true");
    expect(current).toHaveAttribute("tabindex", "0");
    // Una cartella si chiude (clic sulla riga): i suoi figli spariscono.
    const folder = within(tree).getByRole("treeitem", { name: "Dialer" });
    expect(folder).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(within(folder).getByText("Dialer"));
    expect(folder).toHaveAttribute("aria-expanded", "false");
    expect(within(tree).queryByRole("treeitem", { name: "Scheduled callbacks" })).toBeNull();
  });

  it("da tastiera: frecce sui treeitem, ← chiude, → apre, Enter apre la pagina", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/p/AUD/docs/audin-app", "p-laura");
    const tree = await screen.findByRole("tree", { name: "Functional" });
    const guide = within(tree).getByRole("treeitem", { name: "Guide" });
    expect(guide).toHaveAttribute("tabindex", "0");
    guide.focus();
    await user.keyboard("{ArrowDown}");
    const billing = within(tree).getByRole("treeitem", { name: "Billing" });
    expect(billing).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(billing).toHaveAttribute("aria-expanded", "false");
    await user.keyboard("{ArrowRight}");
    expect(billing).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{ArrowDown}");
    const leaf = within(tree).getByRole("treeitem", { name: "Invoices and billing emails" });
    expect(leaf).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(billing).toHaveFocus();
    await user.keyboard("{ArrowDown}{Enter}");
    await screen.findByRole("heading", { level: 1, name: "Invoices and billing emails" });
    expect(path(router)).toBe("/p/AUD/docs/audin-app/invoices-and-billing-emails");
  });

  it("comprimi tutto / espandi tutto, e una categoria si chiude", async () => {
    renderRoute("/p/AUD/docs/audin-app", "p-laura");
    await screen.findByRole("tree", { name: "Functional" });
    await userEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(screen.queryByRole("treeitem", { name: "Scheduled callbacks" })).toBeNull();
    // Anche i gruppi: restano le quattro intestazioni.
    expect(screen.queryByRole("tree")).toBeNull();
    expect(screen.getByRole("button", { name: /^Functional/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await userEvent.click(screen.getByRole("button", { name: "Expand all" }));
    expect(screen.getByRole("treeitem", { name: "Scheduled callbacks" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^Functional/ }));
    expect(screen.queryByRole("tree", { name: "Functional" })).toBeNull();
  });

  it("scarica una categoria come .zip finto, con l'avviso", async () => {
    const created = URL.createObjectURL;
    const revoked = URL.revokeObjectURL;
    URL.createObjectURL = () => "blob:fake";
    URL.revokeObjectURL = () => {};
    try {
      renderRoute("/p/AUD/docs/audin-app", "p-laura");
      await screen.findByRole("tree", { name: "Functional" });
      await userEvent.click(screen.getByRole("button", { name: "More for Functional" }));
      await userEvent.click(await screen.findByRole("menuitem", { name: "Download as .zip" }));
      expect(await screen.findByText("Downloaded Functional.zip (4 pages)")).toBeInTheDocument();
    } finally {
      URL.createObjectURL = created;
      URL.revokeObjectURL = revoked;
    }
  });

  it("caricamento: l'albero e la lettura mostrano lo scheletro", async () => {
    // Il progetto è già letto (dall'Overview): lento è solo lo spazio.
    const router = renderRoute("/p/AUD/overview", "p-laura");
    await screen.findByRole("heading", { level: 1, name: "Overview" });
    setLatency(10_000);
    await act(() =>
      router.navigate({ to: "/p/$code/docs/$repo", params: { code: "AUD", repo: "audin-app" } }),
    );
    expect(await screen.findByTestId("doc-tree-skeleton")).toBeInTheDocument();
    expect(screen.getAllByText("Loading…").length).toBeGreaterThan(0);
  });

  it("con più repository, la colonna del progetto apre una sottovoce per spazio", async () => {
    const aud = state.docSpaces.find((s) => s.repositoryId === "repo-aud")!;
    state.docSpaces.push({
      ...structuredClone(aud),
      repositoryId: "repo-aud-web",
      name: "audin-web",
    });
    const router = renderRoute("/p/AUD/docs", "p-laura");
    const list = await screen.findByRole("list", { name: "Docs spaces of AUD" });
    expect(
      within(list)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual([expect.stringContaining("audin-app"), expect.stringContaining("audin-web")]);
    await userEvent.click(within(list).getByRole("link", { name: /audin-web/ }));
    await screen.findByRole("heading", { level: 1, name: "audin-web" });
    expect(path(router)).toBe("/p/AUD/docs/audin-web");
    // Uno spazio senza pagine: chi può genera.
    expect(screen.getByRole("button", { name: "Generate documentation" })).toBeInTheDocument();
  });

  it("un repository che non c'è: pagina non trovata, con il ritorno all'indice", async () => {
    renderRoute("/p/AUD/docs/nope", "p-laura");
    expect(
      await screen.findByRole("heading", { name: "This page doesn't exist or you can't see it" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to the index" })).toBeInTheDocument();
  });
});

describe("Docs — pagina", () => {
  it("una visita conta una volta sola, anche quando la pagina si ricarica", async () => {
    const before = views("doc-aud-callbacks");
    await openPage("/p/AUD/docs/audin-app/scheduled-callbacks", "Scheduled callbacks");
    await waitFor(() => expect(views("doc-aud-callbacks")).toBe(before + 1));
    // La visita ricarica l'area Docs: la pagina si rilegge ma non conta di nuovo.
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(views("doc-aud-callbacks")).toBe(before + 1);
  });

  it("meta, collegamenti e niente azioni su una pagina generata", async () => {
    await openPage("/p/AUD/docs/audin-app/scheduled-callbacks", "Scheduled callbacks");
    expect(screen.getByText("src/callbacks")).toBeInTheDocument();
    expect(screen.getByText(/Generated at commit/)).toBeInTheDocument();
    const linked = screen.getByRole("region", { name: "Linked pages" });
    expect(within(linked).getByRole("link", { name: /Reminder job/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("pagina vecchia: l'avviso dice quanti commit e, aperto, li elenca", async () => {
    await openPage(
      "/p/AUD/docs/audin-app/exporting-the-call-history",
      "Exporting the call history",
    );
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("2 commits since this page was updated");
    await userEvent.click(within(note).getByRole("button", { name: /2 commits/ }));
    expect(
      within(note).getByText("feat(export): background export for long periods"),
    ).toBeInTheDocument();
  });

  it("finita una generazione, la pagina aperta perde l'avviso di pagina vecchia", async () => {
    const space = state.docSpaces.find((s) => s.repositoryId === "repo-aud")!;
    space.generation = { ...space.generation, status: "running", reason: null };
    await openPage(
      "/p/AUD/docs/audin-app/exporting-the-call-history",
      "Exporting the call history",
    );
    expect(screen.getByRole("note")).toBeInTheDocument();
    // La generazione finisce (come farebbe il worker): pagine rifatte, stato riuscito.
    space.generation = { ...space.generation, status: "succeeded" };
    for (const p of state.docPages) if (p.repositoryId === "repo-aud") p.staleCommits = [];
    await waitFor(() => expect(screen.queryByRole("note")).toBeNull(), { timeout: 3000 });
  });

  it("una pagina che non c'è: identica a una che non si vede", async () => {
    renderRoute("/p/AUD/docs/audin-app/nope", "p-laura");
    expect(
      await screen.findByRole("heading", { name: "This page doesn't exist or you can't see it" }),
    ).toBeInTheDocument();
  });

  it("errore di caricamento della pagina con Retry", async () => {
    failNext("docs.getDocPage");
    renderRoute("/p/AUD/docs/audin-app/scheduled-callbacks", "p-laura");
    const alert = await screen.findByRole("alert");
    await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Scheduled callbacks" }),
    ).toBeInTheDocument();
  });
});

describe("Docs — pagine manuali", () => {
  it("con docs.edit: crea, modifica ed elimina (con conferma)", async () => {
    const router = renderRoute("/p/AUD/docs/audin-app", "p-laura");
    await screen.findByRole("heading", { level: 1, name: "audin-app" });
    await userEvent.click(screen.getByRole("link", { name: "New manual page" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "New manual page" }),
    ).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: "Title" }), "Onboarding checklist");
    expect(screen.getByText("Will be at /docs/audin-app/onboarding-checklist")).toBeInTheDocument();
    await userEvent.type(
      screen.getByRole("textbox", { name: "Body" }),
      "Read the **brief** first.",
    );
    await userEvent.click(screen.getByRole("button", { name: "Save page" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Onboarding checklist" }),
    ).toBeInTheDocument();
    expect(path(router)).toBe("/p/AUD/docs/audin-app/onboarding-checklist");
    expect(state.docPages.some((p) => p.title === "Onboarding checklist")).toBe(true);

    await userEvent.click(screen.getByRole("link", { name: "Edit" }));
    const title = await screen.findByRole("textbox", { name: "Title" });
    await userEvent.clear(title);
    await userEvent.type(title, "Onboarding");
    await userEvent.click(screen.getByRole("button", { name: "Save page" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Onboarding" }),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "More actions" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete “Onboarding”?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await screen.findByRole("heading", { level: 1, name: "audin-app" });
    expect(path(router)).toBe("/p/AUD/docs/audin-app");
    expect(state.docPages.some((p) => p.title === "Onboarding")).toBe(false);
  });

  it("slug già usato: l'errore sta sul campo e niente è scritto", async () => {
    await openPage("/p/AUD/docs/audin-app/new", "New manual page");
    const before = state.docPages.length;
    await userEvent.type(screen.getByRole("textbox", { name: "Title" }), "Release checklist");
    await userEvent.type(screen.getByRole("textbox", { name: "Body" }), "Again.");
    await userEvent.click(screen.getByRole("button", { name: "Save page" }));
    expect(await screen.findByText("Another page already uses this slug")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /^Slug/ })).toHaveAttribute("aria-invalid", "true");
    expect(state.docPages.length).toBe(before);
  });

  it("Cancel con modifiche chiede di buttarle", async () => {
    const router = await openPage("/p/AUD/docs/audin-app/new", "New manual page");
    await userEvent.type(screen.getByRole("textbox", { name: "Title" }), "Draft");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const ask = await screen.findByRole("group", { name: "Discard your changes?" });
    await userEvent.click(within(ask).getByRole("button", { name: "Discard" }));
    await screen.findByRole("heading", { level: 1, name: "audin-app" });
    expect(path(router)).toBe("/p/AUD/docs/audin-app");
  });

  it("senza docs.edit le azioni non ci sono", async () => {
    await openPage("/p/AUD/docs/audin-app/release-checklist", "Release checklist", "p-giulia");
    expect(screen.queryByRole("link", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
    await userEvent.click(screen.getByRole("link", { name: "Index" }));
    await screen.findByRole("heading", { level: 1, name: "audin-app" });
    expect(screen.queryByRole("link", { name: "New manual page" })).toBeNull();
  });

  it("cambio di persona sulla pagina: le azioni seguono i permessi nuovi", async () => {
    await openPage("/p/AUD/docs/audin-app/release-checklist", "Release checklist");
    expect(screen.getByRole("link", { name: "Edit" })).toBeInTheDocument();
    await switchPersona(/Giulia Ferri/);
    await screen.findByRole("heading", { level: 1, name: "Release checklist" });
    await waitFor(() => expect(screen.queryByRole("link", { name: "Edit" })).toBeNull());
  });

  it("cambio di persona verso chi non vede il progetto: la pagina non c'è più", async () => {
    await openPage("/p/AUD/docs/audin-app/release-checklist", "Release checklist");
    await switchPersona(/Sara Montanari/);
    expect(await screen.findByRole("heading", { name: "Project not found" })).toBeInTheDocument();
    expect(screen.queryByText("Release checklist")).toBeNull();
  });
});

describe("Docs — fix round 1", () => {
  it("cambio di persona con una bozza nel form: la bozza sparisce, nessuna domanda", async () => {
    await openPage("/p/AUD/docs/audin-app/new", "New manual page");
    await userEvent.type(screen.getByRole("textbox", { name: "Title" }), "Half written");
    await switchPersona(/Roberta Fontana/);
    await screen.findByRole("heading", { level: 1, name: "New manual page" });
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue(""));
    expect(screen.queryByRole("group", { name: "Discard your changes?" })).toBeNull();
  });

  it("uno slug riservato (anche dal titolo) ha il suo messaggio, non «già usato»", async () => {
    await openPage("/p/AUD/docs/audin-app/new", "New manual page");
    const before = state.docPages.length;
    await userEvent.type(screen.getByRole("textbox", { name: "Title" }), "New");
    await userEvent.click(screen.getByRole("button", { name: "Save page" }));
    expect(
      await screen.findByText("“new” is reserved for a view of the space: choose another slug"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Another page already uses this slug")).toBeNull();
    expect(state.docPages.length).toBe(before);
  });

  it("modifica: cambiare lo slug sposta la pagina al nuovo indirizzo", async () => {
    const router = await openPage(
      "/p/AUD/docs/audin-app/release-checklist/edit",
      "Edit “Release checklist”",
    );
    const slug = screen.getByRole("textbox", { name: /^Slug/ });
    await userEvent.clear(slug);
    await userEvent.type(slug, "release-steps");
    await userEvent.click(screen.getByRole("button", { name: "Save page" }));
    await screen.findByRole("heading", { level: 1, name: "Release checklist" });
    expect(path(router)).toBe("/p/AUD/docs/audin-app/release-steps");
    expect(state.docPages.find((p) => p.id === "doc-aud-release-checklist")!.slug).toBe(
      "release-steps",
    );
  });

  it("Write / Preview: le schede controllano il loro pannello, l'etichetta segue il campo", async () => {
    await openPage("/p/AUD/docs/audin-app/new", "New manual page");
    const write = screen.getByRole("tab", { name: "Write" });
    expect(document.getElementById(write.getAttribute("aria-controls")!)).toContainElement(
      screen.getByRole("textbox", { name: "Body" }),
    );
    await userEvent.click(screen.getByRole("tab", { name: "Preview" }));
    const preview = screen.getByRole("tab", { name: "Preview" });
    const panel = screen.getByRole("tabpanel", { name: "Preview" });
    expect(panel.id).toBe(preview.getAttribute("aria-controls"));
    // Nessuna etichetta resta a puntare a un campo che non c'è.
    expect(document.querySelector("label[for]:not([for=''])")).not.toBeNull();
    for (const label of document.querySelectorAll<HTMLLabelElement>("label[for]")) {
      expect(document.getElementById(label.htmlFor)).not.toBeNull();
    }
  });

  it("J/K nell'indice muovono fra le righe degli elenchi", async () => {
    const user = userEvent.setup();
    renderRoute("/p/AUD/docs/audin-app", "p-laura");
    const start = await screen.findByRole("list", { name: "Start here" });
    await user.keyboard("j");
    expect(within(start).getByRole("link", { name: /Audin 2.0 at a glance/ })).toHaveFocus();
    await user.keyboard("j");
    const categories = screen.getByRole("list", { name: "Categories" });
    expect(within(categories).getAllByRole("button")[0]).toHaveFocus();
    await user.keyboard("k");
    expect(within(start).getByRole("link", { name: /Audin 2.0 at a glance/ })).toHaveFocus();
  });

  it("⌘C col fuoco sul codice copia il link della pagina", async () => {
    const user = userEvent.setup();
    await openPage("/p/AUD/docs/audin-app/scheduled-callbacks", "Scheduled callbacks");
    screen.getByRole("button", { name: /AUD-D1/ }).focus();
    await user.keyboard("{Meta>}c{/Meta}");
    expect(await navigator.clipboard.readText()).toBe("#/p/AUD/docs/audin-app/scheduled-callbacks");
    expect(await screen.findByText("Link to AUD-D1 copied")).toBeInTheDocument();
  });

  it("l'indice dice quando l'elenco delle categorie non si carica, con Retry", async () => {
    failNext("docs.listDocTree");
    renderRoute("/p/AUD/docs/audin-app", "p-laura");
    await screen.findByRole("heading", { level: 1, name: "audin-app" });
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.some((a) => a.textContent?.includes("Couldn't load the pages."))).toBe(true);
    await userEvent.click(within(alerts[0]!).getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("list", { name: "Categories" })).toBeInTheDocument();
  });

  it("1024: il cassetto prende il fuoco, Esc lo chiude e lo rende a «Pages», un clic fuori pure", async () => {
    setMatchMedia(DOCKED_PANEL_QUERY, false);
    const user = userEvent.setup();
    renderRoute("/p/AUD/docs/audin-app", "p-laura");
    await screen.findByRole("heading", { level: 1, name: "audin-app" });
    const pages = screen.getByRole("button", { name: "Pages" });
    await user.click(pages);
    const drawer = await screen.findByRole("complementary", { name: "Pages of audin-app" });
    await waitFor(() => expect(drawer).toContainElement(document.activeElement as HTMLElement));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("complementary", { name: "Pages of audin-app" })).toBeNull();
    expect(pages).toHaveFocus();

    // Con un dialogo sopra, Esc è del dialogo: il cassetto resta.
    await user.click(pages);
    await screen.findByRole("complementary", { name: "Pages of audin-app" });
    const modal = document.createElement("div");
    modal.setAttribute("aria-modal", "true");
    document.body.append(modal);
    await user.keyboard("{Escape}");
    expect(screen.getByRole("complementary", { name: "Pages of audin-app" })).toBeInTheDocument();
    modal.remove();

    await user.click(screen.getByRole("heading", { level: 1, name: "audin-app" }));
    expect(screen.queryByRole("complementary", { name: "Pages of audin-app" })).toBeNull();
  });
});
