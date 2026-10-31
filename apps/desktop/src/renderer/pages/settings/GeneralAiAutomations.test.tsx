import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failNext, resetApi, setLatency } from "../../data/api";
import { pulseNeedsBacklogFor } from "../../data/queries";
import { state } from "../../data/store";
import { grantProjectPermission } from "../../data/viewer";
import i18n from "../../i18n";
import { clearToasts } from "../../tasks-ui/Toast";
import { renderRoute } from "../../test/renderRoute";

// Progetto → Settings: General, AI, Automations e Usage (area 9c, Task 7,
// shape project-settings.md) e il segno «View only» nella forma (a)
// confermata dal maintainer [PS 3]. Laura è Project Lead di ACQ (cambia le
// impostazioni e legge i consumi); Sara è Contributor in ACQ (legge e
// basta); Roberta è full admin.

const ACQ = "prj-acq";
const LAURA = "p-laura";
const SARA = "p-sara";
const MANAGE_SETTINGS_LINE =
  /^You can read these settings\. Changing them needs someone who can change ACQ's settings\./;

beforeEach(() => {
  setLatency(0);
  resetApi();
});
afterEach(async () => {
  clearToasts();
  resetApi();
  await i18n.changeLanguage("en");
});

async function open(section: string, personId: string, query = "") {
  const router = renderRoute(`/p/ACQ/settings/${section}${query}`, personId);
  return router;
}

const h1 = (name: string) => screen.findByRole("heading", { level: 1, name });
const settingsLink = () =>
  screen.getByRole("navigation", { name: "Project sections" }).querySelector<HTMLElement>(
    '[data-section="settings"]',
  )!;
const nested = () => screen.findByRole("list", { name: "Settings of ACQ" });
const nestedItem = (list: HTMLElement, id: string) =>
  list.querySelector<HTMLElement>(`[data-settings-section="${id}"]`);
const marked = (el: HTMLElement | null) => !!el?.querySelector("[data-view-only]");

describe("la colonna e le rotte di Settings", () => {
  it("#/p/ACQ/settings apre General [PS 2], e il fuoco va all'h1", async () => {
    const router = renderRoute("/p/ACQ/settings", LAURA);
    const heading = await h1("General");
    expect(router.state.location.pathname).toBe("/p/ACQ/settings/general");
    await waitFor(() => expect(heading).toHaveFocus());
  });

  it("Laura legge le undici sezioni senza nessun «View only»", async () => {
    await open("general", LAURA);
    await h1("General");
    const list = await nested();
    expect(
      [...list.querySelectorAll("[data-settings-section]")].map((a) =>
        a.getAttribute("data-settings-section"),
      ),
    ).toEqual([
      "general",
      "statuses",
      "members",
      "ai",
      "automations",
      "repositories",
      "integration",
      "plugins",
      "usage",
      "changelog",
      "archive",
    ]);
    expect(list.querySelector("[data-view-only]")).toBeNull();
    expect(marked(settingsLink())).toBe(false);
  });

  it("Sara: «View only» solo sulla voce Settings; Usage e Change log non ci sono e portano a General", async () => {
    const router = await open("usage", SARA);
    await h1("General");
    expect(router.state.location.pathname).toBe("/p/ACQ/settings/general");
    const list = await nested();
    expect(nestedItem(list, "usage")).toBeNull();
    expect(nestedItem(list, "changelog")).toBeNull();
    expect(list.querySelector("[data-view-only]")).toBeNull();
    const mark = settingsLink().querySelector<HTMLElement>("[data-view-only]")!;
    expect(mark).toHaveTextContent("View only");
    expect(mark).toHaveAttribute("title", "You can read this section, not change it.");
    expect(within(mark).getByText("You can read this section, not change it.")).toHaveClass(
      "sr-only",
    );
  });

  it("Sara: l'indirizzo di Change log porta a General", async () => {
    const router = await open("changelog", SARA);
    await h1("General");
    expect(router.state.location.pathname).toBe("/p/ACQ/settings/general");
  });

  it("chi ha il solo project.members.manage: il segno sulle voci in sola lettura, non su Members né su Settings", async () => {
    grantProjectPermission(SARA, ACQ, "project.members.manage" as never);
    await open("general", SARA);
    await h1("General");
    const list = await nested();
    expect(marked(settingsLink())).toBe(false);
    for (const id of ["general", "statuses", "ai", "automations", "integration", "plugins", "archive"])
      expect(marked(nestedItem(list, id)), id).toBe(true);
    expect(marked(nestedItem(list, "members"))).toBe(false);
    // Change log c'è (gestisce i membri), ma non è mai «in sola lettura».
    expect(nestedItem(list, "changelog")).not.toBeNull();
    expect(marked(nestedItem(list, "changelog"))).toBe(false);
    // In General la riga ○ della sezione, con il suo «Who?».
    const line = screen.getByText(MANAGE_SETTINGS_LINE).closest<HTMLElement>("[data-view-only-line]")!;
    expect(line.querySelector(`[data-who-can="manageProjectSettings"]`)).toBeInTheDocument();
  });

  it("con repos.manage senza le impostazioni, Integration non porta «View only» [PS 4]", async () => {
    grantProjectPermission(SARA, ACQ, "repos.manage" as never);
    await open("general", SARA);
    await h1("General");
    const list = await nested();
    expect(marked(nestedItem(list, "integration"))).toBe(false);
    expect(marked(nestedItem(list, "general"))).toBe(true);
    expect(marked(settingsLink())).toBe(false);
  });
});

describe("General", () => {
  it("Laura rinomina ACQ: «Saved», il nome nuovo nella colonna e la voce in Change log", async () => {
    const router = await open("general", LAURA);
    await h1("General");
    const name = await screen.findByRole("textbox", { name: "Name" });
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toHaveAttribute("aria-disabled", "true");
    await userEvent.clear(name);
    await userEvent.type(name, "Portale clienti Acquedotto");
    expect(save).not.toHaveAttribute("aria-disabled");
    await userEvent.click(save);
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    expect(save).toHaveFocus();
    expect(state.projectsById.get(ACQ)!.name).toBe("Portale clienti Acquedotto");
    // Il nome nuovo, senza ricaricare: testata della colonna, tessera del binario, ⌘K.
    const header = document.querySelector<HTMLElement>("[data-column-code]")!.closest("h2")!;
    await waitFor(() => expect(header).toHaveTextContent("Portale clienti Acquedotto"));
    const rail = screen.getByRole("navigation", { name: "Main navigation" });
    expect(
      within(rail).getByRole("link", { name: "ACQ · Portale clienti Acquedotto" }),
    ).toBeInTheDocument();
    await userEvent.keyboard("{Control>}k{/Control}");
    const palette = await screen.findByRole("dialog", { name: "Search and commands" });
    await userEvent.type(within(palette).getByRole("combobox"), "clienti Acquedotto");
    expect(
      await within(palette).findByRole("option", { name: /Portale clienti Acquedotto/ }),
    ).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await router.navigate({ to: "/p/$code/settings/$section", params: { code: "ACQ", section: "changelog" } });
    await h1("Change log");
    expect(await screen.findByText(/renamed/)).toBeInTheDocument();
  });

  it("un nome vuoto si dice sotto il campo, e niente cambia", async () => {
    await open("general", LAURA);
    const name = await screen.findByRole("textbox", { name: "Name" });
    await userEvent.clear(name);
    await userEvent.type(name, "   ");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Give the project a name.")).toBeInTheDocument();
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveAccessibleDescription("Give the project a name.");
    expect(state.projectsById.get(ACQ)!.name).not.toBe("");
  });

  it("il codice si legge e non si modifica", async () => {
    await open("general", LAURA);
    await screen.findByRole("textbox", { name: "Name" });
    expect(screen.getAllByRole("textbox").map((el) => el.getAttribute("aria-label") ?? "")).not.toContain("Code");
    expect(screen.queryByRole("textbox", { name: "Code" })).toBeNull();
    expect(screen.getByText("ACQ", { selector: "[data-project-code]" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "The code never changes: it's in every task code, like ACQ-57, and in links people have saved.",
      ),
    ).toBeInTheDocument();
  });

  it("Sara legge General in sola lettura: i valori come testo, la riga ○ con «Who?», nessun Save", async () => {
    await open("general", SARA);
    await h1("General");
    const line = (await screen.findByText(MANAGE_SETTINGS_LINE)).closest<HTMLElement>(
      "[data-view-only-line]",
    )!;
    expect(line.querySelector(`[data-who-can="manageProjectSettings"]`)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByText(state.projectsById.get(ACQ)!.name, { selector: "dd" })).toBeInTheDocument();
  });
});

describe("AI", () => {
  it("Laura sceglie Backup Max e «Use only this account» → «Saved»", async () => {
    await open("ai", LAURA);
    await h1("AI");
    const only = await screen.findByRole("checkbox", { name: "Use only this account" });
    expect(only).toBeDisabled();
    expect(screen.getByText("Choose an account first.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: /^Backup Max/ }));
    expect(only).toBeEnabled();
    await userEvent.click(only);
    expect(
      screen.getByText(
        "When Backup Max is at its limit or off, Claude's new work in ACQ doesn't switch to another account: it starts without one, and the task says so.",
      ),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    const s = state.projectSettings.get(ACQ)!;
    expect(s.aiProviderId).toBe("prv-backup-max");
    expect(s.aiProviderExclusive).toBe(true);
  });

  it("un account spento, scelto in esclusiva: la riga dice che il lavoro parte senza account (I4)", async () => {
    state.instance.providers.find((p) => p.id === "prv-backup-max")!.enabled = false;
    const s = state.projectSettings.get(ACQ)!;
    s.aiProviderId = "prv-backup-max";
    s.aiProviderExclusive = true;
    await open("ai", LAURA);
    await h1("AI");
    expect(
      await screen.findByText(
        "It's off: until someone turns it on, Claude's new work in ACQ starts without an account.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Claude uses Automatic\.$/)).toBeNull();
    // Senza esclusività la frase dello shape resta.
    await userEvent.click(screen.getByRole("checkbox", { name: "Use only this account" }));
    expect(
      screen.getByText("It's off: until someone turns it on, Claude uses Automatic."),
    ).toBeInTheDocument();
  });

  it("l'account scelto e poi eliminato si dice in parole, e salvare conferma Automatic", async () => {
    state.projectSettings.get(ACQ)!.aiProviderId = "prv-gone";
    await open("ai", LAURA);
    await h1("AI");
    expect(
      await screen.findByText(
        "The account chosen for ACQ was deleted. Claude uses Automatic until you choose again.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^Automatic/ })).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    expect(state.projectSettings.get(ACQ)!.aiProviderId).toBeNull();
  });

  it("Sara: radio e casella spente, ognuna con la frase e «Who?», e nessun Save", async () => {
    await open("ai", SARA);
    await h1("AI");
    const line = (await screen.findByText(MANAGE_SETTINGS_LINE)).closest<HTMLElement>(
      "[data-view-only-line]",
    )!;
    expect(line.querySelector(`[data-who-can="manageProjectSettings"]`)).toBeInTheDocument();
    for (const radio of screen.getAllByRole("radio")) {
      expect(radio).toBeDisabled();
      expect(radio).toHaveAccessibleDescription(MANAGE_SETTINGS_LINE);
    }
    expect(screen.getByRole("checkbox", { name: "Use only this account" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });
});

describe("Automations", () => {
  it("Laura spegne il brief: «1 change», poi «Saved»", async () => {
    await open("automations", LAURA);
    await h1("Automations");
    await userEvent.click(await screen.findByRole("switch", { name: "Weekly brief" }));
    expect(screen.getByText("1 change")).toBeInTheDocument();
    // La barra è figlia della colonna del contenuto: `sticky` la aggancia in fondo alla finestra (I2).
    const bar = document.querySelector<HTMLElement>("[data-save-bar]")!;
    expect(bar.parentElement).toContainElement(screen.getByRole("switch", { name: "Weekly brief" }));
    const save = screen.getByRole("button", { name: "Save" });
    await userEvent.click(save);
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    expect(state.projectSettings.get(ACQ)!.switches.weeklyBrief).toBe(false);
    // Dopo Save il fuoco resta sul bottone, spento finché non c'è altro da salvare (I3).
    expect(save).toBeInTheDocument();
    expect(save).toHaveFocus();
    expect(save).toHaveAttribute("aria-disabled", "true");
    // 2 s dopo «Saved» la barra se ne va: il fuoco passa all'h1, non al body (T7).
    await waitFor(() => expect(document.querySelector("[data-save-bar]")).toBeNull(), {
      timeout: 3000,
    });
    expect(screen.getByRole("heading", { level: 1, name: "Automations" })).toHaveFocus();
  });

  it("I6: Save non riesce, Retry riesce → «Saved» e la barra senza modifiche", async () => {
    await open("automations", LAURA);
    await h1("Automations");
    await userEvent.click(await screen.findByRole("switch", { name: "Weekly brief" }));
    failNext("projectSettings.saveProjectAutomations");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Couldn't save. Try again.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    expect(screen.queryByText("1 change")).toBeNull();
  });

  it("I6: General, Save non riesce e Retry riesce → «Saved»", async () => {
    await open("general", LAURA);
    await h1("General");
    const name = await screen.findByRole("textbox", { name: "Name" });
    await userEvent.clear(name);
    await userEvent.type(name, "Portale Acquedotto");
    failNext("projectSettings.updateProjectGeneral");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Couldn't save. Try again.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Saved")).toBeInTheDocument();
  });

  it("spento il brief, la BriefCard dell'Overview lo dice", async () => {
    const router = await open("automations", LAURA);
    await h1("Automations");
    await userEvent.click(await screen.findByRole("switch", { name: "Weekly brief" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved");
    await router.navigate({ to: "/p/$code/$section", params: { code: "ACQ", section: "overview" } });
    expect(
      await screen.findByText(
        /^(The weekly brief is off for ACQ\.|The weekly brief is off: no new ones arrive\.)/,
      ),
    ).toBeInTheDocument();
  });

  it("pulse a 31: l'errore sotto il campo, niente salvato", async () => {
    await open("automations", LAURA);
    const days = await screen.findByRole("spinbutton", { name: "Pulse: every how many days" });
    await userEvent.clear(days);
    await userEvent.type(days, "31");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Choose a whole number of days from 1 to 30.")).toBeInTheDocument();
    expect(days).toHaveAccessibleDescription("Choose a whole number of days from 1 to 30.");
    expect(state.projectSettings.get(ACQ)!.pulseEveryDays).toBe(7);
  });

  it("con la discovery spenta il pulse è spento con la frase, senza «Who?»", async () => {
    await open("automations", LAURA);
    const pulse = await screen.findByRole("switch", { name: "Pulse" });
    expect(pulse).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("switch", { name: "Backlog discovery" }));
    expect(pulse).toHaveAttribute("aria-checked", "false");
    expect(pulse).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("Pulse turned off too.")).toBeInTheDocument();
    const row = pulse.closest<HTMLElement>("[data-switch-row]")!;
    expect(row.querySelector("[data-who-can]")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    expect(
      await screen.findByText("The pulse needs backlog discovery: without it there's nothing to propose."),
    ).toBeInTheDocument();
    expect(row.querySelector("[data-who-can]")).toBeNull();
    // Riaccendere la discovery non riaccende il pulse [PS 8].
    await userEvent.click(screen.getByRole("switch", { name: "Backlog discovery" }));
    expect(screen.getByRole("switch", { name: "Pulse" })).toHaveAttribute("aria-checked", "false");
  });

  it("tetto 0 dice «automatic cycle off»", async () => {
    await open("automations", LAURA);
    const cap = await screen.findByRole("spinbutton", { name: "Correction cap" });
    await userEvent.clear(cap);
    await userEvent.type(cap, "0");
    expect(screen.getByText("Automatic cycle off: corrections only by hand.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    expect(state.projectsById.get(ACQ)!.correctionCap).toBe(0);
  });

  it("Sara: interruttori spenti con la frase, i numeri come testo, la riga ○ e nessuna barra", async () => {
    await open("automations", SARA);
    await h1("Automations");
    const line = (await screen.findByText(MANAGE_SETTINGS_LINE)).closest<HTMLElement>(
      "[data-view-only-line]",
    )!;
    expect(line.querySelector(`[data-who-can="manageProjectSettings"]`)).toBeInTheDocument();
    for (const sw of screen.getAllByRole("switch")) {
      expect(sw).toHaveAttribute("aria-disabled", "true");
      expect(sw).toHaveAccessibleDescription(MANAGE_SETTINGS_LINE);
    }
    expect(screen.queryByRole("spinbutton")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });
});

describe("Usage", () => {
  it("Laura legge i consumi di ACQ: periodo e gruppo nell'indirizzo, nessuna dimensione Project", async () => {
    const router = await open("usage", LAURA);
    await h1("Usage");
    const group = await screen.findByRole("combobox", { name: "Group by" });
    expect(group).toHaveValue("operation");
    expect(within(group).queryByRole("option", { name: "Project" })).toBeNull();
    expect(
      within(screen.getByRole("combobox", { name: "then by" })).queryByRole("option", {
        name: "Project",
      }),
    ).toBeNull();
    expect(screen.queryByText("Other projects")).toBeNull();
    await userEvent.click(screen.getByRole("radio", { name: "Last 7 days" }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ range: "7d" }));
    // Il periodo nuovo rilegge i consumi: la tabella si rimonta.
    await screen.findByRole("list", { name: "Totals" });
    await userEvent.selectOptions(await screen.findByRole("combobox", { name: "Group by" }), "model");
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ range: "7d", group: "model" }),
    );
    expect(router.state.location.pathname).toBe("/p/ACQ/settings/usage");
  });
});

describe("la regola del pulse sta nel livello dati (I1)", () => {
  it("pulseNeedsBacklogFor: il pulse ha bisogno della discovery", () => {
    const base = {
      docsNightly: true,
      dailyReport: true,
      backlogDiscovery: true,
      pulse: true,
      weeklyBrief: true,
    };
    expect(pulseNeedsBacklogFor(base)).toBe(false);
    expect(pulseNeedsBacklogFor({ ...base, backlogDiscovery: false })).toBe(true);
  });

  it("la pagina non riscrive il predicato", () => {
    const src = SOURCES["./AutomationSettings.tsx"]!;
    expect(src).toMatch(/pulseNeedsBacklogFor\(/);
    expect(src).not.toMatch(/!\s*draft\.switches\.backlogDiscovery/);
  });
});

// Ruling del controller (pre-flight), P13: le pagine delle impostazioni non
// decidono i permessi. Il test di Statuses da solo passerebbe anche con un
// `can()` rimasto nella pagina: questo guarda il sorgente.
const SOURCES = import.meta.glob(["./**/*.{ts,tsx}", "!./**/*.test.{ts,tsx}"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

describe("pages/settings non decide i permessi", () => {
  it("trova i sorgenti", () => {
    expect(Object.keys(SOURCES)).toContain("./ProjectStatusesSettings.tsx");
    expect(Object.keys(SOURCES)).toContain("./GeneralSettings.tsx");
  });

  it("nessun file chiama can( né importa data/viewer", () => {
    // Una chiamata, non un commento che nomina `can()` fra apici inversi.
    const offenders = Object.entries(SOURCES)
      .filter(([, src]) => /(^|[^\w.`])can\(/.test(src) || /data\/viewer["']/.test(src))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
