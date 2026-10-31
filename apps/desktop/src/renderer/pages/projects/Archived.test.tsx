import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectSettings, resetApi, setLatency } from "../../data/api";
import { markReauthenticated } from "../../data/auth/reauth";
import { setSessionPersonId } from "../../data/session";
import { state } from "../../data/store";
import i18n from "../../i18n";
import { formatDate } from "../../notifications/time";
import { resetReauthForTest } from "../../layout/useReauth";
import { clearToasts } from "../../tasks-ui/Toast";
import { renderRoute } from "../../test/renderRoute";

// All projects → Archived, la pagina dell'archiviato, Reopen e Delete (area
// 9c, Task 11, shape project-archive.md). RNC è l'archiviato del seme
// (archiviato da Roberta). Giulia è Project Lead di RNC (riapre, non
// elimina); Roberta è full admin (elimina); Sara e Laura non ne erano
// membri (per loro RNC non esiste, R-G5).

const GIULIA = "p-giulia";
const ROBERTA = "p-roberta";
const SARA = "p-sara";
const LAURA = "p-laura";
const RNC = "prj-rnc";

beforeEach(() => {
  setLatency(0);
  resetApi();
});
afterEach(async () => {
  clearToasts();
  resetReauthForTest();
  resetApi();
  await i18n.changeLanguage("en");
});

const archivedOn = () => formatDate(state.projectsById.get(RNC)!.archived!.at, "en");
const rail = () => screen.getAllByRole("navigation")[0]!;
/** Giulia aveva fissato RNC prima dell'archiviazione: il fissato resta, nascosto finché è archiviato. */
const pinRnc = () => state.pinned.get(GIULIA)!.push(RNC);

async function openArchived(personId: string) {
  const router = renderRoute("/projects?view=archived", personId);
  await screen.findByRole("heading", { level: 1, name: /All projects/ });
  return router;
}

async function openPage(personId: string, code = "RNC") {
  const router = renderRoute(`/archived/${code}`, personId);
  await screen.findByRole("heading", { level: 1 });
  return router;
}

/** La riconferma del prototipo: il codice, poi l'azione riparte da sola. */
async function reauth(user: UserEvent) {
  const confirm = await screen.findByRole("dialog", { name: "Confirm it's you" });
  await user.type(within(confirm).getByLabelText("Code"), "123456");
}

describe("All projects → Archived", () => {
  it("Giulia: la scheda col numero, RNC con Reopen acceso e Delete spento con «Who?»", async () => {
    const user = userEvent.setup();
    await openArchived(GIULIA);
    const tab = await screen.findByRole("tab", { name: /Archived/ });
    expect(tab).toHaveAttribute("aria-selected", "true");
    expect(tab).toHaveTextContent("Archived1");
    const panel = screen.getByRole("tabpanel");
    expect(
      await within(panel).findByText(
        "Projects that are over. You can read them; reopen one to work in it again.",
      ),
    ).toBeVisible();
    const row = within(panel).getByRole("listitem");
    expect(row).toHaveTextContent("RNC");
    expect(row).toHaveTextContent("Vetrina online Tenuta Ronchi");
    expect(row).toHaveTextContent("Tenuta Ronchi Srl");
    expect(row).toHaveTextContent(`Archived ${archivedOn()} by Roberta Fontana`);
    expect(within(row).getByRole("link", { name: /RNC/ })).toHaveAttribute("href", "/archived/RNC");
    expect(within(row).getByRole("button", { name: "Reopen" })).not.toHaveAttribute(
      "aria-disabled",
    );

    const more = within(row).getByRole("button", { name: "More for RNC" });
    await user.click(more);
    const menu = screen.getByRole("menu");
    const item = within(menu).getByRole("menuitem", { name: /Delete for good…/ });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).toHaveTextContent("Only a full admin can delete a project.");
    expect(within(menu).getByRole("menuitem", { name: /Who/ })).toHaveAttribute(
      "data-who-can",
      "deleteProjects",
    );
    // Un clic sulla voce spenta non apre niente.
    await user.click(item);
    expect(screen.queryByRole("dialog", { name: /Delete/ })).toBeNull();
    await user.keyboard("{Escape}");
    expect(more).toHaveFocus();
  });

  it("Reopen dalla riga: RNC torna nel binario, la riga sparisce e il fuoco va all'h1 (la scheda non c'è più)", async () => {
    const user = userEvent.setup();
    pinRnc();
    const router = await openArchived(GIULIA);
    const row = await within(screen.getByRole("tabpanel")).findByRole("listitem");
    expect(rail()).not.toHaveTextContent(/RNC/);
    await user.click(within(row).getByRole("button", { name: "Reopen" }));
    const dialog = await screen.findByRole("dialog", { name: "Reopen RNC?" });
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(dialog).toHaveTextContent(
      "It comes back in the rail, All projects, ⌘K and Home for its members.",
    );
    expect(dialog).toHaveTextContent("Its settings are as they were.");
    expect(dialog).toHaveTextContent(
      "Automations start again from new events: what happened while it was archived isn't caught up.",
    );
    expect(dialog).toHaveTextContent("Notifications its members had come back.");
    await user.click(within(dialog).getByRole("button", { name: "Reopen" }));

    expect(await screen.findByText("RNC is open again.")).toBeVisible();
    expect(router.state.location.pathname).toBe("/projects");
    await waitFor(() => expect(screen.queryByRole("tab", { name: /Archived/ })).toBeNull());
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1, name: /All projects/ })).toHaveFocus(),
    );
    await waitFor(() => expect(rail()).toHaveTextContent(/RNC/));
    expect(state.projectsById.get(RNC)!.archived).toBeNull();
  });

  it("Reopen della prima riga con un'altra sotto: il fuoco va alla riga dopo", async () => {
    const user = userEvent.setup();
    setSessionPersonId(ROBERTA);
    expect(await projectSettings.archiveProject("prj-cbv")).toEqual({ ok: true });
    await openArchived(ROBERTA);
    const panel = screen.getByRole("tabpanel");
    const [first] = await within(panel).findAllByRole("listitem");
    // Il più recente in alto: CBV, appena archiviato.
    expect(first).toHaveTextContent("CBV");
    await user.click(within(first!).getByRole("button", { name: "Reopen" }));
    const dialog = await screen.findByRole("dialog", { name: "Reopen CBV?" });
    await user.click(within(dialog).getByRole("button", { name: "Reopen" }));
    await screen.findByText("CBV is open again.");
    await waitFor(() =>
      expect(within(panel).getByRole("link", { name: /RNC/ })).toHaveFocus(),
    );
    expect(screen.getByRole("tab", { name: /Archived/ })).toHaveTextContent("Archived1");
  });

  it("Sara: niente scheda; `?view=archived` apre Projects", async () => {
    await openArchived(SARA);
    await screen.findByRole("tab", { name: "Projects" });
    expect(screen.getByRole("tab", { name: "Projects" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("tab", { name: /Archived/ })).toBeNull();
    expect(document.body.innerHTML).not.toMatch(/RNC|Ronchi|prj-rnc/);
  });
});

describe("la pagina dell'archiviato", () => {
  it("Giulia legge RNC in sola lettura: sintesi, membri, conteggi, repository, alla riapertura", async () => {
    await openPage(GIULIA);
    const page = screen.getByRole("main");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "RNCVetrina online Tenuta Ronchi",
    );
    expect(page).toHaveTextContent("Tenuta Ronchi Srl");
    expect(page).toHaveTextContent(
      `Archived on ${archivedOn()} by Roberta Fontana. Read only: reopen it to work in it again.`,
    );
    expect(within(page).getByRole("link", { name: "← Archived" })).toHaveAttribute(
      "href",
      "/projects?view=archived",
    );

    const summary = screen.getByRole("region", { name: "Summary" });
    expect(summary).toHaveTextContent("winery");
    const members = screen.getByRole("region", { name: "Members" });
    expect(within(members).getByText("Giulia Ferri").closest("li")).toHaveTextContent(
      "Project Lead",
    );
    expect(members).toHaveTextContent("Full admins can read it too.");
    const counts = screen.getByRole("region", { name: "What's in it" });
    const count = (label: string) =>
      within(counts).getByText(label).closest("[data-count]")!.textContent;
    expect(count("Tasks")).toBe("Tasks6");
    expect(count("Drive files")).toBe("Drive files3");
    // Gli zeri restano: dicono che non c'è niente.
    expect(count("Automations")).toBe("Automations0");
    expect(counts).toHaveTextContent("To open them, reopen the project.");
    const repos = screen.getByRole("region", { name: "Repositories" });
    expect(repos).toHaveTextContent("shop-frontend");
    expect(repos).toHaveTextContent(
      "If RNC is deleted, these stay without a project and can be linked to another one.",
    );
    expect(screen.getByRole("region", { name: "When reopened" })).toHaveTextContent(
      "These come back on: Backlog discovery, Pulse every 7 days, Weekly brief. Docs updated every night and Daily report stay off.",
    );

    // Sola lettura: nessun campo, e i soli bottoni sono Reopen, Delete e i loro «Who?».
    expect(within(page).queryByRole("textbox")).toBeNull();
    expect(within(page).queryByRole("checkbox")).toBeNull();
    const buttons = within(page)
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(buttons).toEqual(["Reopen", "Who?", "Delete for good…"]);
    const del = within(page).getByRole("button", { name: "Delete for good…" });
    expect(del).toHaveAttribute("aria-disabled", "true");
    expect(within(page).getByRole("button", { name: /Who/ })).toHaveAttribute(
      "data-who-can",
      "deleteProjects",
    );
    expect(document.getElementById(del.getAttribute("aria-describedby")!)).toHaveTextContent(
      "Only a full admin can delete a project.",
    );
  });

  it("Reopen da Giulia: si va a /p/RNC, e RNC torna nel binario", async () => {
    const user = userEvent.setup();
    pinRnc();
    const router = await openPage(GIULIA);
    expect(rail()).not.toHaveTextContent(/RNC/);
    await user.click(screen.getByRole("button", { name: "Reopen" }));
    const dialog = await screen.findByRole("dialog", { name: "Reopen RNC?" });
    await user.click(within(dialog).getByRole("button", { name: "Reopen" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/RNC/overview"));
    expect(await screen.findByText("RNC is open again.")).toBeVisible();
    await waitFor(() => expect(rail()).toHaveTextContent(/RNC/));
  });

  it("Sara: /archived/RNC è «not found» come un codice inesistente (RF 3)", async () => {
    await openPage(SARA, "ZZZ");
    const missing = screen.getByRole("main").innerHTML;
    cleanup();
    await openPage(SARA, "RNC");
    expect(screen.getByRole("main").innerHTML).toBe(missing.replaceAll("ZZZ", "RNC"));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Project not found");
    expect(document.body.innerHTML).not.toMatch(/Ronchi|prj-rnc/);
  });
});

describe("Delete for good, da Roberta", () => {
  it("conteggi, ciò che resta, il codice esatto, la riconferma, il toast, il ritorno e la voce del registro", async () => {
    const user = userEvent.setup();
    const router = await openPage(ROBERTA);
    await user.click(screen.getByRole("button", { name: "Delete for good…" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete RNC for good?" });
    const field = await within(dialog).findByLabelText("Type RNC to confirm");
    // Caricata l'anteprima, il fuoco va al campo del codice.
    await waitFor(() => expect(field).toHaveFocus());
    expect(dialog).toHaveTextContent("This can't be undone.");
    const deleted = within(dialog).getByRole("list", { name: "Deleted" });
    expect(
      within(deleted)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      "6 tasks",
      "2 requests",
      "2 Docs pages",
      "1 conversation",
      "1 channel and its messages",
      "3 Drive files",
      "1 environment",
      "1 environment file",
    ]);
    expect(dialog).toHaveTextContent("and its members, settings and notifications");
    const stays = within(dialog).getByRole("region", { name: "Stays without a project" });
    expect(stays).toHaveTextContent(
      "1 repository: shop-frontend. It keeps its address, git account and commands, and can be linked to another project from Administration → Repositories. Its environment files, Docs pages and pull requests go.",
    );
    expect(stays).toHaveTextContent(
      "1 server: SRV-5. It stays in Administration → Servers, not in any project.",
    );
    expect(dialog).toHaveTextContent(
      "The instance's change log keeps a line saying you deleted RNC.",
    );

    const submit = within(dialog).getByRole("button", { name: "Delete for good" });
    expect(submit).toBeDisabled();
    await user.type(field, "rnc");
    expect(submit).toBeDisabled();
    expect(dialog).toHaveTextContent("Type it exactly as shown: RNC.");
    await user.clear(field);
    await user.type(field, "RNC");
    expect(submit).toBeEnabled();
    await user.click(submit);
    await reauth(user);

    expect(
      await screen.findByText("RNC was deleted. 1 repository is now in no project."),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Open Repositories" })).toBeVisible();
    // Archived ora è vuota: la scheda sparisce, si torna a Projects col fuoco all'h1.
    await waitFor(() => expect(router.state.location.pathname).toBe("/projects"));
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1, name: /All projects/ })).toHaveFocus(),
    );
    expect(screen.queryByRole("tab", { name: /Archived/ })).toBeNull();
    expect(state.projectsById.get(RNC)).toBeUndefined();

    cleanup();
    renderRoute("/admin/changelog", ROBERTA);
    const entry = await waitFor(() => {
      const el = document.querySelector('[data-change-entry="project.deleted"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(entry).toHaveTextContent("1 repository is now in no project.");
  });

  it("dalla riga di Archived: un altro archiviato resta, il fuoco va al titolo della scheda", async () => {
    const user = userEvent.setup();
    // Un secondo archiviato, così la scheda resta dopo il Delete.
    setSessionPersonId(ROBERTA);
    expect(await projectSettings.archiveProject("prj-cbv")).toEqual({ ok: true });
    markReauthenticated(ROBERTA);
    await openArchived(ROBERTA);
    const panel = screen.getByRole("tabpanel");
    await within(panel).findByText("Vetrina online Tenuta Ronchi");
    const row = within(panel).getByText("Vetrina online Tenuta Ronchi").closest("li")!;
    const more = within(row).getByRole("button", { name: "More for RNC" });
    await user.click(more);
    await user.click(screen.getByRole("menuitem", { name: "Delete for good…" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete RNC for good?" });
    const field = await within(dialog).findByLabelText("Type RNC to confirm");
    await user.type(field, "RNC");
    await user.click(within(dialog).getByRole("button", { name: "Delete for good" }));
    expect(
      await screen.findByText("RNC was deleted. 1 repository is now in no project."),
    ).toBeVisible();
    await waitFor(() => expect(screen.getByRole("tab", { name: /Archived/ })).toHaveFocus());
    expect(screen.getByRole("tabpanel")).not.toHaveTextContent("Ronchi");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("CBV");
  });

  it("Cancel con un codice scritto chiede «Discard?»; senza, chiude e il fuoco torna al «⋯»", async () => {
    const user = userEvent.setup();
    await openArchived(ROBERTA);
    const row = await within(screen.getByRole("tabpanel")).findByRole("listitem");
    const more = within(row).getByRole("button", { name: "More for RNC" });
    await user.click(more);
    await user.click(screen.getByRole("menuitem", { name: "Delete for good…" }));
    let dialog = await screen.findByRole("dialog", { name: "Delete RNC for good?" });
    await user.type(await within(dialog).findByLabelText("Type RNC to confirm"), "RN");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(dialog).toHaveTextContent("Discard what you typed?");
    await user.click(within(dialog).getByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(more).toHaveFocus();

    await user.click(more);
    await user.click(screen.getByRole("menuitem", { name: "Delete for good…" }));
    dialog = await screen.findByRole("dialog", { name: "Delete RNC for good?" });
    await within(dialog).findByLabelText("Type RNC to confirm");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(more).toHaveFocus();
    expect(state.projectsById.get(RNC)).toBeDefined();
  });

  it("riaperto nel frattempo: «Nothing was deleted.» e si va a /p/RNC", async () => {
    const user = userEvent.setup();
    markReauthenticated(ROBERTA);
    const router = await openPage(ROBERTA);
    await user.click(screen.getByRole("button", { name: "Delete for good…" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete RNC for good?" });
    await user.type(await within(dialog).findByLabelText("Type RNC to confirm"), "RNC");
    setSessionPersonId(GIULIA);
    expect(await projectSettings.reopenProject(RNC)).toEqual({ ok: true });
    setSessionPersonId(ROBERTA);
    await user.click(within(dialog).getByRole("button", { name: "Delete for good" }));
    expect(
      await screen.findByText("RNC was reopened in the meantime. Nothing was deleted."),
    ).toBeVisible();
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/RNC/overview"));
    expect(state.projectsById.get(RNC)).toBeDefined();
  });

  it("Laura, che non ne era membro, non trova RNC da nessuna parte nella scheda", async () => {
    await openArchived(LAURA);
    await screen.findByRole("tab", { name: "Projects" });
    expect(document.body.innerHTML).not.toMatch(/RNC|Ronchi|prj-rnc/);
  });
});
