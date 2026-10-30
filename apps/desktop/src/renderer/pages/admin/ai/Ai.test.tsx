import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { roleIdOf, writeAccess } from "../../../data/access/index";
import { __secretValuesForTest } from "../../../data/admin/secrets";
import { resetApi, setLatency } from "../../../data/api";
import * as auth from "../../../data/auth/index";
import { spentThisMonthUsd } from "../../../data/instance/usage";
import { state } from "../../../data/store";
import { grantInstancePermission, type LocalInstancePermission } from "../../../data/viewer";
import i18n from "../../../i18n";
import { DOCKED_PANEL_QUERY } from "../../../layout/useDetailPanel";
import { resetReauthForTest } from "../../../layout/useReauth";
import { SecretField } from "../../../components/SecretField";
import { renderRoute } from "../../../test/renderRoute";
import { setMatchMedia } from "../../../test/setup";

// La voce AI dell'Amministrazione (area 9b, Task 8, shape admin-ai.md):
// le schede per permesso, Providers con la catena, Models, Automation,
// Budget & language e il campo dei segreti. Usage è del Task 9 (ruling 23):
// qui si prova solo che la scheda c'è per chi ha `usage.view`.
// Roberta è full admin; Marco è Developer (gli si dà un permesso alla volta);
// Sara è User, e le si dà il ruolo Auditor (`au-1`) quando serve (ruling 27).

const ROBERTA = "p-roberta";
const MARCO = "p-marco";
const SARA = "p-sara";

beforeEach(() => {
  setLatency(0);
  resetApi();
  resetReauthForTest();
  window.localStorage.clear();
  setMatchMedia(DOCKED_PANEL_QUERY, true);
});
afterEach(async () => {
  vi.restoreAllMocks();
  resetApi();
  await i18n.changeLanguage("en");
});

const give = (personId: string, perm: string) =>
  grantInstancePermission(personId, perm as LocalInstancePermission);
const heading = (name: string | RegExp) => screen.findByRole("heading", { level: 1, name });
const provider = (name: string) => state.instance.providers.find((p) => p.name === name)!;
const chain = () => state.instance.providers.map((p) => p.name);
const row = (name: string) => screen.getByRole("listitem", { name });

/** Il dialogo «Confirm it's you»: il codice del prototipo, e l'azione riparte da sola. */
async function confirmItsYou(user: ReturnType<typeof userEvent.setup>) {
  const dialog = await screen.findByRole("dialog", { name: "Confirm it's you" });
  await user.type(within(dialog).getByLabelText("Code"), "123456");
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Confirm it's you" })).toBeNull(),
  );
}

// --- Le schede ----------------------------------------------------------------

describe("le schede per permesso", () => {
  it("il full admin vede la voce AI nel gruppo Instance e tutte e cinque le schede", async () => {
    renderRoute("/admin/ai", ROBERTA);
    expect(await heading("AI")).toBeVisible();
    const column = screen.getByRole("navigation", { name: "Administration sections" });
    const instance = within(column).getByRole("list", { name: "Instance" });
    expect(within(instance).getAllByRole("link")[0]).toHaveTextContent("AI");
    expect(within(column).getByRole("list", { name: "Across projects" })).toBeVisible();
    const tabs = screen.getByRole("tablist", { name: "AI settings" });
    expect(
      within(tabs)
        .getAllByRole("tab")
        .map((t) => t.textContent),
    ).toEqual(["Providers", "Models", "Automation", "Budget & language", "Usage"]);
    // Senza `?tab=` la prima scheda.
    expect(within(tabs).getByRole("tab", { name: "Providers" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("la scheda sta nell'indirizzo; una sconosciuta apre la prima visibile", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/admin/ai?tab=nope", ROBERTA);
    await heading("AI");
    expect(screen.getByRole("tab", { name: "Providers" })).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByRole("tab", { name: "Models" }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ tab: "models" }));
    expect(screen.getByRole("tab", { name: "Models" })).toHaveAttribute("aria-selected", "true");
  });

  it("con il ruolo Auditor c'è la sola Usage: niente barra delle schede, h1 «AI»", async () => {
    writeAccess((a) => {
      a.people.find((p) => p.personId === SARA)!.instanceRoleId = roleIdOf("au-1");
    });
    renderRoute("/admin/ai?tab=providers", SARA);
    expect(await heading("AI")).toBeVisible();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add account" })).toBeNull();
    expect(screen.queryByText("Team Max")).toBeNull();
  });

  it("senza nessuno dei tre permessi /admin/ai è «not found»", async () => {
    renderRoute("/admin/ai", SARA);
    expect(await screen.findByText(i18n.t("notFound.title"))).toBeVisible();
  });

  it("con solo settings.manage, Providers si legge: bottoni spenti, la frase e il «Who?»", async () => {
    give(MARCO, "settings.manage");
    renderRoute("/admin/ai?tab=providers", MARCO);
    await heading("AI");
    expect(await screen.findByText("Team Max")).toBeVisible();
    expect(
      screen.getByText(
        "You can read these settings. Changing them needs someone who can manage AI providers.",
      ),
    ).toBeVisible();
    expect(document.querySelectorAll('[data-who-can="manageAiProviders"]').length).toBeGreaterThan(
      0,
    );
    expect(screen.getByRole("button", { name: "Add account" })).toBeDisabled();
    const team = row("Team Max");
    expect(within(team).getByRole("switch", { name: "Use Team Max" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(within(team).getByRole("button", { name: "Test" })).toBeDisabled();
    // Ogni «Test» spento per permesso ha il suo «Who?» accanto (GC del maintainer).
    for (const name of ["Team Max", "Backup Max", "Billing key"]) {
      const test = within(row(name)).getByRole("button", { name: "Test" });
      expect(test).toBeDisabled();
      expect(
        test.parentElement!.querySelector('[data-who-can="manageAiProviders"]'),
      ).not.toBeNull();
    }
    expect(within(team).queryByRole("button", { name: "Move Team Max" })).toBeNull();
    expect(within(team).queryByRole("button", { name: "More for Team Max" })).toBeNull();
    // Il riquadro «Prototype only» è di chi può provare.
    expect(document.querySelector("[data-prototype-only]")).toBeNull();
    // Models invece si scrive: nessuna frase di sola lettura.
    await userEvent.setup().click(screen.getByRole("tab", { name: "Models" }));
    expect(await screen.findByText("Fix plan")).toBeVisible();
    expect(screen.queryByText(/You can read these settings/)).toBeNull();
  });

  it("con solo ai_providers.manage, Models, Automation e Budget si leggono", async () => {
    const user = userEvent.setup();
    give(MARCO, "ai_providers.manage");
    renderRoute("/admin/ai?tab=models", MARCO);
    await screen.findByText("Fix plan");
    const readOnly =
      "You can read these settings. Changing them needs someone who can change the instance settings.";
    expect(screen.getByText(readOnly)).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Model for Fix plan" })).toBeDisabled();
    await user.click(screen.getByRole("tab", { name: "Budget & language" }));
    expect(await screen.findByText(readOnly)).toBeVisible();
    expect(screen.getByLabelText("Monthly budget")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(document.querySelectorAll('[data-who-can="manageSettings"]').length).toBeGreaterThan(0);
  });
});

// --- Providers ----------------------------------------------------------------

describe("Providers", () => {
  it("la catena numerata, la quota in parole e la chiave API in attesa", async () => {
    renderRoute("/admin/ai", ROBERTA);
    await screen.findByRole("list", { name: "AI accounts" });
    const list = screen.getByRole("list", { name: "AI accounts" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    const backup = row("Backup Max");
    expect(within(backup).getByText("2")).toBeVisible();
    // «near» in parole, non solo col colore.
    expect(within(backup).getByText("Near the limit")).toBeVisible();
    expect(within(backup).getByText("5h 64% · week 87%")).toBeVisible();
    // Impeccable 6: la riga meta va a capo per pezzi interi, col «·» legato
    // al pezzo che segue (nessun «·» a sé), e «read 3h ago» come il resto dell'app.
    const meta = backup.querySelector<HTMLElement>("[data-meta-line]")!;
    const parts = [...meta.querySelectorAll<HTMLElement>("[data-meta-part]")];
    expect(parts.map((p) => p.textContent)).toEqual([
      "•••• b7d0",
      expect.stringMatching(/^tested /),
      "read 3h ago",
    ]);
    expect(parts.every((p) => p.className.includes("whitespace-nowrap"))).toBe(true);
    expect([...meta.querySelectorAll("span")].some((e) => e.textContent === "·")).toBe(false);
    expect(within(row("Team Max")).queryByText("Near the limit")).toBeNull();
    expect(
      within(row("Billing key")).getByText("used only when no subscription is on"),
    ).toBeVisible();
    expect(within(row("Billing key")).getByText("•••• 9e2b")).toBeVisible();
    expect(
      screen.getByText(
        "Above 90% of the week, background work (nightly Docs, reports) waits for the weekly reset.",
      ),
    ).toBeVisible();
    // Due abbonamenti: l'avviso dei Termini.
    expect(screen.getByText(/against Anthropic's terms/)).toBeVisible();
  });

  it("aggiunge un account con la riconferma; dopo la navigazione il DOM ha solo le ultime 4 (RF 1)", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/admin/ai?tab=providers", ROBERTA);
    await screen.findByRole("list", { name: "AI accounts" });
    await user.click(screen.getByRole("button", { name: "Add account" }));
    const dialog = screen.getByRole("dialog", { name: "Add an AI account" });
    // Gli errori sotto il campo, niente scritto.
    await user.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(within(dialog).getByText("Give it a name.")).toBeVisible();
    expect(within(dialog).getByText("Paste the token.")).toBeVisible();
    await user.type(within(dialog).getByLabelText("Name"), "Team Max");
    const token = within(dialog).getByLabelText("Token");
    expect(token).toHaveAttribute("type", "password");
    const value = "sk-ant-oat01-very-secret-7f3a";
    await user.type(token, value);
    // «Show» mostra il valore mentre lo si scrive.
    await user.click(within(dialog).getByRole("button", { name: "Show" }));
    expect(token).toHaveAttribute("type", "text");
    expect(within(dialog).getByRole("button", { name: "Hide" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(
      await within(dialog).findByText("There's already an account called Team Max."),
    ).toBeVisible();
    const name = within(dialog).getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Team Max 2");
    await user.click(within(dialog).getByRole("button", { name: "Add" }));
    await confirmItsYou(user);
    await waitFor(() =>
      expect(chain()).toEqual(["Team Max", "Backup Max", "Billing key", "Team Max 2"]),
    );
    expect(
      await screen.findByText("Team Max 2 added at position 4. Test it to check the token."),
    ).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Add an AI account" })).toBeNull();
    expect(within(row("Team Max 2")).getByText("•••• 7f3a")).toBeVisible();
    // Via e ritorno: il token non c'è da nessuna parte.
    await act(() => router.navigate({ to: "/admin/$section", params: { section: "people" } }));
    await heading("People");
    await act(() =>
      router.navigate({
        to: "/admin/$section",
        params: { section: "ai" },
        search: { tab: "providers" } as never,
      }),
    );
    await screen.findByRole("listitem", { name: "Team Max 2" });
    const secrets = __secretValuesForTest().flatMap((s) => s.values);
    expect(secrets).toContain(value);
    for (const v of secrets) expect(document.body.innerHTML).not.toContain(v);
    expect(screen.getByText("•••• 7f3a")).toBeVisible();
  });

  it("riconferma chiusa: niente aggiunto, il dialogo resta coi valori", async () => {
    const user = userEvent.setup();
    renderRoute("/admin/ai", ROBERTA);
    await screen.findByRole("list", { name: "AI accounts" });
    await user.click(screen.getByRole("button", { name: "Add account" }));
    const dialog = screen.getByRole("dialog", { name: "Add an AI account" });
    await user.click(within(dialog).getByRole("radio", { name: /^API key/ }));
    await user.type(within(dialog).getByLabelText("Name"), "Spare key");
    await user.type(within(dialog).getByLabelText("Key"), "sk-ant-api-spare-1234");
    await user.click(within(dialog).getByRole("button", { name: "Add" }));
    const confirm = await screen.findByRole("dialog", { name: "Confirm it's you" });
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Nothing was changed.")).toBeVisible();
    expect(chain()).toHaveLength(3);
    expect(within(dialog).getByLabelText("Name")).toHaveValue("Spare key");
  });

  it("riordina da tastiera (Alt+↑), dal «⋯» e trascinando, e lo annuncia", async () => {
    const user = userEvent.setup();
    renderRoute("/admin/ai", ROBERTA);
    await screen.findByRole("list", { name: "AI accounts" });
    // Tastiera: fuoco sulla maniglia, Alt+↑.
    within(row("Backup Max")).getByRole("button", { name: "Move Backup Max" }).focus();
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    await waitFor(() => expect(chain()).toEqual(["Backup Max", "Team Max", "Billing key"]));
    expect(await screen.findByText("Backup Max moved to position 1 of 3.")).toBeInTheDocument();
    await waitFor(() => expect(within(row("Backup Max")).getByText("1")).toBeVisible());
    // «⋯» → Move down.
    await user.click(
      within(row("Backup Max")).getByRole("button", { name: "More for Backup Max" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Move down" }));
    await waitFor(() => expect(chain()).toEqual(["Team Max", "Backup Max", "Billing key"]));
    // Trascinamento: Billing key dalla maniglia fino in cima. Le righe sono alte 64 px.
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
      const li = this.closest("[data-provider-row]");
      const items = [...document.querySelectorAll("[data-provider-row]")];
      const top = li ? items.indexOf(li) * 64 : 0;
      return {
        x: 0,
        y: top,
        top,
        left: 0,
        right: 800,
        bottom: top + 64,
        width: 800,
        height: 64,
        toJSON: () => ({}),
      } as DOMRect;
    });
    const handle = within(row("Billing key")).getByRole("button", { name: "Move Billing key" });
    fireEvent.pointerDown(handle, {
      button: 0,
      isPrimary: true,
      pointerId: 1,
      clientX: 10,
      clientY: 160,
    });
    fireEvent.pointerMove(document, { pointerId: 1, clientX: 10, clientY: 150 });
    fireEvent.pointerMove(document, { pointerId: 1, clientX: 10, clientY: 20 });
    fireEvent.pointerUp(document, { pointerId: 1, clientX: 10, clientY: 20 });
    await waitFor(() => expect(chain()).toEqual(["Billing key", "Team Max", "Backup Max"]));
  });

  it("spegne un account col suo toast; l'ultimo acceso ha l'interruttore spento con la frase (RF 4)", async () => {
    const user = userEvent.setup();
    renderRoute("/admin/ai", ROBERTA);
    await screen.findByRole("list", { name: "AI accounts" });
    await user.click(within(row("Backup Max")).getByRole("switch", { name: "Use Backup Max" }));
    await waitFor(() => expect(provider("Backup Max").enabled).toBe(false));
    expect(
      await screen.findByText("Backup Max is off. New work uses the next account."),
    ).toBeVisible();
    await user.click(within(row("Team Max")).getByRole("switch", { name: "Use Team Max" }));
    await waitFor(() => expect(provider("Team Max").enabled).toBe(false));
    // Nessun abbonamento acceso: la chiave API è in uso.
    expect(
      await within(row("Billing key")).findByText("in use: no subscription is on"),
    ).toBeVisible();
    const last = within(row("Billing key")).getByRole("switch", { name: "Use Billing key" });
    expect(last).toHaveAttribute("aria-disabled", "true");
    expect(
      within(row("Billing key")).getByText(
        "This is the only account on. Turn on another one first.",
      ),
    ).toBeVisible();
    await user.click(last);
    expect(provider("Billing key").enabled).toBe(true);
    // Disabilitato: posizione «–» al suo posto.
    expect(within(row("Team Max")).getByText("–")).toBeVisible();
    // E il «⋯» non lo elimina.
    await user.click(
      within(row("Billing key")).getByRole("button", { name: "More for Billing key" }),
    );
    expect(screen.getByRole("menuitem", { name: "Delete…" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("prova con l'esito scelto nel riquadro «Prototype only»", async () => {
    const user = userEvent.setup();
    renderRoute("/admin/ai", ROBERTA);
    await screen.findByRole("list", { name: "AI accounts" });
    const box = screen.getByRole("region", { name: "Prototype only" });
    await user.selectOptions(within(box).getByLabelText("Account"), "Billing key");
    await user.click(within(box).getByRole("radio", { name: "Invalid credentials" }));
    await waitFor(() =>
      expect(state.instance.simulate.nextTest[provider("Billing key").id]).toBe(
        "invalid_credentials",
      ),
    );
    await user.click(within(row("Billing key")).getByRole("button", { name: "Test" }));
    expect(within(row("Billing key")).getByText("Testing…")).toBeVisible();
    expect(
      await screen.findByText(
        "Billing key: invalid credentials. Replace the key and test again.",
        undefined,
        { timeout: 2000 },
      ),
    ).toBeVisible();
    expect(within(row("Billing key")).getByText("invalid credentials")).toBeVisible();
    expect(provider("Billing key").lastTest?.outcome).toBe("invalid_credentials");
  });

  it("sostituisce la chiave ed elimina un account, con la riconferma", async () => {
    const user = userEvent.setup();
    renderRoute("/admin/ai", ROBERTA);
    await screen.findByRole("list", { name: "AI accounts" });
    await user.click(
      within(row("Billing key")).getByRole("button", { name: "More for Billing key" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Replace key…" }));
    const dialog = screen.getByRole("dialog", { name: "Replace Billing key's key" });
    await user.type(within(dialog).getByLabelText("Key"), "sk-ant-api-new-55aa");
    await user.click(within(dialog).getByRole("button", { name: "Replace" }));
    await confirmItsYou(user);
    expect(await screen.findByText("Key replaced for Billing key.")).toBeVisible();
    expect(provider("Billing key").last4).toBe("55aa");
    expect(within(row("Billing key")).getByText("not tested yet")).toBeVisible();
    expect(document.body.innerHTML).not.toContain("sk-ant-api-new-55aa");

    await user.click(
      within(row("Backup Max")).getByRole("button", { name: "More for Backup Max" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Delete…" }));
    const del = screen.getByRole("dialog", { name: "Delete Backup Max?" });
    await user.click(within(del).getByRole("button", { name: "Delete" }));
    // La riconferma di poco fa vale ancora: niente secondo codice.
    expect(await screen.findByText("Backup Max deleted.")).toBeVisible();
    expect(chain()).toEqual(["Team Max", "Billing key"]);
  });
});

// --- Models -------------------------------------------------------------------

describe("Models", () => {
  it("la fonte di ogni valore; cambiato e riportato al predefinito", async () => {
    const user = userEvent.setup();
    renderRoute("/admin/ai?tab=models", ROBERTA);
    const fix = await screen.findByRole("group", { name: "Fix plan" });
    expect(within(fix).getByText("Set here")).toBeVisible();
    expect(within(fix).getByRole("combobox", { name: "Model for Fix plan" })).toHaveValue("opus");
    const mail = screen.getByRole("group", { name: "Mail classification" });
    expect(within(mail).getByText("From the server configuration")).toBeVisible();
    // Il primo valore del menu dice da dove viene il ritorno.
    expect(
      within(mail).getByRole("option", { name: "Server configuration (Haiku)" }),
    ).toBeInTheDocument();
    const triage = screen.getByRole("group", { name: "Task triage" });
    expect(within(triage).getByText("Default")).toBeVisible();
    expect(within(fix).getByRole("option", { name: "Default (Sonnet)" })).toBeInTheDocument();
    // I gruppi, senza «technical».
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "Tasks",
      "Backlog",
      "Nightly run",
      "Docs",
      "Reports",
      "Mail",
      "Chat",
    ]);

    await user.selectOptions(
      within(triage).getByRole("combobox", { name: "Model for Task triage" }),
      "opus",
    );
    await waitFor(() => expect(state.instance.models.triage).toBe("opus"));
    expect(await within(triage).findByText("Saved")).toBeVisible();
    expect(within(triage).getByText("Set here")).toBeVisible();
    await user.click(within(triage).getByRole("button", { name: "Use default" }));
    await waitFor(() => expect(state.instance.models.triage).toBeUndefined());
    expect(await within(triage).findByText("Default")).toBeVisible();
    expect(state.changelog.filter((e) => e.kind === "model.changed")).toHaveLength(2);
  });
});

// --- Automation ---------------------------------------------------------------

describe("Automation", () => {
  it("salva con la barra, «Saved»; l'errore sotto il campo", async () => {
    const user = userEvent.setup();
    renderRoute("/admin/ai?tab=automation", ROBERTA);
    const bug = await screen.findByRole("group", { name: "Bug" });
    expect(
      screen.getByText("Prototype: these are saved, but nothing here starts Claude on its own."),
    ).toBeVisible();
    const cost = within(bug).getByLabelText("Max cost per task");
    await user.type(cost, "-1");
    expect(screen.getByText("1 change")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(within(bug).getByText("Enter an amount of 0 or more, or leave it empty.")).toBeVisible();
    expect(cost).toHaveAttribute("aria-invalid", "true");
    expect(state.instance.automation.rules[0]!.maxCostUsd).toBeNull();
    await user.clear(cost);
    await user.type(cost, "3");
    await user.selectOptions(within(bug).getByLabelText("Up to effort"), "3");
    await user.click(screen.getByRole("switch", { name: "Review every pull request" }));
    expect(screen.getByText("3 changes")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved")).toBeVisible();
    expect(state.instance.automation.rules[0]).toMatchObject({ maxCostUsd: 3, maxEffort: 3 });
    expect(state.instance.automation.prReview.enabled).toBe(false);
    expect(state.changelog.filter((e) => e.kind === "automation.changed")).toHaveLength(1);
  });

  it("lasciare la scheda con modifiche chiede prima", async () => {
    const user = userEvent.setup();
    renderRoute("/admin/ai?tab=automation", ROBERTA);
    const feature = await screen.findByRole("group", { name: "Feature" });
    await user.click(within(feature).getByRole("switch", { name: "Auto-fix for Feature" }));
    await user.click(screen.getByRole("tab", { name: "Models" }));
    const ask = await screen.findByRole("group", { name: "Discard 1 change?" });
    await user.click(within(ask).getByRole("button", { name: "Discard" }));
    expect(await screen.findByText("Fix plan")).toBeVisible();
    expect(state.instance.automation.rules[1]!.autoFix).toBe(false);
  });
});

// --- Budget & language --------------------------------------------------------

describe("Budget & language", () => {
  it("salva budget e lingua, dice cosa ferma; l'errore sotto il campo; «Simulate budget reached»", async () => {
    const user = userEvent.setup();
    renderRoute("/admin/ai?tab=budget", ROBERTA);
    const amount = await screen.findByLabelText("Monthly budget");
    expect(amount).toHaveValue("600");
    expect(screen.getByText(/spent in .+ · \d+% of \$600/)).toBeVisible();
    expect(screen.getByText(/When it's reached, new work waits/)).toBeVisible();
    await user.clear(amount);
    await user.type(amount, "-5");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(
      screen.getByText("Enter an amount of 0 or more, or leave it empty for no budget."),
    ).toBeVisible();
    expect(state.instance.budget.monthlyUsd).toBe(600);
    await user.clear(amount);
    await user.type(amount, "800");
    await user.click(screen.getByRole("radio", { name: /^Italiano/ }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved")).toBeVisible();
    expect(state.instance.budget).toEqual({ monthlyUsd: 800, contentLanguage: "it" });

    const box = screen.getByRole("region", { name: "Prototype only" });
    await user.click(within(box).getByRole("switch", { name: "Simulate budget reached" }));
    await waitFor(() => expect(state.instance.simulate.budgetReached).toBe(true));
    expect(
      await screen.findByText(
        "Budget reached: new AI work is on hold until it's raised or the month ends.",
      ),
    ).toBeVisible();
    // Impeccable 1: la barra dice la percentuale vera (non il 100%), e la
    // frase dice che il raggiunto è simulato.
    const pct = Math.round((spentThisMonthUsd() / 800) * 100);
    expect(screen.getByText(new RegExp(`· ${pct}% of \\$800`))).toBeVisible();
    expect(document.querySelector<HTMLElement>("[data-meter-fill]")!.style.width).toBe(`${pct}%`);
    expect(screen.getByText("Simulated: the budget counts as reached.")).toBeVisible();
  });
});

// I toast del salvataggio leggono l'effetto dal livello dati (`saveBudget`),
// simulazione compresa: la pagina non ricalcola «raggiunto» da sé.
describe("Budget: cosa dice il salvataggio", () => {
  const spent = () => `$${Math.round(spentThisMonthUsd())}`;
  async function saveAmount(amount: string) {
    const user = userEvent.setup();
    renderRoute("/admin/ai?tab=budget", ROBERTA);
    const field = await screen.findByLabelText("Monthly budget");
    await user.clear(field);
    await user.type(field, amount);
    await user.click(screen.getByRole("button", { name: "Save" }));
  }

  it("simulazione accesa e budget alzato: il budget resta raggiunto, niente «riparte»", async () => {
    state.instance.simulate.budgetReached = true;
    await saveAmount("5000");
    expect(
      await screen.findByText(
        "Saved. The budget is still reached: the prototype simulation is on.",
      ),
    ).toBeVisible();
    expect(screen.queryByText(/Work waiting for the budget starts again/)).toBeNull();
  });

  it("budget sotto lo speso partendo da non raggiunto: «appena raggiunto», non «still»", async () => {
    await saveAmount("100");
    expect(
      await screen.findByText(
        `Saved. The budget is now reached: ${spent()} spent, $100 budget. New AI work waits.`,
      ),
    ).toBeVisible();
    expect(screen.queryByText(/still reached/)).toBeNull();
  });

  it("già raggiunto e ancora sotto lo speso: «still reached»", async () => {
    state.instance.budget.monthlyUsd = 100;
    await saveAmount("150");
    expect(
      await screen.findByText(`Saved. The budget is still reached: ${spent()} spent, $150 budget.`),
    ).toBeVisible();
  });

  it("già raggiunto e alzato sopra lo speso: il lavoro in attesa riparte", async () => {
    state.instance.budget.monthlyUsd = 100;
    await saveAmount("5000");
    expect(
      await screen.findByText("Budget saved. Work waiting for the budget starts again."),
    ).toBeVisible();
  });
});

// --- Istanza vuota ------------------------------------------------------------

describe("l'istanza vuota", () => {
  it("Providers dice che non c'è nessun account", async () => {
    await auth.resetToEmptyInstance();
    const created = await auth.createFirstAdmin({
      name: "Ada Prima",
      email: "ada@example.com",
      password: "a-long-one",
    });
    if (!created.ok) throw new Error(created.error);
    await auth.login({ email: "ada@example.com", password: "a-long-one" });
    renderRoute("/admin/ai", created.personId);
    expect(
      await screen.findByText("No AI accounts yet. Claude can't work until you add one."),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Add account" })).toBeEnabled();
  });
});

// --- SecretField --------------------------------------------------------------

describe("SecretField", () => {
  function Harness({ onSave }: { onSave: (v: string) => Promise<string | null> }) {
    const [last4, setLast4] = useState<string | null>("7f3a");
    return (
      <SecretField
        label="Client secret"
        last4={last4}
        onSave={async (v) => {
          const error = await onSave(v);
          if (!error) setLast4(v.slice(-4));
          return error;
        }}
      />
    );
  }

  afterEach(cleanup);

  it("salvato mostra le ultime 4 e Replace; Replace riapre il campo vuoto, Save lo svuota", async () => {
    const user = userEvent.setup();
    let release: (v: string | null) => void = () => {};
    const onSave = vi.fn(() => new Promise<string | null>((r) => (release = r)));
    render(<Harness onSave={onSave} />);
    expect(screen.getByText("•••• 7f3a")).toBeVisible();
    expect(screen.queryByLabelText("Client secret")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Replace" }));
    const field = screen.getByLabelText("Client secret");
    expect(field).toHaveValue("");
    expect(
      screen.getByText(
        "Shown only while you type. Once saved, you'll see only the last 4 characters.",
      ),
    ).toBeVisible();
    await user.type(field, "brand-new-9b9b");
    await user.click(screen.getByRole("button", { name: "Save" }));
    // Svuotato prima che la risposta arrivi.
    expect(field).toHaveValue("");
    await act(async () => release(null));
    expect(await screen.findByText("•••• 9b9b")).toBeVisible();
    expect(document.body.innerHTML).not.toContain("brand-new-9b9b");
  });

  it("un rifiuto lascia il valore scritto e l'errore sotto", async () => {
    const user = userEvent.setup();
    render(<Harness onSave={async () => "Couldn't save. Try again."} />);
    await user.click(screen.getByRole("button", { name: "Replace" }));
    await user.type(screen.getByLabelText("Client secret"), "rejected-1111");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Couldn't save. Try again.")).toBeVisible();
    expect(screen.getByLabelText("Client secret")).toHaveValue("rejected-1111");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("•••• 7f3a")).toBeVisible();
  });

  it("in sola lettura niente Replace", () => {
    render(<SecretField label="Client secret" last4="7f3a" readOnly />);
    expect(screen.getByText("•••• 7f3a")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Replace" })).toBeNull();
  });
});
