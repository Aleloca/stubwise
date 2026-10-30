import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { admin, resetApi, setLatency } from "../../data/api";
import { markReauthenticated } from "../../data/auth/reauth";
import { setSessionPersonId } from "../../data/session";
import { visiblePeopleFor } from "../../data/access/whoCan";
import { accessState, writeAccess } from "../../data/access/index";
import { ADMIN_CHANGE_TYPES } from "../../data/admin/changeTypes";
import { changeTypes, recordChange } from "../../data/changelog/index";
import { state } from "../../data/store";
import { can, viewerFor, type Permission } from "../../data/viewer";
import { PEOPLE } from "../../data/seed/people";
import i18n, { setLanguage } from "../../i18n";
import { resetReauthForTest } from "../../layout/useReauth";
import { renderRoute } from "../../test/renderRoute";

// Il registro delle modifiche e «Who can?» (area 9a, Task 11, shape
// admin-audit.md): il registro in Amministrazione e nelle Settings del
// progetto, «Who can?» nei due versi, il riquadro «Who?» accanto ai bottoni
// spenti e il gruppo «Who can?» di ⌘K. Persone del seme: Roberta (full
// admin), Laura (Project Lead di ACQ), Marco (Developer, `servers.operate`
// su ACQ da Roberta, 20 giorni fa), Sara (Contributor).

const ROBERTA = "p-roberta";
const LAURA = "p-laura";
const SARA = "p-sara";
const ACQ = "prj-acq";

beforeEach(() => {
  setLatency(0);
  resetApi();
  resetReauthForTest();
  window.localStorage.clear();
});
afterEach(async () => {
  resetApi();
  await i18n.changeLanguage("en");
});

const heading = (name: string | RegExp) => screen.findByRole("heading", { level: 1, name });
const entries = () => [...document.querySelectorAll<HTMLElement>("[data-change-entry]")];
const sentences = () => entries().map((e) => e.querySelector("p")!.textContent ?? "");
const nameOf = (id: string) => PEOPLE.find((p) => p.id === id)!.name;

describe("i template del registro", () => {
  it("ogni tipo registrato ha la sua frase e il suo gruppo in inglese e in italiano", () => {
    const types = changeTypes();
    expect(types.length).toBeGreaterThanOrEqual(ADMIN_CHANGE_TYPES.length);
    // Dalle risorse della lingua, non da `t()`: l'italiano ripiegherebbe sull'inglese.
    const text = (lng: string, key: string): unknown =>
      i18n.getResource(lng, "translation", key);
    for (const type of types)
      for (const lng of ["en", "it"]) {
        const phrase = text(lng, type.templateKey);
        expect(typeof phrase, `${lng} ${type.kind}`).toBe("string");
        // La frase nomina chi ha agito: un template che non lo fa è un errore di chi lo scrive.
        expect(phrase, `${lng} ${type.kind}`).toMatch(/<actor>\{\{actor\}\}<\/actor>/);
        expect(typeof text(lng, `changelog.groups.${type.group}`), `${lng} ${type.group}`).toBe(
          "string",
        );
      }
  });
});

describe("Change log in Amministrazione", () => {
  it("il giornale per giorni: la frase dal template, il prima/dopo, il codice del progetto", async () => {
    renderRoute("/admin/changelog", ROBERTA);
    await heading("Change log");
    await waitFor(() => expect(entries().length).toBeGreaterThan(0));
    // Tutte le voci del seme, più recenti in alto, raggruppate per giorno.
    expect(entries()).toHaveLength(state.changelog.length);
    expect(screen.getByRole("heading", { level: 2, name: "Changes on Today" })).toBeInTheDocument();
    const grant = entries().find((e) =>
      e.textContent?.includes("gave Marco Bellini permission to start a server fix in ACQ"),
    )!;
    expect(grant.querySelector("p")!.textContent).toBe(
      "Roberta Fontana gave Marco Bellini permission to start a server fix in ACQ.",
    );
    expect(grant).toHaveTextContent("Developer → Developer + start a server fix");
    expect(within(grant).getByTitle("Project ACQ")).toHaveTextContent("ACQ");
    // Marco è ancora membro di ACQ: il nome apre il suo pannello in Members.
    expect(within(grant).getByRole("link", { name: "Marco Bellini" })).toHaveAttribute(
      "href",
      "/p/ACQ/settings/members?member=p-marco",
    );
    // Un ruolo eliminato resta col nome, «(deleted)», senza link.
    const deleted = entries().find((e) => e.dataset.changeEntry === "role.deleted")!;
    expect(deleted).toHaveTextContent("deleted the role Reviewer (deleted).");
    expect(within(deleted).queryByRole("link")).toBeNull();
    // Nessuna azione sulle voci: niente «⋯», nessun bottone se non «Show details».
    for (const e of entries())
      for (const b of within(e).queryAllByRole("button"))
        expect(b.textContent).toMatch(/^(Show|Hide) details$/);
  });

  it("Show details apre prima e dopo dei permessi di un ruolo, in posto", async () => {
    const user = userEvent.setup();
    renderRoute("/admin/changelog", ROBERTA);
    await heading("Change log");
    const role = await waitFor(() => {
      const e = entries().find((x) => x.textContent?.includes("changed the role Auditor"));
      expect(e).toBeDefined();
      return e!;
    });
    expect(role).toHaveTextContent("+ read the change log");
    const button = within(role).getByRole("button", { name: "Show details" });
    await user.click(button);
    expect(button).toHaveTextContent("Hide details");
    expect(button).toHaveFocus();
    const before = within(role).getByRole("heading", { name: "Before" }).parentElement!;
    const after = within(role).getByRole("heading", { name: "After" }).parentElement!;
    expect(before).toHaveTextContent("View usage");
    expect(before).not.toHaveTextContent("Read the change log");
    expect(after).toHaveTextContent("+ Read the change log");
  });

  it("filtra per persona (dal menu), progetto, tipo e periodo; «Clear filters» toglie tutto", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/admin/changelog", ROBERTA);
    await heading("Change log");
    await waitFor(() => expect(entries().length).toBe(state.changelog.length));
    const filters = screen.getByRole("group", { name: "Change log filters" });

    // Persona, dal menu con la ricerca.
    await user.click(within(filters).getByRole("button", { name: "Person" }));
    await user.type(screen.getByRole("searchbox", { name: "Find a person" }), "laura");
    await user.click(screen.getByRole("menuitemradio", { name: "Laura Costa" }));
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ actor: LAURA }),
    );
    const laura = state.changelog.filter((e) => e.actorId === LAURA).length;
    await waitFor(() => expect(entries()).toHaveLength(laura));
    expect(sentences().every((s) => s.startsWith("Laura Costa "))).toBe(true);

    // «Clear filters» riporta tutto.
    await user.click(within(filters).getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(entries()).toHaveLength(state.changelog.length));
  });

  it("i filtri stanno nell'indirizzo: progetto, solo istanza, tipo, periodo", async () => {
    const count = async (path: string, expected: number) => {
      document.body.innerHTML = "";
      renderRoute(path, ROBERTA);
      await heading("Change log");
      await waitFor(() => expect(entries()).toHaveLength(expected));
    };
    const acq = state.changelog.filter((e) => e.projectId === ACQ);
    await count("/admin/changelog?project=ACQ", acq.length);
    expect(entries().every((e) => within(e).queryByTitle("Project ACQ"))).toBe(true);
    await count(
      "/admin/changelog?project=instance",
      state.changelog.filter((e) => e.projectId === null).length,
    );
    expect(document.querySelector("[title^='Project ']")).toBeNull();
    await count(
      "/admin/changelog?kind=security",
      state.changelog.filter((e) =>
        ["person.password_reset_link_created", "person.second_factor_reset"].includes(e.kind),
      ).length,
    );
    // Gli ultimi 7 giorni dall'«adesso» del prototipo (23 ott, 12:00).
    const since = Date.parse("2026-10-23T12:00:00Z") - 7 * 86_400_000;
    await count(
      "/admin/changelog?period=7d",
      state.changelog.filter((e) => Date.parse(e.at) >= since).length,
    );
    // Un periodo scelto a mano, estremi compresi.
    await count(
      "/admin/changelog?period=custom&since=2026-10-03&until=2026-10-03",
      state.changelog.filter((e) => e.at.startsWith("2026-10-03")).length,
    );
    // Nessuna voce: la frase e «Clear filters».
    document.body.innerHTML = "";
    renderRoute("/admin/changelog?actor=p-sara", ROBERTA);
    expect(await screen.findByText("No changes match these filters.")).toBeInTheDocument();
    // Un progetto che chi guarda non vede è come uno che non c'è: nessuna
    // voce, non «filtro ignorato, tutto». Laura non è in MKX.
    document.body.innerHTML = "";
    renderRoute("/admin/changelog?project=MKX", LAURA);
    expect(await screen.findByText("No changes match these filters.")).toBeInTheDocument();
    expect(entries()).toHaveLength(0);
  });

  it("nessun segreto: il reset dice che il link è nato, mai il link (RF 2)", async () => {
    setSessionPersonId(ROBERTA);
    markReauthenticated(ROBERTA);
    const result = await admin.createPasswordResetLink("p-marco");
    if (!result.ok) throw new Error("reset refused");
    renderRoute("/admin/changelog", ROBERTA);
    await heading("Change log");
    const reset = await waitFor(() => {
      const e = entries().find(
        (x) => x.textContent === `12:00Roberta Fontana created a password reset link for Marco Bellini.`,
      );
      expect(e).toBeDefined();
      return e!;
    });
    // Niente seconda riga sulle voci dei segreti.
    expect(reset.querySelectorAll("p")).toHaveLength(1);
    expect(document.body.textContent).not.toContain(result.link);
    expect(document.body.innerHTML).not.toContain(result.link);
  });

  it("le frasi del 9b leggono i parametri della voce (kind, provider, ref, check, scope), in inglese e in italiano", async () => {
    // Un oggetto di tipo neutro: niente link né «(deleted)», qui conta solo la frase.
    const write = (kind: string, label: string, params: Record<string, string>) =>
      recordChange({
        kind,
        actorId: ROBERTA,
        projectId: null,
        object: { type: "test", id: `x-${label}`, label },
        params,
      });
    write("provider.created", "Team Max 2", { kind: "subscription" });
    write("provider.created", "Spare key", { kind: "api_key" });
    write("git_account.created", "GitHub Release", { provider: "GitHub" });
    write("plugin.registered", "superpowers", { ref: "v4.0.3" });
    write("server.created", "SRV-7", { scope: "orphan" });
    write("server.created", "SRV-8", { scope: "project" });
    write("server.check_changed", "SRV-2", { check: "HTTP /health" });
    const expected = {
      en: [
        "Roberta Fontana changed the check “HTTP /health” on SRV-2.",
        "Roberta Fontana created the server SRV-8.",
        "Roberta Fontana created the server SRV-7 (not in any project).",
        "Roberta Fontana registered the plugin superpowers at v4.0.3.",
        "Roberta Fontana added the git account GitHub Release (GitHub).",
        "Roberta Fontana added the AI account Spare key (API key).",
        "Roberta Fontana added the AI account Team Max 2 (subscription).",
      ],
      it: [
        "Roberta Fontana ha modificato il controllo “HTTP /health” su SRV-2.",
        "Roberta Fontana ha creato il server SRV-8.",
        "Roberta Fontana ha creato il server SRV-7 (in nessun progetto).",
        "Roberta Fontana ha registrato il plugin superpowers a v4.0.3.",
        "Roberta Fontana ha aggiunto l'account git GitHub Release (GitHub).",
        "Roberta Fontana ha aggiunto l'account AI Spare key (chiave API).",
        "Roberta Fontana ha aggiunto l'account AI Team Max 2 (abbonamento).",
      ],
    };
    const nineB = () =>
      sentences().filter((_, i) =>
        /^(provider|git_account|plugin|server)\./.test(entries()[i]!.dataset.changeEntry!),
      );
    renderRoute("/admin/changelog", ROBERTA);
    await heading("Change log");
    await waitFor(() => expect(nineB()).toEqual(expected.en));
    act(() => setLanguage("it"));
    await waitFor(() => expect(nineB()).toEqual(expected.it));
  });

  it("le voci d'istanza del 9b: l'oggetto porta alla sua voce dell'Amministrazione o al server", async () => {
    recordChange({
      kind: "provider.updated",
      actorId: ROBERTA,
      projectId: null,
      object: { type: "provider", id: "prv-backup-max", label: "Backup Max" },
      before: "On",
      after: "Off",
    });
    recordChange({
      kind: "server.thresholds_changed",
      actorId: ROBERTA,
      projectId: null,
      object: { type: "server", id: "SRV-1", label: "SRV-1" },
      before: "CPU 85%",
      after: "CPU 90%",
    });
    renderRoute("/admin/changelog", ROBERTA);
    await heading("Change log");
    const provider = await waitFor(() => {
      const e = entries().find((x) => x.dataset.changeEntry === "provider.updated");
      expect(e).toBeDefined();
      return e!;
    });
    expect(provider.querySelector("p")!.textContent).toBe(
      "Roberta Fontana changed the AI account Backup Max.",
    );
    expect(within(provider).getByRole("link", { name: "Backup Max" })).toHaveAttribute(
      "href",
      "/admin/ai",
    );
    expect(provider).toHaveTextContent("On → Off");
    const server = entries().find((x) => x.dataset.changeEntry === "server.thresholds_changed")!;
    expect(within(server).getByRole("link", { name: "SRV-1" })).toHaveAttribute(
      "href",
      "/admin/servers",
    );
    expect(server).toHaveTextContent("CPU 85% → CPU 90%");
  });

  it("chi non ha changelog.view legge ciò che gestisce, e la riga lo dice", async () => {
    renderRoute("/admin/changelog", LAURA);
    await heading("Change log");
    // Chi gestisce un progetto ne legge tutte le voci di progetto: dal 9b
    // anche quelle della coda (pausa, ripresa, Retry).
    expect(
      screen.getByText(
        "You see changes to what you manage: project members and project queues. Entries can't be edited or deleted.",
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(entries().length).toBeGreaterThan(0));
    expect(entries().every((e) => e.dataset.changeEntry!.startsWith("member."))).toBe(true);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Type" }));
    expect(screen.getAllByRole("menuitemradio").map((m) => m.textContent)).toEqual([
      "Members",
      "Queue",
    ]);
  });
});

describe("Change log del progetto", () => {
  it("Laura in ACQ: solo le voci di ACQ, senza il codice a destra", async () => {
    renderRoute("/p/ACQ/settings/changelog", LAURA);
    await heading("Change log");
    expect(screen.getByText("Changes to ACQ's members and settings.")).toBeInTheDocument();
    const acq = state.changelog.filter((e) => e.projectId === ACQ).length;
    await waitFor(() => expect(entries()).toHaveLength(acq));
    expect(document.querySelector("[title='Project ACQ']")).toBeNull();
    // Nessun filtro Project: è sempre lo stesso.
    const filters = screen.getByRole("group", { name: "Change log filters" });
    expect(within(filters).queryByRole("button", { name: "Project" })).toBeNull();
    const sub = screen.getByRole("list", { name: "Settings of ACQ" });
    expect(within(sub).getByRole("link", { name: "Change log" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("chi non gestisce il progetto né i membri non la vede: niente voce, l'indirizzo apre Statuses", async () => {
    const router = renderRoute("/p/ACQ/settings/changelog", SARA);
    await heading("Statuses");
    expect(router.state.location.pathname).toBe("/p/ACQ/settings/statuses");
    const sub = screen.getByRole("list", { name: "Settings of ACQ" });
    expect(within(sub).queryByRole("link", { name: "Change log" })).toBeNull();
  });
});

/** Chi può `perm` in ACQ secondo `can()`, fra le persone che `viewerId` vede (R-G5). */
const holders = (viewerId: string, perm: string, projectId?: string) =>
  [...visiblePeopleFor(viewerId)]
    .filter((id) => can(viewerFor(id), perm as Permission, projectId))
    .map(nameOf)
    .sort();

describe("Who can?", () => {
  it("da un'azione: una riga per persona, col perché; Claude a parte", async () => {
    renderRoute("/admin/who-can?action=approvePlan&project=ACQ", ROBERTA);
    await heading("Who can?");
    const list = await screen.findByRole("list", { name: "Who can approve a plan" });
    const rows = within(list).getAllByRole("listitem");
    const names = rows.map((r) => within(r).getByRole("link").textContent!);
    expect([...names].sort()).toEqual(holders(ROBERTA, "plans.approve", ACQ));
    expect(screen.getByText(`${names.length} people`)).toBeInTheDocument();
    const laura = rows.find((r) => r.dataset.whoRow === LAURA)!;
    expect(laura).toHaveTextContent("Project Lead role");
    const roberta = rows.find((r) => r.dataset.whoRow === ROBERTA)!;
    expect(roberta).toHaveTextContent("Full admin");
    // L'ordine: da un ruolo prima, full admin in fondo.
    expect(rows.at(-1)!.dataset.whoRow).toBe(ROBERTA);
    const claude = document.querySelector("[data-claude-row]")!;
    expect(claude).toHaveTextContent("Claude — can work, doesn't decide.");
    expect(claude).toHaveTextContent("Claude can't approve a plan.");
  });

  it("si sceglie l'azione dal menu in linea; un'azione d'istanza toglie il progetto", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/admin/who-can?project=ACQ", ROBERTA);
    await heading("Who can?");
    await user.click(screen.getByRole("button", { name: "Action: choose an action" }));
    const box = screen.getByRole("combobox", { name: "Find an action" });
    expect(box).toHaveFocus();
    await user.type(box, "start claude{Enter}");
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ action: "startRun", project: "ACQ" }),
    );
    expect(await screen.findByText("Claude can start Claude.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Action: start Claude/ }));
    await user.type(screen.getByRole("combobox", { name: "Find an action" }), "manage roles{Enter}");
    expect(await screen.findByRole("list", { name: "Who can manage roles" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Project:/ })).toBeNull();
    expect(screen.getByText("Claude can't manage roles.")).toBeInTheDocument();
  });

  it("da una persona: i permessi che ha con la fonte, e a richiesta quelli che non ha", async () => {
    const user = userEvent.setup();
    renderRoute("/admin/who-can?view=what&person=p-marco&project=ACQ", ROBERTA);
    await heading("Who can?");
    const fix = await waitFor(() => {
      const row = document.querySelector<HTMLElement>("[data-permission='servers.operate']");
      expect(row).not.toBeNull();
      return row!;
    });
    expect(fix).toHaveTextContent("given by Roberta Fontana on Oct 3");
    expect(document.querySelector("[data-permission='runs.start']")).toHaveTextContent(
      "Developer role",
    );
    expect(document.querySelector("[data-permission='plans.approve']")).toBeNull();
    await user.click(screen.getByRole("switch", { name: "Also show what Marco Bellini can't do" }));
    const missing = document.querySelector<HTMLElement>("[data-permission='plans.approve']")!;
    expect(missing.dataset.held).toBe("false");
    expect(missing).toHaveTextContent("Approve plans");
  });

  it("chi ha dato un permesso si legge per nome anche se chi guarda non lo vede (30 ott 2026)", async () => {
    // Una persona attiva che Laura non vede dà a Marco un permesso in ACQ.
    const unseen = (id: string) =>
      !PEOPLE.find((x) => x.id === id)!.isClaude && !visiblePeopleFor(LAURA).has(id);
    const giver = accessState().people.find((p) => p.status === "active" && unseen(p.personId))!
      .personId;
    writeAccess((s) => {
      s.grants.push({
        personId: "p-marco",
        projectId: ACQ,
        permission: "support.reply",
        grantedById: giver,
        at: "2026-10-20T10:00:00Z",
      });
    });
    renderRoute("/admin/who-can?view=what&person=p-marco&project=ACQ", LAURA);
    await heading("Who can?");
    const row = await waitFor(() => {
      const r = document.querySelector<HTMLElement>("[data-permission='support.reply']");
      expect(r).not.toBeNull();
      return r!;
    });
    expect(row).toHaveTextContent(`given by ${nameOf(giver)} on Oct 20`);
    expect(row).not.toHaveTextContent("given by hand");
  });

  it("Claude: la frase fissa, CAN e NEVER, nessuna fonte", async () => {
    renderRoute("/admin/who-can?view=what&person=p-claude&project=ACQ", ROBERTA);
    await heading("Who can?");
    expect(await screen.findByText("Claude can work but doesn't decide.")).toBeInTheDocument();
    const can_ = screen.getByRole("heading", { level: 2, name: "Can" }).parentElement!;
    const never = screen.getByRole("heading", { level: 2, name: "Never" }).parentElement!;
    expect(can_).toHaveTextContent("Start Claude");
    expect(never).toHaveTextContent("Approve plans");
    expect(never).toHaveTextContent("Merge pull requests");
    expect(can_).not.toHaveTextContent("role");
  });

  it("R-G5: un progetto che Sara non vede è come uno che non esiste", async () => {
    renderRoute("/admin/who-can?action=approvePlan&project=AUD", SARA);
    await heading("Who can?");
    expect(await screen.findByText("Pick a project.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Project: Choose a project" })).toBeInTheDocument();
    expect(screen.queryByText(/AUD/)).toBeNull();
    expect(screen.queryByRole("list", { name: /Who can/ })).toBeNull();
  });
});

describe("«Who?» accanto a un bottone spento", () => {
  it("Sara in ACQ: le persone di ACQ che vede e il perché, sul posto; Esc rende il fuoco", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/p/ACQ/settings/statuses", SARA);
    await heading("Statuses");
    expect(
      await screen.findByText(/Only people who manage this project's settings can change them\./),
    ).toBeInTheDocument();
    const who = screen.getByRole("button", { name: "Who can change the project settings?" });
    expect(who).toHaveTextContent("Who?");
    await user.click(who);
    const pop = await screen.findByRole("dialog", {
      name: "Who can change the project settings in ACQ",
    });
    await waitFor(() => expect(pop.querySelectorAll("[data-who-row]").length).toBeGreaterThan(0));
    const shown = [...pop.querySelectorAll<HTMLElement>("[data-who-row]")].map(
      (r) => r.dataset.whoRow!,
    );
    // Le stesse di `can()`, fra le persone che Sara vede: nessuno di più, nessuno di meno.
    expect(shown.map(nameOf).sort()).toEqual(holders(SARA, "project.settings.manage", ACQ));
    const visible = visiblePeopleFor(SARA);
    expect(shown.every((id) => visible.has(id))).toBe(true);
    expect(pop).toHaveTextContent("Laura Costa");
    expect(pop).toHaveTextContent("Project Lead role");
    // Sul posto: l'indirizzo non è cambiato.
    expect(router.state.location.pathname).toBe("/p/ACQ/settings/statuses");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(who).toHaveFocus();
  });

  it("«Open in Who can?» porta alla domanda già scritta", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/p/ACQ/settings/statuses", SARA);
    await heading("Statuses");
    await user.click(await screen.findByRole("button", { name: "Who can change the project settings?" }));
    await user.click(await screen.findByRole("link", { name: "Open in Who can?" }));
    await heading("Who can?");
    expect(router.state.location.pathname).toBe("/admin/who-can");
    expect(router.state.location.search).toMatchObject({
      action: "manageProjectSettings",
      project: "ACQ",
    });
    expect(
      await screen.findByRole("list", { name: "Who can change the project settings" }),
    ).toBeInTheDocument();
  });
});

describe("⌘K «Who can …»", () => {
  it("«who can approve plans» in ACQ: «Who can approve plans in ACQ», Invio apre la domanda", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/p/ACQ/overview", ROBERTA);
    await screen.findByRole("heading", { level: 1 });
    await user.keyboard("{Control>}k{/Control}");
    const dialog = await screen.findByRole("dialog", { name: "Search and commands" });
    await user.type(within(dialog).getByRole("combobox"), "who can approve plans");
    const group = await within(dialog).findByRole("group", { name: "Who can?" });
    const option = within(group).getByRole("option", { name: "Who can approve plans in ACQ" });
    expect(option).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Enter}");
    await heading("Who can?");
    expect(router.state.location.search).toMatchObject({ action: "approvePlan", project: "ACQ" });
    expect(await screen.findByRole("list", { name: "Who can approve a plan" })).toBeInTheDocument();
  });

  it("in italiano: «chi può approvare»", async () => {
    act(() => setLanguage("it"));
    const user = userEvent.setup();
    renderRoute("/p/ACQ/overview", ROBERTA);
    await screen.findByRole("heading", { level: 1 });
    await user.keyboard("{Control>}k{/Control}");
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByRole("combobox"), "chi può approvare");
    const group = await within(dialog).findByRole("group", { name: "Chi può farlo?" });
    expect(within(group).getByRole("option", { name: "Chi può approvare i piani in ACQ" })).toBeInTheDocument();
  });
});
