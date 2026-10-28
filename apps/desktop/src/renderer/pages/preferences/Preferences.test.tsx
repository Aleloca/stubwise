import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { alerts, failNext, resetApi, setLatency } from "../../data/api";
import { INITIAL_PINNED_CODES } from "../../data/seed/projects";
import { setSessionPersonId } from "../../data/session";
import { state, visibleProjectIds } from "../../data/store";
import { grantProjectRole } from "../../data/viewer";
import { renderRoute } from "../../test/renderRoute";

// Preferenze → Notifiche (Task 7, shape alerts.md). Persone del seme: Laura
// (Project Lead, fissa AUD e altri sei), Marco (Developer: ha «Claude
// corrected your PR» obbligatorio), Roberta (admin: vede tutti i ~50
// progetti), Sara (Contributor, ne vede meno).

const LAURA = "p-laura";
const MARCO = "p-marco";
const ROBERTA = "p-roberta";
const SARA = "p-sara";
const AUD = "prj-aud";
const ACQ = "prj-acq";
const PAGE = "/preferences/notifications";

beforeEach(() => {
  setLatency(0);
  resetApi();
  window.localStorage.clear();
});

const headers = () => [...document.querySelectorAll<HTMLElement>("[data-group-header]")];
const headerOf = (code: string) =>
  document.querySelector<HTMLElement>(`[data-group-header="${code}"]`);
const groupOf = (code: string) =>
  document.querySelector<HTMLElement>(`[data-project-group="${code}"]`)!;
const rowOf = (code: string, type: string) =>
  groupOf(code).querySelector<HTMLElement>(`[data-alert-row="${type}"]`);
const sw = (name: string) => screen.getByRole("switch", { name });

async function ready() {
  await waitFor(() => expect(headers().length).toBeGreaterThan(0));
}

describe("cornice", () => {
  it("/preferences porta a Notifiche; la colonna ha le quattro sezioni, le altre sono segnaposto", async () => {
    const router = renderRoute("/preferences", LAURA);
    expect(await screen.findByRole("heading", { level: 1, name: "Notifications" })).toBeVisible();
    expect(router.state.location.pathname).toBe(PAGE);
    const nav = screen.getByRole("navigation", { name: "Preferences sections" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual([
      "Notifications",
      "Account",
      "Security",
      "Claude Code",
    ]);
    expect(links[0]).toHaveAttribute("aria-current", "page");
    // Le decisioni non sono avvisi: la pagina lo dice in testa e in fondo.
    expect(screen.getByText(/Decisions — plans to approve, Claude's questions/)).toBeVisible();
    expect(screen.getByRole("heading", { name: "Not set here" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Home → Decide" })).toHaveAttribute("href", "/home");

    await userEvent.click(links[1]!);
    expect(await screen.findByRole("heading", { level: 1, name: "Account" })).toBeVisible();
    expect(screen.getByText("Arrives with a later area.")).toBeVisible();
  });
});

describe("gruppi per progetto", () => {
  it("i fissati prima, nell'ordine del binario, aperti; gli altri chiusi con la sintesi", async () => {
    renderRoute(PAGE, LAURA);
    await ready();
    const pinned = INITIAL_PINNED_CODES[LAURA]!;
    expect(
      headers()
        .slice(0, pinned.length)
        .map((h) => h.dataset.groupHeader),
    ).toEqual([...pinned]);
    expect(screen.getByRole("heading", { name: "Pinned" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Other projects" })).toBeVisible();
    expect(headerOf("AUD")).toHaveAttribute("aria-expanded", "true");
    const other = headers()[pinned.length]!;
    expect(other).toHaveAttribute("aria-expanded", "false");
    // La sintesi in parole, anche da chiuso.
    expect(other.textContent).toMatch(/\d+ on|Everything off/);
    // La riga si legge come una frase; l'obbligo sotto il nome.
    const failed = rowOf("AUD", "release.failed")!;
    expect(failed).toHaveTextContent("Release failed");
    expect(failed).toHaveTextContent("When a release of AUD fails after the merge");
    expect(failed).toHaveTextContent("Always when you did the merge");
    // Mai il `kind` né un permesso a schermo.
    expect(document.body.textContent).not.toMatch(/release\.failed|repos\.view|pr_opened/);
  });

  it("R-G5: un progetto che non vede non ha gruppo, nemmeno vuoto", async () => {
    renderRoute(PAGE, SARA);
    await ready();
    const visible = visibleProjectIds(SARA);
    expect(headers()).toHaveLength(visible.size);
    const hidden = state.projects.find((p) => !visible.has(p.id))!;
    expect(headerOf(hidden.code)).toBeNull();
  });

  it("Review Focus 5: 50 progetti, nessuno perso, fissati prima, frecce fra le intestazioni", async () => {
    renderRoute(PAGE, ROBERTA);
    await ready();
    expect(state.projects.length).toBeGreaterThanOrEqual(45);
    const codes = headers().map((h) => h.dataset.groupHeader);
    expect(codes).toHaveLength(state.projects.length);
    expect(new Set(codes).size).toBe(codes.length);
    const pinned = INITIAL_PINNED_CODES[ROBERTA]!;
    expect(codes.slice(0, pinned.length)).toEqual([...pinned]);
    const rest = state.projects
      .filter((p) => !pinned.includes(p.code))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => p.code);
    expect(codes.slice(pinned.length)).toEqual(rest);

    const user = userEvent.setup();
    headers()[0]!.focus();
    await user.keyboard("{ArrowDown}");
    expect(headers()[1]).toHaveFocus();
    // Le frecce saltano le righe dei gruppi aperti: si va da intestazione a intestazione.
    for (let i = 1; i < pinned.length; i++) await user.keyboard("{ArrowDown}");
    const first = headers()[pinned.length]!;
    expect(first).toHaveFocus();
    expect(first).toHaveAttribute("aria-expanded", "false");
    await user.keyboard("{ArrowRight}");
    expect(first).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{ArrowLeft}");
    expect(first).toHaveAttribute("aria-expanded", "false");
    await user.keyboard("{ArrowUp}");
    expect(headers()[pinned.length - 1]).toHaveFocus();
    await user.keyboard("/");
    expect(screen.getByRole("searchbox", { name: "Find a project" })).toHaveFocus();
  });

  it("la ricerca filtra per codice o nome e apre i trovati; nessun risultato con «Clear»", async () => {
    renderRoute(PAGE, LAURA);
    await ready();
    const user = userEvent.setup();
    const search = screen.getByRole("searchbox", { name: "Find a project" });
    const other = headers()[INITIAL_PINNED_CODES[LAURA]!.length]!.dataset.groupHeader!;
    await user.type(search, other.toLowerCase());
    expect(headerOf(other)).toHaveAttribute("aria-expanded", "true");
    await user.clear(search);
    await user.type(search, "zz");
    expect(screen.getByText("No project matches “zz”")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(headers().length).toBeGreaterThan(1);
  });

  it("`?project=` apre quel gruppo e gli dà il fuoco", async () => {
    const code = state.projects.find(
      (p) => visibleProjectIds(LAURA).has(p.id) && !INITIAL_PINNED_CODES[LAURA]!.includes(p.code),
    )!.code;
    renderRoute(`${PAGE}?project=${code}`, LAURA);
    await waitFor(() => expect(headerOf(code)).toHaveFocus());
    expect(headerOf(code)).toHaveAttribute("aria-expanded", "true");
  });

  it("aperto e chiuso si ricordano per persona", async () => {
    renderRoute(PAGE, LAURA);
    await ready();
    await userEvent.click(headerOf("AUD")!);
    expect(headerOf("AUD")).toHaveAttribute("aria-expanded", "false");
    expect(JSON.parse(window.localStorage.getItem(`stubwise.alerts.open.${LAURA}`)!)).toEqual({
      [AUD]: false,
    });
  });
});

describe("righe nei quattro stati", () => {
  it("obbligatoria: «Always for you», nessun interruttore", async () => {
    renderRoute(PAGE, MARCO);
    await ready();
    const row = rowOf("AUD", "pr.corrected")!;
    expect(row).toHaveTextContent("Claude corrected your PR");
    expect(row).toHaveTextContent("Always for you");
    expect(row).toHaveTextContent("When Claude pushes a correction to a PR you opened");
    expect(within(row).queryByRole("switch")).toBeNull();
  });

  it("sospesa: perso il permesso, la riga dice cosa non vede più e non si tocca", async () => {
    setSessionPersonId(MARCO);
    await alerts.setSubscription(AUD, "pr.analysis_issues", { app: true });
    grantProjectRole(MARCO, AUD, "contributor"); // niente repos.view
    renderRoute(PAGE, MARCO);
    await ready();
    const row = rowOf("AUD", "pr.analysis_issues")!;
    expect(row).toHaveTextContent("Paused · you can no longer see AUD's repositories");
    expect(row).toHaveTextContent("It comes back if you get access again.");
    expect(within(row).queryByRole("switch")).toBeNull();
    // La sintesi la conta.
    expect(headerOf("AUD")!.textContent).toMatch(/1 paused/);
  });

  it("accesa/spenta: ogni interruttore salva subito; Telefono richiede App; l'etichetta del prototipo", async () => {
    renderRoute(PAGE, LAURA);
    await ready();
    expect(
      screen.getByRole("button", {
        name: "Prototype: phone alerts are saved, but nothing is sent.",
      }),
    ).toBeVisible();
    const app = sw("New PR in AUD, App");
    const phone = sw("New PR in AUD, Phone");
    expect(app).toHaveAttribute("aria-checked", "false");
    expect(phone).toHaveAttribute("aria-disabled", "true");
    expect(phone).toHaveAttribute("title", "Turn on App first");
    await userEvent.click(phone);
    expect(phone).toHaveAttribute("aria-checked", "false");

    await userEvent.click(app);
    expect(app).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(phone).not.toHaveAttribute("aria-disabled"));
    await userEvent.click(phone);
    await waitFor(async () => {
      setSessionPersonId(LAURA);
      const row = (await alerts.subscriptionRows())
        .find((p) => p.projectId === AUD)!
        .rows.find((r) => r.type === "pr.opened")!;
      expect(row).toMatchObject({ app: true, phone: true, state: "on" });
    });
    // Spegnere App spegne anche Telefono.
    await userEvent.click(app);
    await waitFor(() =>
      expect(sw("New PR in AUD, Phone")).toHaveAttribute("aria-checked", "false"),
    );
    expect(sw("New PR in AUD, Phone")).toHaveAttribute("aria-disabled", "true");
  });

  it("un salvataggio che fallisce rimette l'interruttore com'era e lo dice, con «Retry»", async () => {
    renderRoute(PAGE, LAURA);
    await ready();
    failNext("alerts.setSubscription");
    await userEvent.click(sw("New PR in AUD, App"));
    expect(await screen.findByText("Couldn't save “New PR” for AUD.")).toBeVisible();
    await waitFor(() => expect(sw("New PR in AUD, App")).toHaveAttribute("aria-checked", "false"));
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(sw("New PR in AUD, App")).toHaveAttribute("aria-checked", "true"));
  });
});

describe("azioni in blocco", () => {
  it("«Turn everything off» non tocca le righe obbligatorie; «Undo» ripristina riga per riga", async () => {
    renderRoute(PAGE, MARCO);
    await ready();
    const before = [...groupOf("AUD").querySelectorAll<HTMLElement>("[role=switch]")].map((s) =>
      s.getAttribute("aria-checked"),
    );
    expect(before).toContain("true");
    await userEvent.click(screen.getByRole("button", { name: "Alert actions for AUD" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Turn everything off in AUD" }));
    expect(
      await screen.findByText(
        "Everything off in AUD. Alerts you already got stay; you'll still get the ones meant only for you.",
      ),
    ).toBeVisible();
    await waitFor(() =>
      expect(
        [...groupOf("AUD").querySelectorAll("[role=switch]")].every(
          (s) => s.getAttribute("aria-checked") === "false",
        ),
      ).toBe(true),
    );
    expect(rowOf("AUD", "pr.corrected")).toHaveTextContent("Always for you");
    expect(headerOf("AUD")!.textContent).toMatch(/Everything off · 1 always on/);

    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(
        [...groupOf("AUD").querySelectorAll<HTMLElement>("[role=switch]")].map((s) =>
          s.getAttribute("aria-checked"),
        ),
      ).toEqual(before),
    );
  });

  it("«Same as another project…»: il dialogo elenca le differenze, copia, «Undo» ripristina riga per riga", async () => {
    setSessionPersonId(LAURA);
    await alerts.setSubscription(ACQ, "pr.opened", { app: true, phone: true });
    await alerts.setSubscription(ACQ, "release.merged", { app: false });
    renderRoute(PAGE, LAURA);
    await ready();
    const user = userEvent.setup();
    const appOf = (label: string) => sw(`${label} in AUD, App`).getAttribute("aria-checked");
    const before = { pr: appOf("New PR"), merged: appOf("Release merged") };
    expect(before).toEqual({ pr: "false", merged: "true" });

    await user.click(screen.getByRole("button", { name: "Alert actions for AUD" }));
    await user.click(screen.getByRole("menuitem", { name: "Same as another project…" }));
    await user.type(screen.getByRole("searchbox", { name: "Copy from a project" }), "ACQ");
    await user.click(screen.getByRole("menuitem", { name: /ACQ/ }));
    const dialog = await screen.findByRole("dialog", { name: "Use ACQ's alert settings in AUD?" });
    expect(within(dialog).getByText(/^\d+ alerts? changes?\.$/)).toBeVisible();
    expect(within(dialog).getByText("New PR: off → App and phone")).toBeVisible();
    expect(within(dialog).getByText("Release merged: App → off")).toBeVisible();
    expect(
      within(dialog).getByText("Paused alerts, and the ones always on for you, stay as they are."),
    ).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Copy settings" }));
    expect(await screen.findByText("AUD now has ACQ's alert settings.")).toBeVisible();
    await waitFor(() => expect(appOf("New PR")).toBe("true"));
    expect(appOf("Release merged")).toBe("false");

    await user.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(appOf("New PR")).toBe("false"));
    expect(appOf("Release merged")).toBe("true");
  });
});

describe("stati della pagina", () => {
  it("caricamento con lo scheletro, errore con «Retry»", async () => {
    setLatency(200);
    failNext("alerts.subscriptionRows");
    renderRoute(PAGE, LAURA);
    expect(await screen.findByRole("status")).toHaveTextContent("Loading…");
    expect(await screen.findByText("Couldn't load your alert settings.")).toBeVisible();
    setLatency(0);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await ready();
  });

  it("cambio di persona con la pagina aperta: le righe si ricalcolano, ricerca e gruppi aperti restano", async () => {
    // Un progetto che vedono entrambi e che nessuno dei due ha fissato: chiuso di partenza.
    const shared = state.projects.find(
      (p) =>
        visibleProjectIds(LAURA).has(p.id) &&
        visibleProjectIds(MARCO).has(p.id) &&
        !INITIAL_PINNED_CODES[LAURA]!.includes(p.code) &&
        !INITIAL_PINNED_CODES[MARCO]!.includes(p.code),
    )!;
    expect(shared).toBeDefined();
    renderRoute(PAGE, LAURA);
    await ready();
    const user = userEvent.setup();
    expect(sw("PR analysis found problems in AUD, App")).toHaveAttribute("aria-checked", "true");
    await user.click(headerOf(shared.code)!);
    await user.type(screen.getByRole("searchbox", { name: "Find a project" }), "a");

    await user.click(screen.getByRole("button", { name: "Profile and settings" }));
    const menu = await screen.findByRole("dialog", { name: "Profile and settings" });
    await user.click(within(menu).getByRole("radio", { name: /Marco Bellini/ }));
    await user.keyboard("{Escape}");

    await waitFor(() =>
      expect(sw("PR analysis found problems in AUD, App")).toHaveAttribute("aria-checked", "false"),
    );
    expect(screen.getByRole("searchbox", { name: "Find a project" })).toHaveValue("a");
    await user.clear(screen.getByRole("searchbox", { name: "Find a project" }));
    expect(headerOf(shared.code)).toHaveAttribute("aria-expanded", "true");
    expect(headers()).toHaveLength(visibleProjectIds(MARCO).size);
    // m2: la mappa di Laura non finisce sotto la chiave di Marco; Marco scrive solo ciò che tocca.
    const stored = (id: string) =>
      JSON.parse(window.localStorage.getItem(`stubwise.alerts.open.${id}`) ?? "null") as unknown;
    expect(stored(MARCO)).toBeNull();
    await user.click(headerOf("AUD")!);
    expect(stored(MARCO)).toEqual({ [AUD]: false });
    expect(stored(LAURA)).toEqual({ [shared.id]: true });
  });

  it("una rilettura che fallisce con i dati in pagina: un avviso con «Retry», la pagina resta", async () => {
    renderRoute(PAGE, LAURA);
    await ready();
    failNext("alerts.subscriptionRows");
    await userEvent.click(sw("New PR in AUD, App"));
    expect(
      await screen.findByText(
        "Couldn't refresh your alert settings: what you see may be out of date.",
      ),
    ).toBeVisible();
    expect(headerOf("AUD")).toHaveAttribute("aria-expanded", "true");
    expect(sw("New PR in AUD, App")).toBeVisible();
    expect(screen.queryByText("Couldn't load your alert settings.")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(
        screen.queryByText(
          "Couldn't refresh your alert settings: what you see may be out of date.",
        ),
      ).toBeNull(),
    );
  });

  it("un «Undo» che fallisce lo dice con un toast d'errore", async () => {
    renderRoute(PAGE, LAURA);
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Alert actions for AUD" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Turn everything off in AUD" }));
    await screen.findByText(/^Everything off in AUD\./);
    failNext("alerts.undo");
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Couldn't undo the change in AUD.")).toBeVisible();
  });
});
