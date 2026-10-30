import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { admin, resetApi, setLatency } from "../../data/api";
import { markReauthenticated } from "../../data/auth/reauth";
import { setSessionPersonId } from "../../data/session";
import { accessState, writeAccess } from "../../data/access/index";
import { adminSections, administersSomething, canSeeAdmin } from "../../data/adminSections";
import { state } from "../../data/store";
import {
  grantInstancePermission,
  viewerFor,
  type LocalInstancePermission,
} from "../../data/viewer";
import { CLAUDE_ID } from "../../data/seed/people";
import i18n from "../../i18n";
import { resetReauthForTest } from "../../layout/useReauth";
import { renderRoute } from "../../test/renderRoute";
import { reasonWords } from "./parts";

// L'Amministrazione: intelaiatura, People, la pagina di una persona,
// disattiva/riattiva, gli inviti (area 9a, Task 8, shape admin-people.md).
// Persone del seme: Roberta (full admin), Laura (Project Lead), Marco
// (Developer), Sara (Contributor, senza secondo fattore), Simone
// (disattivato), Giulia (Project Lead, la persona di partenza).

const ROBERTA = "p-roberta";
const LAURA = "p-laura";
const MARCO = "p-marco";
const SARA = "p-sara";
const GIULIA = "p-giulia";

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
const column = () => screen.getByRole("navigation", { name: "Administration sections" });
const peopleList = () => screen.getByRole("list", { name: "People" });
/** Un permesso d'istanza a una persona (scorciatoia dei test, come nel livello dati). */
const give = (personId: string, perm: string) =>
  grantInstancePermission(personId, perm as LocalInstancePermission);

/** Il dialogo «Confirm it's you»: il codice del prototipo, e l'azione riparte da sola. */
async function confirmItsYou(user: ReturnType<typeof userEvent.setup>) {
  const dialog = await screen.findByRole("dialog", { name: "Confirm it's you" });
  await user.type(within(dialog).getByLabelText("Code"), "123456");
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Confirm it's you" })).toBeNull(),
  );
}

async function openProfile(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Profile and settings" }));
  return screen.findByRole("dialog", { name: "Profile and settings" });
}

describe("intelaiatura: ogni voce col suo permesso", () => {
  it("il full admin vede le cinque voci, in due gruppi; /admin apre People", async () => {
    const router = renderRoute("/admin", ROBERTA);
    expect(await heading("People")).toBeVisible();
    expect(router.state.location.pathname).toBe("/admin/people");
    expect(
      within(column())
        .getAllByRole("link")
        .map((l) => l.textContent?.replace(/\d+$/, "")),
    ).toEqual(["People", "Departments", "Roles", "Change log", "Who can?"]);
    expect(within(column()).getByText("Access")).toBeVisible();
    expect(within(column()).getByText("Records")).toBeVisible();
  });

  it("Sara (nessuna gestione): People e Who can?, e nel profilo la voce si chiama «People»", async () => {
    const user = userEvent.setup();
    renderRoute("/admin/people", SARA);
    await heading("People");
    expect(
      within(column())
        .getAllByRole("link")
        .map((l) => l.textContent?.replace(/\d+$/, "")),
    ).toEqual(["People", "Who can?"]);
    expect(within(column()).queryByText("Access")).toBeVisible();
    const menu = await openProfile(user);
    expect(within(menu).getByRole("link", { name: "People" })).toHaveAttribute("href", "/admin");
    expect(within(menu).queryByRole("link", { name: "Administration" })).toBeNull();
    // Niente «Invite someone» senza `users.invite`.
    expect(screen.queryByRole("button", { name: "Invite someone" })).toBeNull();
  });

  it("Giulia (Project Lead): il Change log per i membri che gestisce, e la voce «Administration»", async () => {
    const user = userEvent.setup();
    renderRoute("/admin/people", GIULIA);
    await heading("People");
    expect(
      within(column())
        .getAllByRole("link")
        .map((l) => l.textContent?.replace(/\d+$/, "")),
    ).toEqual(["People", "Change log", "Who can?"]);
    const menu = await openProfile(user);
    expect(within(menu).getByRole("link", { name: "Administration" })).toBeVisible();
  });

  it("una voce aperta per indirizzo senza permesso è «not found», non un divieto", async () => {
    renderRoute("/admin/roles", SARA);
    expect(await heading("Page not found")).toBeVisible();
  });

  it("ogni voce secondo il suo permesso: Departments con departments.manage, Roles con roles.manage", () => {
    const ids = (personId: string) => adminSections(viewerFor(personId)).map((s) => s.id);
    expect(ids(MARCO)).toEqual(["people", "who-can"]);
    expect(administersSomething(viewerFor(MARCO))).toBe(false);
    // Chi gestisce i reparti ne legge anche le voci del registro.
    grantInstancePermission(MARCO, "departments.manage");
    expect(ids(MARCO)).toEqual(["people", "departments", "changelog", "who-can"]);
    expect(administersSomething(viewerFor(MARCO))).toBe(true);
    // `changelog.view` da solo: il registro, nient'altro.
    grantInstancePermission(SARA, "changelog.view");
    expect(ids(SARA)).toEqual(["people", "changelog", "who-can"]);
    give("p-alessia", "roles.manage");
    expect(ids("p-alessia")).toEqual(["people", "roles", "changelog", "who-can"]);
  });

  it("senza voci (Claude, una persona disattivata) l'Amministrazione non c'è", () => {
    expect(canSeeAdmin(viewerFor(CLAUDE_ID))).toBe(false);
    expect(
      accessState().people.find((p) => p.personId === "p-simone")!.status,
    ).toBe("deactivated");
    expect(canSeeAdmin(viewerFor("p-simone"))).toBe(false);
    expect(adminSections(viewerFor("p-simone"))).toEqual([]);
  });
});

describe("People: l'elenco", () => {
  it("righe di persone con ruolo, email, reparti e progetti; gli inviti come righe «Invited»", async () => {
    renderRoute("/admin/people", ROBERTA);
    await heading("People");
    const marco = await within(peopleList()).findByRole("link", { name: /Marco Bellini/ });
    expect(marco).toHaveAttribute("href", "/admin/people/p-marco");
    expect(marco).toHaveTextContent("User");
    expect(marco).toHaveTextContent("Development");
    const invite = within(peopleList()).getByRole("link", { name: /ines\.ricci@example\.com/ });
    expect(invite).toHaveTextContent(/Invited · expires/);
    expect(invite).toHaveTextContent("STW as Developer");
    expect(invite).toHaveTextContent("by Roberta Fontana");
    expect(within(peopleList()).getByRole("link", { name: /kevin\.ortega/ })).toHaveTextContent(
      /Expired/,
    );
    // Di base attive e invitate: Simone (disattivato) non c'è.
    expect(within(peopleList()).queryByRole("link", { name: /Simone Rossetti/ })).toBeNull();
  });

  it("i filtri stanno nell'indirizzo: reparto e stato; la ricerca filtra mentre si scrive", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/admin/people?depts=dep-development&statuses=active", ROBERTA);
    await heading("People");
    await waitFor(() =>
      expect(
        within(peopleList())
          .getAllByRole("link")
          .map((l) => l.getAttribute("href")),
      ).toEqual([
        "/admin/people/p-alessia",
        "/admin/people/p-federico",
        "/admin/people/p-laura",
        "/admin/people/p-marco",
        "/admin/people/p-stefano",
      ]),
    );
    expect(screen.getByRole("button", { name: /Department: Development/ })).toBeVisible();
    await user.type(screen.getByLabelText("Find a person by name or email"), "mar");
    await waitFor(() =>
      expect(within(peopleList()).getAllByRole("link")).toHaveLength(1),
    );
    expect(router.state.location.search).toMatchObject({ find: "mar", depts: "dep-development" });
  });

  it("nessun risultato: lo dice, e «Clear filters» torna all'elenco di base", async () => {
    const user = userEvent.setup();
    renderRoute("/admin/people?find=nobody-here", ROBERTA);
    expect(await screen.findByText("No one matches these filters.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(await within(peopleList()).findByRole("link", { name: /Marco Bellini/ })).toBeVisible();
  });

  it("lo stato «Deactivated» mostra Simone, con la data", async () => {
    renderRoute("/admin/people?statuses=deactivated", ROBERTA);
    const simone = await within(await screen.findByRole("list", { name: "People" })).findByRole(
      "link",
      { name: /Simone Rossetti/ },
    );
    expect(simone).toHaveTextContent(/Deactivated/);
  });
});

describe("la pagina di una persona", () => {
  it("ruolo d'istanza, progetti, reparti, identità e registro; le azioni rare nel «⋯»", async () => {
    const user = userEvent.setup();
    renderRoute("/admin/people/p-marco", ROBERTA);
    expect(await heading("Marco Bellini")).toBeVisible();
    expect(screen.getByText("User — works in the projects they're a member of.")).toBeVisible();
    // Marco ha `servers.operate` su ACQ, dato da Roberta nel seme: la fonte in parole.
    expect(screen.getByText(/\+ start a server fix — given by Roberta Fontana on/)).toBeVisible();
    expect(screen.getByRole("heading", { level: 2, name: "Security log" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "More actions for Marco Bellini" }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "Reset password…",
      "Reset two-step verification…",
      "Deactivate…",
    ]);
  });

  it("senza users.manage: in sola lettura, senza «⋯» né registro", async () => {
    renderRoute("/admin/people/p-marco", SARA);
    expect(await heading("Marco Bellini")).toBeVisible();
    expect(screen.queryByRole("button", { name: /More actions/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Change…/ })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Security log" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Link a git email" })).toBeNull();
  });

  it("Claude e un id sconosciuto: «not found»", async () => {
    renderRoute(`/admin/people/${CLAUDE_ID}`, ROBERTA);
    expect(await heading("Page not found")).toBeVisible();
  });

  it("ruolo d'istanza con riconferma; il toast dice il ruolo nuovo", async () => {
    const user = userEvent.setup();
    renderRoute("/admin/people/p-marco", ROBERTA);
    await heading("Marco Bellini");
    await user.click(screen.getByRole("button", { name: /Change…/ }));
    await user.click(screen.getByRole("menuitemradio", { name: /Auditor/ }));
    await confirmItsYou(user);
    expect(await screen.findByText("Marco Bellini is now Auditor.")).toBeVisible();
    expect(
      accessState().people.find((p) => p.personId === MARCO)!.instanceRoleId,
    ).toBe("role-au-1");
  });

  it("su sé stessi: «Change…» spento col motivo, nessun «⋯»", async () => {
    renderRoute("/admin/people/p-roberta", ROBERTA);
    await heading("Roberta Fontana");
    expect(screen.getByRole("button", { name: /Change…/ })).toBeDisabled();
    expect(screen.getByText("You can't change your own instance role.")).toBeVisible();
    expect(screen.getByText("This is you. Your own settings are in Preferences.")).toBeVisible();
    expect(screen.queryByRole("button", { name: /More actions/ })).toBeNull();
  });

  it("i ruoli che contengono permessi che non si hanno sono spenti col motivo", async () => {
    const user = userEvent.setup();
    give(LAURA, "users.manage");
    renderRoute("/admin/people/p-marco", LAURA);
    await heading("Marco Bellini");
    await user.click(screen.getByRole("button", { name: /Change…/ }));
    const admin = screen.getByRole("menuitemradio", { name: /Admin/ });
    expect(admin).toHaveAttribute("aria-disabled", "true");
    expect(admin).toHaveTextContent("Includes permissions you don't have.");
    await user.click(admin);
    expect(screen.queryByRole("dialog", { name: "Confirm it's you" })).toBeNull();
  });

  it("reset della password: il link si vede una volta, «Done» lo dimentica", async () => {
    const user = userEvent.setup();
    renderRoute("/admin/people/p-marco", ROBERTA);
    await heading("Marco Bellini");
    await user.click(screen.getByRole("button", { name: "More actions for Marco Bellini" }));
    await user.click(screen.getByRole("menuitem", { name: "Reset password…" }));
    const dialog = screen.getByRole("dialog", {
      name: "Create a password reset link for Marco Bellini?",
    });
    await user.click(within(dialog).getByRole("button", { name: "Create link" }));
    await confirmItsYou(user);
    const secret = await screen.findByTestId("secret-once");
    const link = secret.querySelector("[data-secret-value]")!.textContent!;
    expect(link.length).toBeGreaterThan(10);
    expect(secret).toHaveTextContent(/works once · signs Marco Bellini out everywhere/);
    await user.click(within(secret).getByRole("button", { name: "Done" }));
    expect(screen.queryByTestId("secret-once")).toBeNull();
    expect(document.body.textContent).not.toContain(link);
    // Riaperto, il link di prima non c'è più: se ne crea un altro.
    await user.click(screen.getByRole("button", { name: "More actions for Marco Bellini" }));
    await user.click(screen.getByRole("menuitem", { name: "Reset password…" }));
    expect(screen.getByRole("button", { name: "Create link" })).toBeVisible();
    expect(document.body.textContent).not.toContain(link);
  });

  it("reset del secondo fattore: le conseguenze, la riconferma, e l'interessato riceve l'avviso", async () => {
    const user = userEvent.setup();
    renderRoute("/admin/people/p-marco", ROBERTA);
    await heading("Marco Bellini");
    const alerts = () =>
      state.notifications.filter(
        (n) => n.kind === "security.alert" && n.recipientIds.includes(MARCO),
      ).length;
    const before = alerts();
    await user.click(screen.getByRole("button", { name: "More actions for Marco Bellini" }));
    await user.click(screen.getByRole("menuitem", { name: "Reset two-step verification…" }));
    const dialog = screen.getByRole("dialog", {
      name: "Reset Marco Bellini's two-step verification?",
    });
    expect(dialog).toHaveTextContent("Marco Bellini gets a security alert.");
    await user.click(within(dialog).getByRole("button", { name: "Reset" }));
    await confirmItsYou(user);
    expect(
      await screen.findByText("Two-step verification reset for Marco Bellini."),
    ).toBeVisible();
    expect(alerts()).toBe(before + 1);
  });

  it("Sara senza secondo fattore: la voce è spenta col motivo", async () => {
    const user = userEvent.setup();
    renderRoute("/admin/people/p-sara", ROBERTA);
    await heading("Sara Montanari");
    await user.click(screen.getByRole("button", { name: "More actions for Sara Montanari" }));
    const item = screen.getByRole("menuitem", { name: /Reset two-step verification/ });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).toHaveTextContent("Sara Montanari hasn't set up two-step verification.");
  });

  it("identità git: collega un autore osservato, poi scollega con la riconferma", async () => {
    const user = userEvent.setup();
    renderRoute("/admin/people/p-marco", ROBERTA);
    await heading("Marco Bellini");
    await user.click(screen.getByRole("button", { name: "Link a git email" }));
    await user.type(screen.getByLabelText("Git email or observed author"), "kevin");
    const author = await screen.findByRole("button", { name: /kevin\.ortega/ });
    expect(author).toHaveTextContent(/commits? in/);
    await user.click(author);
    expect(await screen.findByText("kevin.ortega linked to Marco Bellini.")).toBeVisible();
    expect(state.commitAuthorLinks.get("kevin.ortega")).toBe(MARCO);
    const unlink = screen.getByRole("button", { name: "Unlink kevin.ortega" });
    await user.click(unlink);
    await user.click(screen.getByRole("button", { name: "Unlink — sure?" }));
    await confirmItsYou(user);
    expect(await screen.findByText("kevin.ortega unlinked from Marco Bellini.")).toBeVisible();
    expect(state.commitAuthorLinks.has("kevin.ortega")).toBe(false);
  });
});

describe("RF 4: disattiva con riassegnazione, poi riattiva", () => {
  it("il dialogo elenca le task aperte; una riassegnata, il toast lo dice; poi Reactivate", async () => {
    const user = userEvent.setup();
    renderRoute("/admin/people/p-marco", ROBERTA);
    await heading("Marco Bellini");
    await user.click(screen.getByRole("button", { name: "More actions for Marco Bellini" }));
    await user.click(screen.getByRole("menuitem", { name: "Deactivate…" }));
    const dialog = screen.getByRole("dialog", { name: "Deactivate Marco Bellini?" });
    expect(dialog).toHaveTextContent("Marco Bellini can't sign in.");
    const rows = within(dialog).getAllByRole("button", { name: /^Reassign .+ to:/ });
    expect(rows.length).toBeGreaterThan(1);
    // La prima task alla prima persona offerta; le altre restano a Marco.
    expect(rows[0]).toHaveTextContent("Leave with Marco Bellini");
    const code = /^Reassign (\S+) to:/.exec(rows[0]!.getAttribute("aria-label")!)![1]!;
    const others = rows.slice(1).map((r) => /^Reassign (\S+) to:/.exec(r.getAttribute("aria-label")!)![1]!);
    const assignee = (c: string) => state.tasks.find((x) => x.code === c)!.assigneeId;
    await user.click(rows[0]!);
    const options = screen.getAllByRole("menuitemradio");
    const target = options[1]!;
    const targetName = target.textContent!;
    await user.click(target);
    expect(rows[0]).toHaveTextContent(targetName);
    await user.click(within(dialog).getByRole("button", { name: "Deactivate" }));
    await confirmItsYou(user);
    expect(
      await screen.findByText(`Marco Bellini was deactivated. 1 task reassigned to ${targetName}.`),
    ).toBeVisible();
    expect(accessState().people.find((p) => p.personId === MARCO)!.status).toBe("deactivated");
    expect(assignee(code)).not.toBe(MARCO);
    for (const c of others) expect(assignee(c)).toBe(MARCO);
    expect(await screen.findByText(/Deactivated/)).toBeVisible();
    // Riattiva: conferma a due tempi nel «⋯», senza riconferma.
    await user.click(screen.getByRole("button", { name: "More actions for Marco Bellini" }));
    await user.click(screen.getByRole("menuitem", { name: "Reactivate" }));
    await user.click(screen.getByRole("menuitem", { name: "Reactivate — sure?" }));
    expect(await screen.findByText("Marco Bellini is active again.")).toBeVisible();
    expect(accessState().people.find((p) => p.personId === MARCO)!.status).toBe("active");
  });

  it("l'ultimo full admin non si disattiva: il bottone è spento col motivo", async () => {
    const user = userEvent.setup();
    // Laura con users.manage su Roberta, unica full admin.
    give(LAURA, "users.manage");
    renderRoute("/admin/people/p-roberta", LAURA);
    await heading("Roberta Fontana");
    await user.click(screen.getByRole("button", { name: "More actions for Roberta Fontana" }));
    await user.click(screen.getByRole("menuitem", { name: "Deactivate…" }));
    const dialog = screen.getByRole("dialog", { name: "Deactivate Roberta Fontana?" });
    expect(dialog).toHaveTextContent(
      "Roberta Fontana is the only full admin. Make someone else full admin first.",
    );
    expect(within(dialog).getByRole("button", { name: "Deactivate" })).toBeDisabled();
  });

  it("le task lasciate a Marco disattivato lo dicono: «Marco Bellini (deactivated)»", async () => {
    setSessionPersonId(ROBERTA);
    markReauthenticated(ROBERTA);
    expect(await admin.deactivatePerson(MARCO, {})).toMatchObject({ ok: true });
    renderRoute("/p/STW/tasks?task=STW-13", ROBERTA);
    const panel = await screen.findByRole("dialog", { name: "Task STW-13" });
    expect(await within(panel).findByText("Marco Bellini (deactivated)")).toBeVisible();
    // Anche la riga dell'elenco.
    const row = (await screen.findAllByText("Marco Bellini (deactivated)")).find(
      (el) => !panel.contains(el),
    );
    expect(row).toBeDefined();
  });
});

describe("reset del secondo fattore fra pari grado", () => {
  it("Roberta su un altro full admin vede la riga in più; Laura (users.manage) su Marco no", async () => {
    const user = userEvent.setup();
    writeAccess((s) => {
      s.people.find((p) => p.personId === GIULIA)!.instanceRoleId = "role-admin";
    });
    renderRoute("/admin/people/p-giulia", ROBERTA);
    await heading("Giulia Ferri");
    await user.click(screen.getByRole("button", { name: "More actions for Giulia Ferri" }));
    await user.click(screen.getByRole("menuitem", { name: "Reset two-step verification…" }));
    expect(
      screen.getByText(
        "This is recorded in the change log and Giulia Ferri is told who did it.",
      ),
    ).toBeVisible();
  });

  it("fra chi non è pari grado la riga non c'è", async () => {
    const user = userEvent.setup();
    give(LAURA, "users.manage");
    renderRoute("/admin/people/p-marco", LAURA);
    await heading("Marco Bellini");
    await user.click(screen.getByRole("button", { name: "More actions for Marco Bellini" }));
    await user.click(screen.getByRole("menuitem", { name: "Reset two-step verification…" }));
    const dialog = screen.getByRole("dialog", {
      name: "Reset Marco Bellini's two-step verification?",
    });
    expect(dialog).toHaveTextContent("Marco Bellini gets a security alert.");
    expect(dialog).not.toHaveTextContent(/recorded in the change log/);
  });
});

describe("inviti", () => {
  it("un invito sconosciuto è la pagina «not found»", async () => {
    renderRoute("/admin/people/invites/inv-nope", ROBERTA);
    expect(await heading("Page not found")).toBeVisible();
  });

  it("un ruolo di progetto oltre chi invita (stato cambiato nel frattempo): il rifiuto lo nomina", async () => {
    const user = userEvent.setup();
    give(LAURA, "users.invite");
    markReauthenticated(LAURA);
    renderRoute("/admin/people", LAURA);
    await heading("People");
    await user.click(screen.getByRole("button", { name: "Invite someone" }));
    const dialog = screen.getByRole("dialog", { name: "Invite someone" });
    await user.type(within(dialog).getByLabelText("Email"), "new.one@example.com");
    await user.click(within(dialog).getByRole("button", { name: /Add a project/ }));
    const first = within(screen.getByRole("menu")).getAllByRole("menuitem")[0]!;
    const code = first.textContent!.slice(0, 3);
    await user.click(first);
    // Nel frattempo a Laura si toglie `runs.start` in quel progetto: Developer lo contiene.
    const projectId = state.projects.find((p) => p.code === code)!.id;
    writeAccess((s) => {
      s.revocations.push({ personId: LAURA, projectId, permission: "runs.start" });
    });
    await user.click(within(dialog).getByRole("button", { name: "Create invite" }));
    expect(
      await within(dialog).findByText(
        `You can't give “Developer in ${code}”: it includes start Claude, which you don't have.`,
      ),
    ).toBeVisible();
  });

  it("crea: i progetti offerti sono solo quelli dove si gestiscono i membri; il link si copia una volta", async () => {
    const user = userEvent.setup();
    give(LAURA, "users.invite");
    renderRoute("/admin/people", LAURA);
    await heading("People");
    await user.click(screen.getByRole("button", { name: "Invite someone" }));
    const dialog = screen.getByRole("dialog", { name: "Invite someone" });
    await user.type(within(dialog).getByLabelText("Email"), "federico.r@example.com");
    await user.click(within(dialog).getByRole("button", { name: /Add a project/ }));
    const offered = within(screen.getByRole("menu")).getAllByRole("menuitem");
    const managed = state.projects.filter((p) =>
      accessState().memberships.some(
        (m) =>
          m.personId === LAURA && m.projectId === p.id && m.roleId === "role-project_lead",
      ),
    );
    expect(offered.map((o) => o.textContent?.slice(0, 3)).sort()).toEqual(
      managed.map((p) => p.code).sort(),
    );
    await user.click(offered[0]!);
    expect(within(dialog).getByRole("button", { name: /Role in .*: Developer/ })).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Create invite" }));
    await confirmItsYou(user);
    const secret = await screen.findByTestId("secret-once");
    expect(secret).toHaveTextContent("Send it yourself: Stubwise doesn't send emails.");
    const link = secret.querySelector("[data-secret-value]")!.textContent!;
    await user.click(within(secret).getByRole("button", { name: "Copy" }));
    expect(await navigator.clipboard.readText()).toBe(link);
    await user.click(within(secret).getByRole("button", { name: "Done" }));
    expect(document.body.textContent).not.toContain(link);
    expect(
      await within(peopleList()).findByRole("link", { name: /federico\.r@example\.com/ }),
    ).toBeVisible();
  });

  it("errori in parole sotto il campo", async () => {
    const user = userEvent.setup();
    renderRoute("/admin/people?invite=1", ROBERTA);
    const dialog = await screen.findByRole("dialog", { name: "Invite someone" });
    await user.type(within(dialog).getByLabelText("Email"), "marco");
    await user.click(within(dialog).getByRole("button", { name: "Create invite" }));
    expect(await within(dialog).findByText("Enter a full email address.")).toBeVisible();
    await user.clear(within(dialog).getByLabelText("Email"));
    await user.type(within(dialog).getByLabelText("Email"), "ines.ricci@example.com");
    await user.click(within(dialog).getByRole("button", { name: "Create invite" }));
    expect(
      await within(dialog).findByText(
        "There's already an invite for this email. Revoke it first.",
      ),
    ).toBeVisible();
  });

  it("chi invita senza gestire membri: la parte dei progetti lo dice", async () => {
    const user = userEvent.setup();
    give(SARA, "users.invite");
    renderRoute("/admin/people", SARA);
    await heading("People");
    await user.click(screen.getByRole("button", { name: "Invite someone" }));
    expect(
      await screen.findByText(
        "You can invite people to the instance, but not to a project: you don't manage members anywhere.",
      ),
    ).toBeVisible();
  });

  it("la pagina dell'invito: revoca a due tempi, torna a People col toast", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/admin/people/invites/inv-1", ROBERTA);
    expect(await heading("ines.ricci@example.com")).toBeVisible();
    expect(screen.getByText(/Sent by Roberta Fontana/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Revoke invite" }));
    await user.click(screen.getByRole("button", { name: "Revoke — sure?" }));
    expect(await screen.findByText("Invite revoked.")).toBeVisible();
    await waitFor(() => expect(router.state.location.pathname).toBe("/admin/people"));
    expect(state.invites.find((i) => i.id === "inv-1")!.revokedAt).not.toBeNull();
  });

  it("⌘K «Invite someone» apre il dialogo su People", async () => {
    const user = userEvent.setup();
    renderRoute("/home", ROBERTA);
    await heading("Home");
    await user.keyboard("{Control>}k{/Control}");
    const palette = await screen.findByRole("dialog", { name: "Search and commands" });
    await user.type(within(palette).getByRole("combobox"), "invite");
    await user.click(await within(palette).findByRole("option", { name: /Invite someone/ }));
    expect(await screen.findByRole("dialog", { name: "Invite someone" })).toBeVisible();
    act(() => undefined);
  });
});

describe("motivi in parole", () => {
  it("«identity» (un'identità git vuota) ha la sua frase, non quella generica", () => {
    expect(reasonWords(i18n.t, "identity")).toBe("Enter a git email, or pick an observed author.");
  });
});
