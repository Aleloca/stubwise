import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failNext, releases, resetApi, setLatency } from "../../../data/api";
import { setSessionPersonId } from "../../../data/session";
import { state } from "../../../data/store";
import {
  grantInstancePermission,
  resetViewerGrants,
  revokeProjectPermission,
  type LocalInstancePermission,
} from "../../../data/viewer";
import { setLanguage } from "../../../i18n";
import { DOCKED_PANEL_QUERY } from "../../../layout/useDetailPanel";
import { renderRoute } from "../../../test/renderRoute";
import { setMatchMedia } from "../../../test/setup";

// Servers e Repositories dell'Amministrazione (area 9b, Task 12, shape
// admin-instance.md). Roberta è full admin; Marco non ha `monitor.manage`;
// Sara vede pochi progetti (non AUD) e, con la concessione di
// `monitor.manage`, legge SRV-3 «in projects you can't see» (ruling T7 I2);
// Laura ha `repos.manage` in ACQ; Sara non ce l'ha in nessun progetto
// (ruling 20, il caso negativo di Repositories).

const ROBERTA = "p-roberta";
const MARCO = "p-marco";
const SARA = "p-sara";
const LAURA = "p-laura";

const KEY_RE = /sk_[0-9a-f]{40}/;

beforeEach(() => {
  setLatency(0);
  resetApi();
  window.localStorage.clear();
  setMatchMedia(DOCKED_PANEL_QUERY, true);
});
afterEach(async () => {
  cleanup();
  resetViewerGrants();
  resetApi();
  act(() => setLanguage("en"));
});

const give = (personId: string, perm: string) =>
  grantInstancePermission(personId, perm as LocalInstancePermission);
const heading = (name: string | RegExp) => screen.findByRole("heading", { level: 1, name });
const row = (code: string) => document.querySelector<HTMLElement>(`[data-server-row="${code}"]`)!;
const column = () => screen.getByRole("navigation", { name: "Administration sections" });

// --- Servers -------------------------------------------------------------------

describe("Servers dell'istanza", () => {
  it("tutti i server nei gruppi, con la colonna dei progetti e gli orfani in fondo", async () => {
    // Senza la produzione di ACQ, SRV-1 non è più in nessun progetto.
    setSessionPersonId(ROBERTA);
    await releases.deleteEnvironment("env-acq-prod");
    renderRoute("/admin/servers", ROBERTA);
    expect(await heading("Servers")).toBeVisible();
    expect(
      screen.getByText(
        "Every server on the instance, in every project. A server joins a project through one of its environments.",
      ),
    ).toBeVisible();
    await screen.findByRole("list", { name: "Not in any project" });
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings.at(-1)).toBe("Not in any project");
    // Tutti e quattro, ognuno una volta.
    expect(document.querySelectorAll("[data-server-row]")).toHaveLength(4);

    const orphans = screen.getByRole("list", { name: "Not in any project" });
    expect(within(orphans).getAllByRole("listitem")).toHaveLength(1);
    expect(row("SRV-1")).toHaveTextContent("Not in any project yet");
    expect(row("SRV-1").querySelector("[data-server-projects]")).toBeNull();

    // La colonna dei progetti: i codici, col nome nel `title`.
    const projects = row("SRV-3").querySelector<HTMLElement>("[data-server-projects]")!;
    expect(projects).toHaveTextContent("AUD");
    expect(projects.querySelector("[title]")).toHaveAttribute(
      "title",
      `AUD · ${state.projectsById.get("prj-aud")!.name}`,
    );
    expect(row("SRV-2")).toHaveTextContent("STW");

    // La riga porta al dettaglio dell'Amministrazione.
    expect(within(row("SRV-2")).getByRole("link")).toHaveAttribute("href", "/admin/servers/SRV-2");
  });

  it("più di 4 progetti: i primi 4 e «+N», col nome di ognuno nel title", async () => {
    // SRV-4 entra negli ambienti di altri cinque progetti.
    const others = state.projects.filter((p) => p.id !== "prj-aud").slice(0, 5);
    for (const p of others)
      state.environments.push({
        id: `env-${p.code.toLowerCase()}-x`,
        projectId: p.id,
        name: "Extra",
        kind: "test",
        servers: [{ serverCode: "SRV-4", repositoryId: null }],
      } as (typeof state.environments)[number]);
    renderRoute("/admin/servers", ROBERTA);
    await heading("Servers");
    const projects = (await waitFor(() => {
      const el = row("SRV-4").querySelector<HTMLElement>("[data-server-projects]");
      expect(el).not.toBeNull();
      return el!;
    }))!;
    const codes = [...projects.querySelectorAll("[data-project-code]")].map((e) => e.textContent);
    expect(codes).toHaveLength(4);
    const more = projects.querySelector<HTMLElement>("[data-projects-more]")!;
    expect(more).toHaveTextContent("+2");
    // Il title dei nascosti dice codice e nome di ognuno.
    expect(more.getAttribute("title")).toContain(" · ");
  });

  it("Sara con monitor.manage: SRV-3 si apre, AUD non compare mai (R-G5)", async () => {
    give(SARA, "monitor.manage");
    const user = userEvent.setup();
    const router = renderRoute("/admin/servers", SARA);
    await heading("Servers");
    await waitFor(() => expect(row("SRV-3")).toBeTruthy());
    expect(row("SRV-3").querySelector("[data-server-projects]")).toHaveTextContent("—");
    expect(row("SRV-3")).toHaveTextContent("In projects you can't see");
    expect(document.body.textContent).not.toContain("AUD");
    await user.click(within(row("SRV-3")).getByRole("link"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/admin/servers/SRV-3"));
    expect(await heading(/aud-app-01/)).toBeVisible();
    expect(screen.getAllByText("In projects you can't see").length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain("AUD");
  });

  it("il dettaglio da Amministrazione è quello dell'8b, con «← Servers» verso l'Amministrazione", async () => {
    renderRoute("/admin/servers/SRV-2", ROBERTA);
    expect(await heading(/db-stw-01/)).toBeVisible();
    expect(screen.getByRole("navigation", { name: "Parts of SRV-2" })).toBeVisible();
    expect(screen.getByRole("link", { name: "← Servers" })).toHaveAttribute(
      "href",
      "/admin/servers",
    );
    // La colonna resta quella dell'Amministrazione, con Servers attiva.
    expect(within(column()).getByRole("link", { name: "Servers" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    // Un server inesistente: come uno nascosto.
    cleanup();
    renderRoute("/admin/servers/SRV-99", ROBERTA);
    expect(await heading("This server doesn't exist, or you can't see it.")).toBeVisible();
  });

  it("un orfano nel dettaglio: niente ambienti, e Claude non ci può lavorare finché non sta in un progetto", async () => {
    setSessionPersonId(ROBERTA);
    await releases.deleteEnvironment("env-acq-prod");
    renderRoute("/admin/servers/SRV-1", ROBERTA);
    expect(await heading(/acq-prod-01/)).toBeVisible();
    expect(screen.getAllByText("Not in any project yet").length).toBeGreaterThan(0);
    expect(screen.queryByText("Staging only: no alerts, no analysis")).toBeNull();
  });

  it("senza monitor.manage (Marco) la voce non c'è, e gli indirizzi sono «not found»", async () => {
    give(MARCO, "settings.manage");
    renderRoute("/admin/storage", MARCO);
    await heading("Storage");
    expect(within(column()).queryByRole("link", { name: "Servers" })).toBeNull();
    cleanup();
    renderRoute("/admin/servers", MARCO);
    expect(await heading("Page not found")).toBeVisible();
    cleanup();
    renderRoute("/admin/servers/SRV-1", MARCO);
    expect(await heading("Page not found")).toBeVisible();
  });
});

// --- 30d e 90d -----------------------------------------------------------------

describe("I grafici a 30 e 90 giorni", () => {
  it("dall'Amministrazione: cinque intervalli, tasti 1–5, e la frase calcolata dall'intervallo", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/admin/servers/SRV-2", ROBERTA);
    await heading(/db-stw-01/);
    const range = await screen.findByRole("group", { name: "Time range" });
    expect(within(range).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "1h",
      "24h",
      "7d",
      "30d",
      "90d",
    ]);
    expect(screen.queryByText(/^Each point averages/)).toBeNull();
    await user.click(within(range).getByRole("button", { name: "30d" }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ range: "30d" }));
    expect(await screen.findByText("Each point averages about 2 hours.")).toBeVisible();
    // La frase-riassunto dice il giorno del picco, non un'ora inventata dalla media.
    const cpu = document.querySelector<HTMLElement>('[data-chart="cpu"]')!;
    await waitFor(() => expect(cpu).toHaveTextContent(/Average \d+% · peak \d+% on [A-Z][a-z]{2} \d+/));
    // Il tasto 5 sceglie 90d.
    (document.activeElement as HTMLElement | null)?.blur();
    await user.keyboard("5");
    await waitFor(() => expect(router.state.location.search).toMatchObject({ range: "90d" }));
    expect(await screen.findByText("Each point averages about 7 hours.")).toBeVisible();
    await user.keyboard("1");
    await waitFor(() => expect(router.state.location.search).toMatchObject({ range: "1h" }));
    expect(screen.queryByText(/^Each point averages/)).toBeNull();
  });

  it("anche dalla sezione di progetto, e l'indirizzo tiene 90d", async () => {
    renderRoute("/p/ACQ/servers/SRV-1?range=90d", MARCO);
    await heading(/acq-prod-01/);
    const range = await screen.findByRole("group", { name: "Time range" });
    expect(within(range).getByRole("button", { name: "90d" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(await screen.findByText("Each point averages about 7 hours.")).toBeVisible();
  });

  it("a 30d l'episodio sul bordo destro non copre l'etichetta della soglia alta: scende sotto", async () => {
    renderRoute("/admin/servers/SRV-2?range=30d", ROBERTA);
    await heading(/db-stw-01/);
    const cpu = await screen.findByRole("group", { name: /^CPU/ });
    await waitFor(() => expect(cpu.querySelector("[data-band-label]")).not.toBeNull());
    // La soglia della CPU di SRV-2 è alta (etichetta in alto a destra).
    expect(state.servers.find((s) => s.code === "SRV-2")!.thresholds.cpuPct).toBeGreaterThan(80);
    expect(cpu.querySelector("[data-band-label]")).toHaveAttribute("data-side", "bottom");
  });

  it("in italiano la frase si traduce", async () => {
    act(() => setLanguage("it"));
    renderRoute("/admin/servers/SRV-2?range=30d", ROBERTA);
    await heading(/db-stw-01/);
    expect(await screen.findByText("Ogni punto è la media di circa 2 ore.")).toBeVisible();
  });
});

// --- New server ----------------------------------------------------------------

describe("New server dall'Amministrazione", () => {
  it("senza ambiente: la chiave una volta sola, poi il dettaglio e la riga orfana", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/admin/servers", ROBERTA);
    await heading("Servers");
    await user.click(await screen.findByRole("button", { name: "New server" }));
    const dialog = await screen.findByRole("dialog", { name: "New server" });
    // Il dialogo non offre ambienti (decisione del maintainer del 30 ott 2026).
    expect(within(dialog).queryByRole("combobox")).toBeNull();
    expect(within(dialog).queryByLabelText(/Environment/)).toBeNull();
    expect(
      within(dialog).getByText(
        "It starts without a project. To bring it into a project, link it to an environment in that project's Releases → Environments.",
      ),
    ).toBeVisible();
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "edge-01");
    await user.click(within(dialog).getByRole("button", { name: "Create server" }));

    const panel = await screen.findByRole("dialog", { name: "SRV-5 is ready for its agent" });
    expect(within(panel).getByText("This key is shown only now.")).toBeVisible();
    const key = (within(panel).getByRole("textbox", { name: "Agent key" }) as HTMLInputElement)
      .value;
    expect(key).toMatch(KEY_RE);
    // Nato orfano: nessun ambiente e nessun progetto principale (environmentId: null).
    const created = state.servers.find((s) => s.code === "SRV-5")!;
    expect(created.primaryProjectId).toBeNull();
    expect(state.environments.some((e) => e.servers.some((s) => s.serverCode === "SRV-5"))).toBe(
      false,
    );
    expect(state.changelog.at(-1)).toMatchObject({
      kind: "server.created",
      params: { scope: "orphan" },
    });

    await user.click(within(panel).getByRole("button", { name: "Copy the key" }));
    await user.click(within(panel).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/admin/servers/SRV-5"));
    expect(await heading(/edge-01/)).toBeVisible();
    expect(screen.getAllByText("Never connected").length).toBeGreaterThan(0);
    expect(document.body.innerHTML).not.toContain(key);

    await user.click(screen.getByRole("link", { name: "← Servers" }));
    const orphans = await screen.findByRole("list", { name: "Not in any project" });
    expect(within(orphans).getByText("edge-01")).toBeVisible();
    expect(row("SRV-5")).toHaveTextContent("Not in any project yet");
    expect(document.body.innerHTML).not.toContain(key);
  });

  it("un nome vuoto non crea niente, e l'errore viene dal livello dati", async () => {
    const user = userEvent.setup();
    renderRoute("/admin/servers", ROBERTA);
    await user.click(await screen.findByRole("button", { name: "New server" }));
    const dialog = await screen.findByRole("dialog", { name: "New server" });
    expect(within(dialog).getByRole("button", { name: "Create server" })).toBeDisabled();
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "   ");
    expect(within(dialog).getByRole("button", { name: "Create server" })).toBeDisabled();
    expect(state.servers).toHaveLength(4);
  });
});

// --- Repositories --------------------------------------------------------------

/** La pagina (la sezione dell'h1): i gruppi sono le sue regioni, non quelle dell'app. */
const repoPage = () =>
  screen.getByRole("heading", { level: 1, name: "Repositories" }).closest("section")!;
const groups = () =>
  within(repoPage())
    .queryAllByRole("region")
    .map((r) => r.getAttribute("aria-label"));

describe("Repositories dell'istanza", () => {
  it("Laura: un gruppo per progetto, ogni riga porta alle impostazioni dei repository", async () => {
    renderRoute("/admin/repositories", LAURA);
    expect(await heading("Repositories")).toBeVisible();
    expect(
      screen.getByText(
        "The repositories of the projects you can see. To change one, open it in its project's settings.",
      ),
    ).toBeVisible();
    const aud = state.projects.find((p) => p.code === "AUD")!;
    const group = await screen.findByRole("region", { name: `AUD · ${aud.name}` });
    const repos = state.repositories.filter((r) => r.projectId === aud.id);
    expect(repos).toHaveLength(3);
    expect(within(group).getByText("3 repositories")).toBeVisible();
    const sorted = [...repos].sort((a, b) => a.name.localeCompare(b.name));
    const links = within(group).getAllByRole("link");
    expect(links).toHaveLength(3);
    links.forEach((link, i) => {
      expect(link).toHaveAttribute("href", "/p/AUD/settings/repositories");
      expect(link).toHaveTextContent(sorted[i]!.name);
      // Il nome dell'account git, o «No git account».
      const account = state.instance.gitAccounts.find((g) => g.id === sorted[i]!.gitAccountId);
      expect(link).toHaveTextContent(account ? account.name : "No git account");
    });
    // Fino a 10 repository, niente campo di ricerca.
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  it("un repository senza account git dice «No git account»; il link apre le impostazioni", async () => {
    const user = userEvent.setup();
    state.repositories.find((r) => r.id === "repo-aud")!.gitAccountId = null;
    const router = renderRoute("/admin/repositories", ROBERTA);
    await heading("Repositories");
    const link = await screen.findByRole("link", { name: /^audin-app, AUD:/ });
    expect(link).toHaveTextContent("No git account");
    await user.click(link);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/p/AUD/settings/repositories"),
    );
  });

  it("Roberta: con più di 10 repository c'è «Find a repository», per nome o progetto", async () => {
    const user = userEvent.setup();
    // Il seme ne ha 6: altri sei in ACQ, così il campo compare.
    for (let i = 1; i <= 6; i++)
      state.repositories.push({
        id: `repo-acq-extra-${i}`,
        projectId: "prj-acq",
        name: `servizio-${i}`,
        fullName: `colline/servizio-${i}`,
        gitAccountId: null,
      });
    expect(state.repositories.length).toBeGreaterThan(10);
    renderRoute("/admin/repositories", ROBERTA);
    await heading("Repositories");
    const find = await screen.findByRole("searchbox", { name: "Find a repository" });
    const stw = state.projects.find((p) => p.code === "STW")!;
    const acq = state.projects.find((p) => p.code === "ACQ")!;
    // Per nome del repository…
    await user.type(find, "stubwise");
    await waitFor(() => expect(groups()).toEqual([`STW · ${stw.name}`]));
    // …o per progetto.
    await user.clear(find);
    await user.type(find, "acq");
    await waitFor(() => expect(groups()).toEqual([`ACQ · ${acq.name}`]));
    await user.clear(find);
    await user.type(find, "zzzz");
    expect(await screen.findByText("No repository matches “zzzz”.")).toBeVisible();
  });

  it("Laura senza repos.view in AUD: AUD non compare, nemmeno contato", async () => {
    revokeProjectPermission(LAURA, "prj-aud", "repos.view" as never);
    renderRoute("/admin/repositories", LAURA);
    await heading("Repositories");
    await waitFor(() => expect(repoPage().querySelector("[aria-busy='true']")).toBeNull());
    expect(groups().some((g) => g?.startsWith("AUD"))).toBe(false);
    expect(repoPage().textContent).not.toContain("AUD");
  });

  it("Sara, senza repos.manage in nessun progetto: la voce non c'è e l'indirizzo è «not found» (ruling 20)", async () => {
    renderRoute("/admin/repositories", SARA);
    expect(await heading("Page not found")).toBeVisible();
    cleanup();
    give(SARA, "monitor.manage");
    renderRoute("/admin/servers", SARA);
    await heading("Servers");
    expect(within(column()).queryByRole("link", { name: "Repositories" })).toBeNull();
  });

  it("l'errore di lettura con Retry", async () => {
    failNext("instance.listAllRepositories");
    const user = userEvent.setup();
    renderRoute("/admin/repositories", ROBERTA);
    expect(await screen.findByText("Couldn't load the repositories.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(groups().length).toBeGreaterThan(0));
  });
});
