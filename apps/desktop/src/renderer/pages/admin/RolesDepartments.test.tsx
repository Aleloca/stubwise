import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { admin, resetApi, setLatency } from "../../data/api";
import { accessState, roleIdOf, writeAccess } from "../../data/access/index";
import { setSessionPersonId } from "../../data/session";
import { state } from "../../data/store";
import {
  can,
  grantInstancePermission,
  viewerFor,
  type LocalInstancePermission,
} from "../../data/viewer";
import { groupsFor } from "../../domain/access/actions";
import i18n from "../../i18n";
import en from "../../i18n/locales/en.json";
import it_ from "../../i18n/locales/it.json";
import { DOCKED_PANEL_QUERY } from "../../layout/useDetailPanel";
import { resetReauthForTest } from "../../layout/useReauth";
import { renderRoute } from "../../test/renderRoute";
import { setMatchMedia } from "../../test/setup";

// Departments e Roles in Amministrazione (area 9a, Task 9, shape
// admin-people.md «Departments» e admin-roles-members.md «Roles»). Roberta è
// full admin; Marco è Developer (gli si dà il permesso di gestione quando
// serve, per vedere le scelte spente); Laura è Project Lead di ACQ.

const ROBERTA = "p-roberta";
const MARCO = "p-marco";
const ACQ = "prj-acq";
const AUD = "prj-aud";

beforeEach(() => {
  setLatency(0);
  resetApi();
  resetReauthForTest();
  window.localStorage.clear();
  setMatchMedia(DOCKED_PANEL_QUERY, true);
});
afterEach(async () => {
  resetApi();
  await i18n.changeLanguage("en");
});

const give = (personId: string, perm: string) =>
  grantInstancePermission(personId, perm as LocalInstancePermission);
const heading = (name: string | RegExp) => screen.findByRole("heading", { level: 1, name });
const dept = (id: string) => accessState().departments.find((d) => d.departmentId === id)!;
const role = (key: string) => accessState().roles.find((r) => r.key === key)!;

/** Il dialogo «Confirm it's you»: il codice del prototipo, e l'azione riparte da sola. */
async function confirmItsYou(user: ReturnType<typeof userEvent.setup>) {
  const dialog = await screen.findByRole("dialog", { name: "Confirm it's you" });
  await user.type(within(dialog).getByLabelText("Code"), "123456");
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Confirm it's you" })).toBeNull(),
  );
}

/** Una riga della tabella dei permessi: la casella col nome in parole. */
const permissionBox = (name: string) => screen.getByRole("checkbox", { name: new RegExp(`^${name}`) });

describe("le frasi dei permessi: una per ogni permesso, in en e it", () => {
  it("ogni permesso dei gruppi ha nome e frase, in tutte e due le lingue", () => {
    const missing: string[] = [];
    for (const scope of ["instance", "project"] as const)
      for (const g of groupsFor(scope))
        for (const p of g.permissions)
          for (const [lang, tree] of [
            ["en", en],
            ["it", it_],
          ] as const) {
            let node: unknown = (tree as Record<string, unknown>).permissions;
            for (const part of p.split(".")) node = (node as Record<string, unknown>)?.[part];
            const entry = node as { label?: unknown; hint?: unknown } | undefined;
            if (typeof entry?.label !== "string" || typeof entry?.hint !== "string")
              missing.push(`${lang}:${p}`);
          }
    expect(missing).toEqual([]);
  });

  it("le frasi di access.perm non esistono più: una fonte sola", () => {
    expect((en as Record<string, unknown>).access).toBeUndefined();
    expect((it_ as Record<string, unknown>).access).toBeUndefined();
  });
});

// --- Departments ------------------------------------------------------------------

describe("Departments", () => {
  it("crea un reparto (la prima tinta libera già scelta), lo rinomina e lo ricolora dal pannello", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/admin/departments", ROBERTA);
    await heading("Departments");
    await screen.findByRole("list", { name: "Departments" });
    await user.click(screen.getByRole("button", { name: "New department" }));
    const dialog = screen.getByRole("dialog", { name: "New department" });
    await user.type(within(dialog).getByLabelText("Name"), "Legal");
    const free = within(dialog).getByRole("radio", { checked: true });
    expect(free).toHaveAccessibleName(/^Color \d, /);
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    const created = state.departments.find((d) => d.name === "Legal")!;
    expect(created).toBeDefined();
    // Il pannello del reparto nuovo, aperto.
    const panel = await screen.findByRole("region", { name: "Department Legal" });
    expect(router.state.location.search).toMatchObject({ department: created.id });
    expect(within(panel).getByText("No one in this department yet.")).toBeVisible();
    // Rinomina: si salva subito, senza riconferma.
    const name = within(panel).getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Legal and compliance{Enter}");
    await waitFor(() => expect(created.name).toBe("Legal and compliance"));
    // Colora: la tinta 4, già usata da un altro reparto (permesso, ma detto).
    const four = within(panel).getByRole("radio", { name: "Color 4, red-orange" });
    await user.click(four);
    await waitFor(() => expect(created.colorToken).toBe("--dept-4"));
    expect(await within(screen.getByRole("list", { name: "Departments" })).findByText("Legal and compliance")).toBeVisible();
  });

  it("le persone e la Home si salvano insieme, con una riconferma; Claude non è fra chi si aggiunge", async () => {
    const user = userEvent.setup();
    renderRoute("/admin/departments?department=dep-sales", ROBERTA);
    const panel = await screen.findByRole("region", { name: "Department Sales" });
    await user.click(within(panel).getByRole("button", { name: "Add people" }));
    const candidates = within(panel).getByRole("list", { name: "People you can add" });
    expect(within(candidates).queryByText("Claude")).toBeNull();
    await user.click(within(candidates).getByText("Sara Montanari"));
    await user.click(within(panel).getByRole("checkbox", { name: "Sara Montanari manages the Home" }));
    expect(within(panel).getByText("2 changes")).toBeVisible();
    // Niente è scritto prima del salvataggio.
    expect(dept("dep-sales").memberIds).not.toContain("p-sara");
    await user.click(within(panel).getByRole("button", { name: "Save" }));
    await confirmItsYou(user);
    await waitFor(() => expect(dept("dep-sales").memberIds).toContain("p-sara"));
    expect(dept("dep-sales").homeManagerIds).toContain("p-sara");
    expect(await screen.findByText("Saved")).toBeVisible();
    expect(within(panel).queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("i permessi del reparto: quello che chi agisce non ha è spento col motivo; il rifiuto che arriva dopo è in parole", async () => {
    const user = userEvent.setup();
    give(MARCO, "departments.manage");
    // Un reparto con il solo Marco: un permesso nuovo arriva nei suoi progetti.
    setSessionPersonId(ROBERTA);
    const legal = (await admin.createDepartment({ name: "Legal", colorToken: "--dept-6" })) as {
      departmentId: string;
    };
    writeAccess((s) => {
      s.departments.find((d) => d.departmentId === legal.departmentId)!.memberIds = [MARCO];
    });
    renderRoute(`/admin/departments?department=${legal.departmentId}`, MARCO);
    const panel = await screen.findByRole("region", { name: "Department Legal" });
    expect(
      within(panel).getByText(
        "People in this department get these in every project they're already a member of. It doesn't add them to any project.",
      ),
    ).toBeVisible();
    const approve = within(panel).getByRole("checkbox", { name: /^Approve plans/ });
    expect(approve).toBeDisabled();
    expect(approve).toHaveAccessibleDescription(
      "You don't have this in every project of this department's people, so you can't give it.",
    );
    // Marco ha «create tasks» nei suoi progetti: si può dare.
    const create = within(panel).getByRole("checkbox", { name: /^Create tasks/ });
    expect(create).toBeEnabled();
    await user.click(create);
    // Nel frattempo Marco perde «create tasks» in ACQ: il salvataggio torna rifiutato, in parole.
    writeAccess((s) => {
      s.memberships.find((m) => m.personId === MARCO && m.projectId === ACQ)!.roleId =
        roleIdOf("viewer");
    });
    await user.click(within(panel).getByRole("button", { name: "Save" }));
    expect(
      await within(panel).findByText(
        "You can't give create tasks: you don't have it in every project of this department's people.",
      ),
    ).toBeVisible();
    expect(dept(legal.departmentId).projectPermissions).toEqual([]);
  });

  it("aggiungere a un reparto chi riceverebbe permessi che chi agisce non ha: spento, col motivo", async () => {
    const user = userEvent.setup();
    give(MARCO, "departments.manage");
    // Sara sta in progetti dove Marco non è: lì Marco non ha «reply to customers».
    renderRoute("/admin/departments?department=dep-development", MARCO);
    const panel = await screen.findByRole("region", { name: "Department Development" });
    await user.click(within(panel).getByRole("button", { name: "Add people" }));
    const candidates = within(panel).getByRole("list", { name: "People you can add" });
    const sara = within(candidates).getByText("Sara Montanari").closest("button")!;
    expect(sara).toHaveAttribute("aria-disabled", "true");
    expect(
      within(sara).getByText(
        "Development gives reply to customers, which you don't have in their projects.",
      ),
    ).toBeVisible();
    await user.click(sara);
    expect(within(panel).queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("elimina un reparto con le task da spostare: sceglie dove, poi «Move and delete»", async () => {
    const user = userEvent.setup();
    const tasks = state.tasks.filter((t) => t.departmentId === "dep-sales").map((t) => t.id);
    expect(tasks.length).toBeGreaterThan(0);
    renderRoute("/admin/departments?department=dep-sales", ROBERTA);
    const panel = await screen.findByRole("region", { name: "Department Sales" });
    await user.click(within(panel).getByRole("button", { name: "Delete department…" }));
    const dialog = screen.getByRole("dialog", { name: "Delete Sales?" });
    expect(
      within(dialog).getByText(
        `${tasks.length} tasks have Sales as their department. Move them to:`,
      ),
    ).toBeVisible();
    const go = within(dialog).getByRole("button", { name: "Move and delete" });
    expect(go).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: /Choose a department/ }));
    await user.click(screen.getByRole("menuitemradio", { name: /Marketing/ }));
    await user.click(go);
    await waitFor(() => expect(state.departments.some((d) => d.id === "dep-sales")).toBe(false));
    for (const id of tasks) expect(state.tasksById.get(id)!.departmentId).toBe("dep-marketing");
    expect(
      await screen.findByText(`Sales deleted. ${tasks.length} tasks moved to Marketing.`),
    ).toBeVisible();
    await waitFor(() => expect(screen.queryByRole("region", { name: "Department Sales" })).toBeNull());
  });

  it("chiudere il pannello con modifiche chiede prima", async () => {
    const user = userEvent.setup();
    renderRoute("/admin/departments?department=dep-sales", ROBERTA);
    const panel = await screen.findByRole("region", { name: "Department Sales" });
    await user.click(within(panel).getAllByRole("button", { name: /^Remove / })[0]!);
    await user.click(within(panel).getByRole("button", { name: "Close the department" }));
    expect(await within(panel).findByText("Discard 1 change?")).toBeVisible();
    await user.click(within(panel).getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("region", { name: "Department Sales" })).toBeVisible();
    await user.click(within(panel).getByRole("button", { name: "Close the department" }));
    await user.click(within(panel).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Department Sales" })).toBeNull());
  });

  it("«Edit» accanto ai reparti della persona apre il pannello del reparto", async () => {
    const user = userEvent.setup();
    const router = renderRoute(`/admin/people/${MARCO}`, ROBERTA);
    await heading("Marco Bellini");
    await user.click(screen.getByRole("link", { name: "Edit Development" }));
    expect(await screen.findByRole("region", { name: "Department Development" })).toBeVisible();
    expect(router.state.location.pathname).toBe("/admin/departments");
  });

  it("senza departments.manage la pagina della persona non ha «Edit» sui reparti", async () => {
    renderRoute(`/admin/people/${MARCO}`, "p-laura");
    await heading("Marco Bellini");
    expect(screen.queryByRole("link", { name: /^Edit Development/ })).toBeNull();
  });
});

// --- Roles ------------------------------------------------------------------------

describe("Roles", () => {
  it("l'elenco: due gruppi, preset segnati, chi ha un ruolo di progetto si apre sotto la riga", async () => {
    const user = userEvent.setup();
    renderRoute("/admin/roles", ROBERTA);
    await heading("Roles");
    const instance = await screen.findByRole("list", { name: "Instance roles" });
    expect(within(instance).getByRole("link", { name: "Admin" })).toBeVisible();
    expect(within(instance).getByRole("link", { name: "Auditor" })).toBeVisible();
    const project = screen.getByRole("list", { name: "Project roles" });
    const devRow = within(project).getByRole("link", { name: "Developer" }).closest("li")!;
    expect(within(devRow).getByText("Preset")).toBeVisible();
    await user.click(within(devRow).getByRole("button", { name: /memberships/ }));
    expect(within(devRow).getByRole("list", { name: "Who has Developer" })).toBeVisible();
    expect(screen.getByText("Claude has no role: it works in every project, and never decides.")).toBeVisible();
  });

  it("crea un ruolo di progetto e apre la sua pagina", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/admin/roles", ROBERTA);
    await heading("Roles");
    await user.click(await screen.findByRole("button", { name: "New project role" }));
    const dialog = screen.getByRole("dialog", { name: "New project role" });
    await user.type(within(dialog).getByLabelText("Name"), "QA");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await confirmItsYou(user);
    expect(await heading("QA")).toBeVisible();
    const qa = accessState().roles.find((r) => r.name === "QA")!;
    expect(qa.scope).toBe("project");
    expect(router.state.location.pathname).toBe(`/admin/roles/${qa.id}`);
  });

  it("duplica Developer: «Copy of Developer» e la sua pagina", async () => {
    const user = userEvent.setup();
    renderRoute("/admin/roles", ROBERTA);
    await heading("Roles");
    await user.click(await screen.findByRole("button", { name: "More actions for Developer" }));
    await user.click(screen.getByRole("menuitem", { name: "Duplicate" }));
    await confirmItsYou(user);
    expect(await heading("Copy of Developer")).toBeVisible();
    expect(accessState().roles.find((r) => r.name === "Copy of Developer")!.permissions).toEqual(
      role("developer").permissions,
    );
  });

  it("modifica: la barra dice quante persone cambiano, poi riconferma e «Saved»", async () => {
    const user = userEvent.setup();
    renderRoute(`/admin/roles/${roleIdOf("rm-1")}`, ROBERTA);
    await heading("Release manager");
    await user.click(permissionBox("Request corrections"));
    expect(screen.getByText("1 change")).toBeVisible();
    expect(screen.getByText(/this changes what 0 people can do/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Save role" }));
    await confirmItsYou(user);
    expect(await screen.findByText("Saved")).toBeVisible();
    expect(role("rm-1").permissions).not.toContain("corrections.request");
    expect(screen.queryByRole("button", { name: "Save role" })).toBeNull();
  });

  it("elimina un ruolo libero: conferma a due tempi, riconferma, torna a Roles", async () => {
    const user = userEvent.setup();
    const router = renderRoute(`/admin/roles/${roleIdOf("au-1")}`, ROBERTA);
    await heading("Auditor");
    await user.click(screen.getByRole("button", { name: "More actions for Auditor" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete…" }));
    const dialog = screen.getByRole("dialog", { name: "Delete Auditor?" });
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await user.click(within(dialog).getByRole("button", { name: "Delete — sure?" }));
    await confirmItsYou(user);
    expect(await screen.findByText("Role deleted.")).toBeVisible();
    await waitFor(() => expect(router.state.location.pathname).toBe("/admin/roles"));
    expect(accessState().roles.some((r) => r.key === "au-1")).toBe(false);
  });

  it("un preset non si elimina, con la frase", async () => {
    const user = userEvent.setup();
    renderRoute("/admin/roles", ROBERTA);
    await heading("Roles");
    await user.click(await screen.findByRole("button", { name: "More actions for Developer" }));
    const del = screen.getByRole("menuitem", { name: /^Delete…/ });
    expect(del).toHaveAttribute("aria-disabled", "true");
    expect(within(del).getByText("Presets can't be deleted.")).toBeVisible();
    await userEvent.click(del);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("un ruolo in uso dice chi lo ha, e non si elimina", async () => {
    const user = userEvent.setup();
    writeAccess((s) => {
      s.memberships.find((m) => m.personId === MARCO && m.projectId === ACQ)!.roleId =
        roleIdOf("rm-1");
    });
    renderRoute("/admin/roles", ROBERTA);
    await heading("Roles");
    await user.click(await screen.findByRole("button", { name: "More actions for Release manager" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete…" }));
    const dialog = screen.getByRole("dialog", { name: "Release manager is still used" });
    const holders = within(dialog).getByRole("list", { name: "Who has Release manager" });
    expect(within(holders).getByRole("link", { name: "Marco Bellini" })).toBeVisible();
    expect(within(holders).getByText("ACQ")).toBeVisible();
    expect(within(dialog).getByText("Give them another role first.")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(accessState().roles.some((r) => r.key === "rm-1")).toBe(true);
  });

  it("un permesso che chi modifica non ha è spento, col motivo", async () => {
    give(MARCO, "roles.manage");
    renderRoute(`/admin/roles/${roleIdOf("au-1")}`, MARCO);
    await heading("Auditor");
    const usage = permissionBox("View usage");
    expect(usage).toBeChecked();
    // Già nel ruolo: toglierlo si può (togliere non passa dall'escalation).
    expect(usage).toBeEnabled();
    const manage = permissionBox("Manage people");
    expect(manage).toBeDisabled();
    expect(manage).toHaveAccessibleDescription(
      "You don't have this permission, so you can't give it.",
    );
    expect(screen.getAllByText("You don't have this").length).toBeGreaterThan(0);
  });

  it("R-E2: un ruolo fatto a mano dice che non dà «vedere l'attività delle persone»", async () => {
    renderRoute(`/admin/roles/${roleIdOf("rm-1")}`, ROBERTA);
    await heading("Release manager");
    expect(
      screen.getByText(
        "This role doesn't let people see everyone's activity: only Project Lead does.",
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Roles never apply to Claude. Claude can work but doesn't decide, whatever is ticked here.",
      ),
    ).toBeVisible();
    cleanup();
    renderRoute(`/admin/roles/${roleIdOf("project_lead")}`, ROBERTA);
    await heading("Project Lead");
    expect(screen.getByText(/^Project Lead also lets people see everyone's activity/)).toBeVisible();
  });

  it("il cambio vale subito: dato release.merge a «Release manager», chi ha quel ruolo vede «Release» in Releases", async () => {
    const user = userEvent.setup();
    writeAccess((s) => {
      s.roles.find((r) => r.key === "rm-1")!.permissions = role("rm-1").permissions.filter(
        (p) => p !== "release.merge",
      );
      s.memberships.find((m) => m.personId === MARCO && m.projectId === AUD)!.roleId =
        roleIdOf("rm-1");
    });
    expect(can(viewerFor(MARCO), "release.merge", AUD)).toBe(false);
    renderRoute(`/admin/roles/${roleIdOf("rm-1")}`, ROBERTA);
    await heading("Release manager");
    await user.click(permissionBox("Merge pull requests"));
    expect(screen.getByText(/this changes what 1 person can do/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Save role" }));
    await confirmItsYou(user);
    await screen.findByText("Saved");
    cleanup();
    renderRoute("/p/AUD/releases", MARCO);
    expect(
      await screen.findByRole("button", { name: "Release audin-app#244" }),
    ).toBeInTheDocument();
  });

  it("chi non ha roles.manage non trova la pagina di un ruolo", async () => {
    renderRoute(`/admin/roles/${roleIdOf("developer")}`, MARCO);
    expect(await heading("Page not found")).toBeVisible();
  });
});
