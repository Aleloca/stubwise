import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failNext, resetApi, setLatency } from "../../data/api";
import { state } from "../../data/store";
import type { DocGeneration } from "../../data/types";
import { resetViewerGrants } from "../../data/viewer";
import { setLanguage } from "../../i18n";
import { DOCKED_PANEL_QUERY } from "../../layout/useDetailPanel";
import { setMatchMedia } from "../../test/setup";
import { renderRoute } from "../../test/renderRoute";

// Task 3 dei Docs: pannello di generazione, brief, releases, grafo, chat del
// progetto e del repository.

const path = (router: ReturnType<typeof renderRoute>) => router.state.location.pathname;
const spaceOf = (repositoryId: string) =>
  state.docSpaces.find((s) => s.repositoryId === repositoryId)!;

function setGeneration(repositoryId: string, patch: Partial<DocGeneration>) {
  const space = spaceOf(repositoryId);
  space.generation = { ...space.generation, ...patch };
}

/** Il pannello di generazione in fondo all'albero (aperto). */
async function openPanel() {
  const toggle = await screen.findByRole("button", { name: /^Generation:/ });
  if (toggle.getAttribute("aria-expanded") !== "true") await userEvent.click(toggle);
  return screen.getByRole("region", { name: "Generation" });
}

beforeEach(() => {
  setLatency(0);
  resetApi();
  window.localStorage.clear();
  setMatchMedia(DOCKED_PANEL_QUERY, true);
});
afterEach(() => {
  resetViewerGrants();
  act(() => setLanguage("en"));
});

describe("Docs — pannello di generazione", () => {
  it("in pausa sul limite: riga chiusa, aperta coi dettagli, «Resume now» la porta a riuscita", async () => {
    renderRoute("/p/AUD/docs/audin-app", "p-laura");
    const toggle = await screen.findByRole("button", { name: /^Generation:/ });
    expect(toggle).toHaveTextContent("Paused: usage limit");
    const panel = await openPanel();
    expect(panel).toHaveTextContent(/resumes around/i);
    expect(panel).toHaveTextContent("Team account");
    expect(panel).toHaveTextContent("$2.17");
    await userEvent.click(within(panel).getByRole("button", { name: "Resume now" }));
    await waitFor(
      () =>
        expect(screen.getByRole("button", { name: /^Generation:/ })).toHaveTextContent(/Generated/),
      { timeout: 4000 },
    );
  });

  it.each<[DocGeneration["status"], Partial<DocGeneration>, RegExp]>([
    ["never", {}, /Not generated yet/],
    ["queued", {}, /Waiting in line/],
    ["running", { progress: { done: 14, total: 38 } }, /Writing pages… 14 of ~38/],
    ["succeeded", {}, /Generated .* at /],
    ["failed", { reason: "provider_error" }, /Generation failed/],
    ["held", { reason: "monthly_budget" }, /On hold: monthly budget reached/],
    ["paused", { reason: "usage_limit" }, /Paused: usage limit/],
  ])("stato %s in parole", async (status, patch, words) => {
    setGeneration("repo-stw", { status, ...patch });
    // Il prototipo avanza da solo in coda/in corso: qui si legge lo stato e basta.
    setLatency(60_000);
    renderRoute("/p/STW/docs/stubwise", "p-laura");
    setLatency(0);
    const toggle = await screen.findByRole("button", { name: /^Generation:/ }, { timeout: 3000 });
    expect(toggle).toHaveTextContent(words);
  });

  it("fallita: il motivo nella lingua di chi guarda e «Retry»; in italiano anche il motivo", async () => {
    setGeneration("repo-stw", { status: "failed", reason: "provider_error" });
    renderRoute("/p/STW/docs/stubwise", "p-laura");
    const panel = await openPanel();
    expect(panel).toHaveTextContent("The provider returned an error while writing the pages.");
    expect(within(panel).getByRole("button", { name: "Retry" })).toBeInTheDocument();
    act(() => setLanguage("it"));
    expect(await screen.findByText(/Il provider ha restituito un errore/)).toBeInTheDocument();
  });

  it("trattenuta dal budget: il motivo, ma nessun «Resume now» (solo da una pausa)", async () => {
    setGeneration("repo-aud", { status: "held", reason: "monthly_budget" });
    renderRoute("/p/AUD/docs/audin-app", "p-laura");
    const panel = await openPanel();
    expect(panel).toHaveTextContent("The monthly budget for documentation is used up.");
    expect(within(panel).queryByRole("button", { name: "Resume now" })).toBeNull();
  });

  it("senza docs.generate né docs.edit: nessuna azione, i dettagli sì", async () => {
    renderRoute("/p/AUD/docs/audin-app", "p-giulia");
    const panel = await openPanel();
    expect(panel).toHaveTextContent("Team account");
    expect(within(panel).queryByRole("button", { name: "Resume now" })).toBeNull();
    expect(within(panel).queryByRole("link", { name: "New manual page" })).toBeNull();
  });
});

describe("Docs — brief del repository", () => {
  it("sezioni, fatti riservati con la nota, pagine escluse; «Read the brief» dall'indice", async () => {
    const router = renderRoute("/p/AUD/docs/audin-app", "p-laura");
    await screen.findByRole("heading", { level: 1, name: "audin-app" });
    await userEvent.click(screen.getByRole("link", { name: "Read the brief" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Brief" })).toBeInTheDocument();
    expect(path(router)).toBe("/p/AUD/docs/audin-app/brief");
    for (const name of [
      "Identity",
      "Actors",
      "Surfaces",
      "Glossary",
      "Business invariants",
      "User journeys",
      "Existing sources",
      "Confidential facts",
      "Excluded pages",
    ]) {
      expect(screen.getByRole("heading", { level: 2, name })).toBeInTheDocument();
    }
    expect(screen.getByText(/these never reach the public docs/)).toBeInTheDocument();
    expect(screen.getByText("The pricing of the telephony provider")).toBeInTheDocument();
    expect(screen.getByText("Internal admin tools")).toBeInTheDocument();
  });

  it("vuoto: si scrive con la prima generazione", async () => {
    renderRoute("/p/CBV/docs/bellavista-store/brief", "p-roberta");
    expect(
      await screen.findByText("No brief yet: it's written with the first generation"),
    ).toBeInTheDocument();
  });

  it("errore con Retry", async () => {
    failNext("docs.getRepoBrief");
    renderRoute("/p/AUD/docs/audin-app/brief", "p-laura");
    const alert = await screen.findByRole("alert");
    await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Actors" })).toBeInTheDocument();
  });
});

describe("Docs — note di rilascio", () => {
  it("cerca, «Significant only» toglie le minori, le pagine toccate portano alla pagina", async () => {
    const router = renderRoute("/p/STW/docs/stubwise", "p-laura");
    await screen.findByRole("heading", { level: 1, name: "stubwise" });
    const bar = screen.getByRole("navigation", { name: "stubwise docs" });
    await userEvent.click(within(bar).getByRole("link", { name: /Release notes 3/ }));
    expect(await screen.findByRole("heading", { level: 1, name: "Release notes" })).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Release notes" });
    const releases = () => list.querySelectorAll("[data-release]");
    expect(releases()).toHaveLength(3);
    // L'elemento della lista non ha un nome suo: lo dice il suo contenuto.
    expect(within(list).getAllByRole("listitem")[0]).not.toHaveAttribute("aria-label");
    expect(within(list).getByText("Minor")).toBeInTheDocument();
    const toggle = screen.getByRole("switch", { name: "Significant only" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(releases()).toHaveLength(2);
    expect(within(list).queryByText("Minor")).toBeNull();
    await userEvent.type(screen.getByRole("searchbox", { name: "Search release notes" }), "pipeline");
    expect(releases()).toHaveLength(1);
    // Cercando il testo resta Markdown (un paragrafo), con la parola evidenziata dentro.
    const mark = releases()[0]!.querySelector("p mark");
    expect(mark).toHaveTextContent("pipeline");
    await userEvent.click(within(list).getByRole("link", { name: /STW-D\d+ Worker pipeline/ }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Worker pipeline" }),
    ).toBeInTheDocument();
    expect(path(router)).toBe("/p/STW/docs/stubwise/worker-pipeline");
  });

  it("nessun risultato lo dice; uno spazio senza note di rilascio anche", async () => {
    renderRoute("/p/STW/docs/stubwise/releases", "p-laura");
    await userEvent.type(
      await screen.findByRole("searchbox", { name: "Search release notes" }),
      "export",
    );
    expect(await screen.findByText("No release notes match “export”")).toBeInTheDocument();
  });

  it("vuoto", async () => {
    renderRoute("/p/CBV/docs/bellavista-store/releases", "p-roberta");
    expect(
      await screen.findByText("No release notes yet: they're written every night from new commits"),
    ).toBeInTheDocument();
  });
});

describe("Docs — grafo", () => {
  it("pronto: conteggi, comunità coi nomi dell'AI, graph.json, comando copiabile, azioni", async () => {
    const created = URL.createObjectURL;
    const revoked = URL.revokeObjectURL;
    URL.createObjectURL = () => "blob:fake";
    URL.revokeObjectURL = () => {};
    try {
      renderRoute("/p/STW/docs/stubwise/graph", "p-laura");
      expect(await screen.findByRole("heading", { level: 1, name: "Graph" })).toBeInTheDocument();
      expect(screen.getByText("4,812 nodes · 11,930 edges · 37 communities")).toBeInTheDocument();
      expect(screen.getByText("Updated on push")).toBeInTheDocument();
      const communities = screen.getByRole("list", { name: "Communities" });
      expect(within(communities).getAllByRole("listitem").length).toBeGreaterThan(2);
      // Il grafo interattivo: una comunità si apre e si richiude.
      const graph = screen.getByRole("group", { name: /Code graph of stubwise/ });
      const first = within(graph).getAllByRole("button", { expanded: false })[0]!;
      await userEvent.click(first);
      expect(first).toHaveAttribute("aria-expanded", "true");
      await userEvent.click(screen.getByRole("button", { name: "Download graph.json" }));
      expect(await screen.findByText("Downloaded graph.json")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Copy the command" }));
      expect(await navigator.clipboard.readText()).toMatch(/^graphify query "/);
      await userEvent.click(screen.getByRole("button", { name: "Graph actions" }));
      expect(await screen.findByRole("menuitem", { name: "Regenerate" })).toBeInTheDocument();
      expect(screen.getByRole("menuitem", { name: "Rebuild from scratch" })).toBeInTheDocument();
      expect(screen.getByRole("menuitem", { name: "Open setup PR" })).toBeInTheDocument();
    } finally {
      URL.createObjectURL = created;
      URL.revokeObjectURL = revoked;
    }
  });

  it("spento, con repos.manage: «Enable it in the repository» lo accende e lo costruisce (R-H1)", async () => {
    renderRoute("/p/AUD/docs/audin-app/graph", "p-laura");
    await userEvent.click(
      await screen.findByRole("button", { name: "Enable it in the repository" }),
    );
    expect(
      await screen.findByText(/nodes · .* edges · .* communities/, undefined, { timeout: 4000 }),
    ).toBeInTheDocument();
  });

  it("spento, senza repos.manage: chiedi a un maintainer, nessuna azione", async () => {
    renderRoute("/p/AUD/docs/audin-app/graph", "p-giulia");
    expect(await screen.findByText("Ask a maintainer to enable it.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enable it in the repository" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Graph actions" })).toBeNull();
  });

  it.each([
    ["never", /hasn't been built yet/],
    ["queued", /Waiting in line/],
    ["running", /Building the graph/],
  ] as const)("stato %s", async (status, text) => {
    spaceOf("repo-stw").graph = { status };
    setLatency(60_000);
    renderRoute("/p/STW/docs/stubwise/graph", "p-laura");
    setLatency(0);
    expect(await screen.findByText(text, undefined, { timeout: 3000 })).toBeInTheDocument();
  });

  it("fallito: il motivo e «Retry»; senza repos.manage niente Retry", async () => {
    spaceOf("repo-stw").graph = { status: "failed", reason: "graphify_error" };
    renderRoute("/p/STW/docs/stubwise/graph", "p-laura");
    expect(await screen.findByText("graphify exited with an error.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("fallito, senza repos.manage: il motivo, niente Retry né azioni", async () => {
    spaceOf("repo-stw").graph = { status: "failed", reason: "graphify_error" };
    renderRoute("/p/STW/docs/stubwise/graph", "p-giulia");
    expect(await screen.findByText("graphify exited with an error.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Graph actions" })).toBeNull();
    expect(screen.getByText("Ask a maintainer to try again.")).toBeInTheDocument();
  });
});

describe("Docs — barra secondaria", () => {
  it("a 1024, in italiano e con un nome lungo: Brief, Grafo e Cerca vanno in «Altro»; Note di rilascio resta", async () => {
    setMatchMedia(DOCKED_PANEL_QUERY, false);
    act(() => setLanguage("it"));
    const name = "audin-app-mobile-desktop-and-web-clients-of-the-team";
    spaceOf("repo-aud").name = name;
    // happy-dom non impagina: ogni voce è larga quanto il suo testo (8 px a
    // carattere + 16 di margine), la barra 720 px (l'area di lavoro a 1024).
    const proto = HTMLElement.prototype;
    const offset = Object.getOwnPropertyDescriptor(proto, "offsetWidth");
    const client = Object.getOwnPropertyDescriptor(proto, "clientWidth");
    Object.defineProperty(proto, "offsetWidth", {
      configurable: true,
      get(this: HTMLElement) {
        return (this.textContent ?? "").length * 8 + 16;
      },
    });
    Object.defineProperty(proto, "clientWidth", {
      configurable: true,
      get(this: HTMLElement) {
        return this.tagName === "NAV" ? 720 : 0;
      },
    });
    try {
      const router = renderRoute(`/p/AUD/docs/${name}`, "p-laura");
      await screen.findByRole("heading", { level: 1, name });
      const bar = screen.getByRole("navigation", { name: `Documenti di ${name}` });
      expect(within(bar).getByRole("link", { name: /Note di rilascio 2/ })).toBeInTheDocument();
      expect(within(bar).getByRole("link", { name: "Indice" })).toBeInTheDocument();
      expect(within(bar).queryByRole("link", { name: "Brief" })).toBeNull();
      expect(within(bar).queryByRole("link", { name: "Grafo" })).toBeNull();
      await userEvent.click(within(bar).getByRole("button", { name: /Altro/ }));
      const items = (await screen.findAllByRole("menuitem")).map((i) => i.textContent);
      expect(items).toEqual(["Brief", "Grafo", "Cerca⌘K"]);
      await userEvent.click(screen.getByRole("menuitem", { name: "Grafo" }));
      expect(await screen.findByRole("heading", { level: 1, name: "Grafo" })).toBeInTheDocument();
      expect(path(router)).toBe(`/p/AUD/docs/${name}/graph`);
    } finally {
      for (const [key, original] of [
        ["offsetWidth", offset],
        ["clientWidth", client],
      ] as const) {
        if (original) Object.defineProperty(proto, key, original);
        else delete (proto as unknown as Record<string, unknown>)[key];
      }
    }
  });

  it("largo abbastanza: nessun «More», tutte le voci nella barra", async () => {
    renderRoute("/p/AUD/docs/audin-app", "p-laura");
    await screen.findByRole("heading", { level: 1, name: "audin-app" });
    const bar = screen.getByRole("navigation", { name: "audin-app docs" });
    expect(within(bar).queryByRole("button", { name: /More/ })).toBeNull();
    for (const name of ["Index", "Brief", /Release notes 2/, "Graph"]) {
      expect(within(bar).getByRole("link", { name })).toBeInTheDocument();
    }
  });
});

describe("Docs — chat", () => {
  it("chat del progetto: domande suggerite, risposta che cita AUD-D1, «New chat» azzera", async () => {
    renderRoute("/p/AUD/docs", "p-laura");
    const chat = await screen.findByRole("complementary", { name: "Ask the docs" });
    const suggestion = await within(chat).findByRole("button", {
      name: /Scheduled callbacks/,
    });
    await userEvent.click(suggestion);
    const used = await within(chat).findByText("Used:", undefined, { timeout: 3000 });
    const line = used.parentElement!;
    const link = within(line).getByRole("link", { name: /AUD-D1 Scheduled callbacks/ });
    expect(link).toHaveAttribute("href", "#/p/AUD/docs/audin-app/scheduled-callbacks");
    expect(line).toHaveTextContent("from audin-app");
    await userEvent.click(within(chat).getByRole("button", { name: "New chat" }));
    expect(within(chat).queryByText("Used:")).toBeNull();
    expect(within(chat).getByRole("button", { name: /Scheduled callbacks/ })).toBeInTheDocument();
  });

  it("chat del repository: si apre dalla barra, la fonte apre la pagina e la chat resta", async () => {
    const router = renderRoute("/p/AUD/docs/audin-app", "p-laura");
    await screen.findByRole("heading", { level: 1, name: "audin-app" });
    expect(screen.queryByRole("complementary", { name: "Ask the docs" })).toBeNull();
    const bar = screen.getByRole("navigation", { name: "audin-app docs" });
    await userEvent.click(within(bar).getByRole("button", { name: "Chat" }));
    const chat = await screen.findByRole("complementary", { name: "Ask the docs" });
    await userEvent.type(
      within(chat).getByRole("textbox", { name: "Ask the docs" }),
      "how does the export job work{Enter}",
    );
    const link = await within(chat).findByRole(
      "link",
      { name: /AUD-D\d+ Export job/ },
      {
        timeout: 3000,
      },
    );
    // La fonte è un link dell'app (hash): in memoria lo si segue a mano.
    expect(link).toHaveAttribute("href", "#/p/AUD/docs/audin-app/export-job");
    await act(() => router.navigate({ href: link.getAttribute("href")!.slice(1) }));
    await screen.findByRole("heading", { level: 1, name: "Export job" });
    expect(path(router)).toBe("/p/AUD/docs/audin-app/export-job");
    expect(screen.getByRole("complementary", { name: "Ask the docs" })).toHaveTextContent(
      "how does the export job work",
    );
  });

  it("⌘⇧C apre e chiude la chat del repository, che resta ricordata per persona", async () => {
    const user = userEvent.setup();
    renderRoute("/p/AUD/docs/audin-app", "p-laura");
    await screen.findByRole("heading", { level: 1, name: "audin-app" });
    await user.keyboard("{Meta>}{Shift>}c{/Shift}{/Meta}");
    expect(await screen.findByRole("complementary", { name: "Ask the docs" })).toBeInTheDocument();
    expect(window.localStorage.getItem("stubwise.docs.repoChat.p-laura")).toBe("open");
    await user.keyboard("{Meta>}{Shift>}c{/Shift}{/Meta}");
    expect(screen.queryByRole("complementary", { name: "Ask the docs" })).toBeNull();
  });

  it("errore di risposta in riga con «Try again»", async () => {
    renderRoute("/p/AUD/docs", "p-laura");
    const chat = await screen.findByRole("complementary", { name: "Ask the docs" });
    failNext("docs.askDocs");
    await userEvent.click(await within(chat).findByRole("button", { name: /Scheduled callbacks/ }));
    const alert = await within(chat).findByRole("alert");
    await userEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(
      await within(chat).findByText("Used:", undefined, { timeout: 3000 }),
    ).toBeInTheDocument();
  });

  it("la risposta porta l'ora dell'orologio del prototipo", async () => {
    renderRoute("/p/AUD/docs", "p-laura");
    const chat = await screen.findByRole("complementary", { name: "Ask the docs" });
    await userEvent.click(await within(chat).findByRole("button", { name: /Scheduled callbacks/ }));
    await within(chat).findByText("Used:", undefined, { timeout: 3000 });
    expect(within(chat).getByText("12:00")).toBeInTheDocument();
  });

  it("provider sparito a metà sessione: l'avviso al posto della casella, non «Couldn't answer»", async () => {
    renderRoute("/p/AUD/docs", "p-laura");
    const chat = await screen.findByRole("complementary", { name: "Ask the docs" });
    await userEvent.click(await within(chat).findByRole("button", { name: /Scheduled callbacks/ }));
    await within(chat).findByText("Used:", undefined, { timeout: 3000 });
    state.docsChatProvider = null;
    await userEvent.type(
      within(chat).getByRole("textbox", { name: "Ask the docs" }),
      "how does billing work{Enter}",
    );
    expect(
      await within(chat).findByText(/Chat isn't available: it needs a provider with an API key/),
    ).toBeInTheDocument();
    expect(within(chat).queryByRole("alert")).toBeNull();
    expect(within(chat).queryByText("Couldn't answer this time.")).toBeNull();
    expect(within(chat).queryByRole("textbox")).toBeNull();
    // «New chat» non riporta la casella: il provider non c'è.
    await userEvent.click(within(chat).getByRole("button", { name: "New chat" }));
    expect(within(chat).queryByRole("textbox")).toBeNull();
  });

  it("⌥ con ⌘⇧C non apre la chat", async () => {
    const user = userEvent.setup();
    renderRoute("/p/AUD/docs/audin-app", "p-laura");
    await screen.findByRole("heading", { level: 1, name: "audin-app" });
    await user.keyboard("{Meta>}{Shift>}{Alt>}c{/Alt}{/Shift}{/Meta}");
    expect(screen.queryByRole("complementary", { name: "Ask the docs" })).toBeNull();
  });

  it("a 1024: la chat sovrapposta prende il fuoco nella casella; un Esc chiude solo lo strato in cima", async () => {
    setMatchMedia(DOCKED_PANEL_QUERY, false);
    const user = userEvent.setup();
    renderRoute("/p/AUD/docs/audin-app", "p-laura");
    await screen.findByRole("heading", { level: 1, name: "audin-app" });
    await user.click(screen.getByRole("button", { name: "Chat" }));
    const chat = await screen.findByRole("complementary", { name: "Ask the docs" });
    await waitFor(() =>
      expect(within(chat).getByRole("textbox", { name: "Ask the docs" })).toHaveFocus(),
    );
    // Con la chat aperta si apre anche il cassetto delle pagine (⌘\).
    await user.keyboard("{Meta>}\\{/Meta}");
    expect(await screen.findByRole("tree", { name: "Functional" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("complementary", { name: "Ask the docs" })).toBeNull();
    expect(screen.getByRole("tree", { name: "Functional" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tree", { name: "Functional" })).toBeNull();
  });

  it("chat non disponibile: al posto del campo lo dice", async () => {
    state.docsChatProvider = null;
    renderRoute("/p/AUD/docs", "p-laura");
    const chat = await screen.findByRole("complementary", { name: "Ask the docs" });
    expect(
      await within(chat).findByText(/Chat isn't available: it needs a provider with an API key/),
    ).toBeInTheDocument();
    expect(within(chat).queryByRole("textbox")).toBeNull();
  });
});

describe("Docs — albero ridimensionabile", () => {
  it("il bordo dell'albero si trascina e si sposta con ←/→, sempre fra 200 e 360 px", async () => {
    renderRoute("/p/AUD/docs/audin-app", "p-laura");
    const separator = await screen.findByRole("separator", { name: "Resize the page list" });
    const tree = screen.getByRole("complementary", { name: /audin-app/ });
    const width = () => Number(separator.getAttribute("aria-valuenow"));
    expect(width()).toBe(240);
    expect(separator).toHaveAttribute("aria-valuemin", "200");
    expect(separator).toHaveAttribute("aria-valuemax", "360");

    separator.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(width()).toBe(256);
    expect(tree.style.width).toBe("256px");
    for (let i = 0; i < 12; i++) await userEvent.keyboard("{ArrowRight}");
    expect(width()).toBe(360);
    for (let i = 0; i < 12; i++) await userEvent.keyboard("{ArrowLeft}");
    expect(width()).toBe(200);

    // Trascinare: segue il puntatore, e si ferma ai bordi.
    fireEvent.pointerDown(separator, { clientX: 400 });
    fireEvent.pointerMove(window, { clientX: 450 });
    expect(width()).toBe(250);
    fireEvent.pointerMove(window, { clientX: 900 });
    expect(width()).toBe(360);
    fireEvent.pointerMove(window, { clientX: 0 });
    expect(width()).toBe(200);
    fireEvent.pointerUp(window);
    // Lasciato il puntatore, il bordo non segue più.
    fireEvent.pointerMove(window, { clientX: 500 });
    expect(width()).toBe(200);
    expect(tree.style.width).toBe("200px");
  });
});
