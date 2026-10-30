import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetApi, setLatency } from "../../data/api";
import { accessState, roleIdOf, writeAccess } from "../../data/access/index";
import { markReauthenticated } from "../../data/auth/reauth";
import { whenFixesIdle } from "../../data/servers/fix";
import { state } from "../../data/store";
import { can, viewerFor } from "../../data/viewer";
import i18n from "../../i18n";
import { DOCKED_PANEL_QUERY } from "../../layout/useDetailPanel";
import { resetReauthForTest } from "../../layout/useReauth";
import { clearToasts } from "../../tasks-ui/Toast";
import { renderRoute } from "../../test/renderRoute";
import { setMatchMedia } from "../../test/setup";

// Progetto → Settings → Members (area 9a, Task 10, shape
// admin-roles-members.md «Members») e la navigazione delle sezioni di
// Settings nella colonna [RM 4]. Laura è Project Lead di ACQ (gestisce i
// membri, non ha `servers.operate`); Marco è Developer con `servers.operate`
// dato da Roberta; Roberta è full admin (non è una riga).

const ACQ = "prj-acq";
const LAURA = "p-laura";
const ROBERTA = "p-roberta";
const MARCO = "p-marco";
const FEDERICO = "p-federico";

beforeEach(() => {
  setLatency(0);
  resetApi();
  resetReauthForTest();
  window.localStorage.clear();
  setMatchMedia(DOCKED_PANEL_QUERY, true);
});
afterEach(async () => {
  await whenFixesIdle();
  clearToasts();
  resetApi();
  await i18n.changeLanguage("en");
});

const members = () => screen.findByRole("list", { name: "Members of ACQ" });
const rowOf = async (name: string) => {
  const list = await members();
  return within(list).getByRole("button", { name: new RegExp(`^${name}`) });
};
/** Il pannello del membro (affiancato: una regione), dal nome di battesimo. */
const panel = (first: string) =>
  screen.findByRole("region", { name: new RegExp(`^${first} .* in ACQ$`) });
/** La casella di un permesso nella tabella, dal suo nome in parole. */
const box = (scope: HTMLElement, name: string) =>
  within(scope).getByRole("checkbox", { name: new RegExp(`^${name}`, "i") });

async function openMembers(personId: string, query = "") {
  const router = renderRoute(`/p/ACQ/settings/members${query}`, personId);
  await screen.findByRole("heading", { level: 1, name: "Members" });
  return router;
}

async function openPanel(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await rowOf(name));
  const p = await panel(name);
  // La tabella arriva con la bozza letta dal livello dati.
  await within(p).findByRole("group", { name: new RegExp(`^What ${name} .* can do in ACQ$`) });
  return p;
}

async function save(user: ReturnType<typeof userEvent.setup>, p: HTMLElement) {
  await user.click(within(p).getByRole("button", { name: "Save" }));
}

describe("l'elenco", () => {
  it("né Claude né Roberta fra le righe; la riga sui full admin; ruolo e permessi in più in prosa", async () => {
    await openMembers(LAURA);
    const list = await members();
    const rows = within(list).getAllByRole("button");
    const names = rows.map((r) => r.getAttribute("data-member-row"));
    expect(names).not.toContain(ROBERTA);
    expect(names).not.toContain("p-claude");
    expect(names).toContain(MARCO);
    expect(
      screen.getByText(
        "Full admins can do everything in every project, so they aren't listed here.",
      ),
    ).toBeInTheDocument();
    const marco = await rowOf("Marco");
    expect(marco).toHaveTextContent("Developer");
    expect(marco).toHaveTextContent(/\+ start a server fix \(given by Roberta, Oct \d+\)/);
  });

  it("Marco vede l'elenco senza azioni; il pannello si apre in sola lettura", async () => {
    const user = userEvent.setup();
    await openMembers(MARCO);
    await members();
    expect(screen.queryByRole("button", { name: "Add member" })).toBeNull();
    const p = await openPanel(user, "Federico");
    expect(p).toHaveTextContent("Only people who manage ACQ's members can change this.");
    for (const c of within(p).getAllByRole("checkbox")) expect(c).toBeDisabled();
    expect(within(p).queryByRole("button", { name: /Role in ACQ/ })).toBeNull();
    expect(within(p).queryByRole("button", { name: /Remove from ACQ/ })).toBeNull();
    expect(within(p).queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("ogni permesso del membro dice la sua fonte, per esteso nel pannello", async () => {
    const user = userEvent.setup();
    await openMembers(LAURA);
    const p = await openPanel(user, "Marco");
    const row = (name: string) => box(p, name).closest("li")!;
    expect(row("start a server fix")).toHaveTextContent(/Given by Roberta Fontana on Oct \d+/);
    expect(row("reply to customers")).toHaveTextContent(
      "From the Developer role · From the Development department",
    );
    expect(row("approve plans")).not.toHaveTextContent("From the");
    // Ciò che viene dal ruolo è spuntato e fisso.
    expect(box(p, "reply to customers")).toBeChecked();
    expect(box(p, "reply to customers")).toBeDisabled();
  });
});

describe("Laura su ACQ: aggiunge Federico, il permesso di server, la gerarchia che non c'è", () => {
  beforeEach(() => {
    // Federico non è (ancora) in ACQ.
    writeAccess((s) => {
      s.memberships = s.memberships.filter(
        (m) => !(m.personId === FEDERICO && m.projectId === ACQ),
      );
    });
  });

  it("aggiunge Federico come Developer: riconferma, toast, la riga in cima", async () => {
    const user = userEvent.setup();
    await openMembers(LAURA);
    await user.click(screen.getByRole("button", { name: "Add member" }));
    const dialog = await screen.findByRole("dialog", { name: "Add member" });
    await user.type(within(dialog).getByRole("searchbox"), "Feder");
    await user.click(within(dialog).getByRole("radio", { name: /Federico/ }));
    await user.click(within(dialog).getByRole("button", { name: /Role in ACQ/ }));
    await user.click(await screen.findByRole("menuitemradio", { name: /^Developer/ }));
    await user.click(within(dialog).getByRole("button", { name: "Add" }));
    // La riconferma: il codice del prototipo, poi l'azione riparte da sola.
    const confirm = await screen.findByRole("dialog", { name: "Confirm it's you" });
    await user.type(within(confirm).getByLabelText("Code"), "123456");
    expect(await screen.findByText("Federico Sartori joined ACQ as Developer.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add member" })).toBeNull());
    const first = within(await members()).getAllByRole("button")[0]!;
    expect(first).toHaveAttribute("data-member-row", FEDERICO);
    expect(accessState().memberships).toContainEqual({
      personId: FEDERICO,
      projectId: ACQ,
      roleId: roleIdOf("developer"),
    });
  });

  it("servers.operate: Laura non lo può dare (spento, col motivo); Roberta sì; Federico vede «Start fix»; Laura lo toglie", async () => {
    writeAccess((s) => {
      s.memberships.push({ personId: FEDERICO, projectId: ACQ, roleId: roleIdOf("developer") });
    });
    const user = userEvent.setup();
    // Laura: spento, «You don't have this», e la frase lunga per chi non vede.
    await openMembers(LAURA);
    let p = await openPanel(user, "Federico");
    const ops = box(p, "start a server fix");
    expect(ops).toBeDisabled();
    expect(ops.closest("li")).toHaveTextContent(
      "You don't have this permission in ACQ, so you can't give it.",
    );
    cleanup();

    // Roberta lo dà.
    markReauthenticated(ROBERTA);
    await openMembers(ROBERTA);
    p = await openPanel(user, "Federico");
    await user.click(box(p, "start a server fix"));
    expect(within(p).getByText("1 change")).toBeInTheDocument();
    await save(user, p);
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
    await waitFor(() => expect(can(viewerFor(FEDERICO), "servers.operate", ACQ)).toBe(true));
    cleanup();

    // Federico, sulla task del server SRV-1 (ACQ-6), può avviare la correzione (8b).
    renderRoute("/p/ACQ/tasks?task=ACQ-6", FEDERICO);
    const task = await screen.findByRole("region", { name: "Task ACQ-6" });
    expect(
      await within(task).findByRole("button", { name: "Start fix on the server" }),
    ).toBeInTheDocument();
    cleanup();

    // Laura glielo toglie: togliere non passa dall'anti-escalation.
    markReauthenticated(LAURA);
    await openMembers(LAURA);
    p = await openPanel(user, "Federico");
    expect(box(p, "start a server fix")).toBeEnabled();
    await user.click(box(p, "start a server fix"));
    await save(user, p);
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
    expect(can(viewerFor(FEDERICO), "servers.operate", ACQ)).toBe(false);
    expect(state.changelog.at(-1)).toMatchObject({
      kind: "member.permission_revoked",
      actorId: LAURA,
      before: "servers.operate",
    });
  });

  it("Laura toglie a Marco servers.operate, che lei non ha; poi non lo può ridare", async () => {
    const user = userEvent.setup();
    markReauthenticated(LAURA);
    await openMembers(LAURA);
    const p = await openPanel(user, "Marco");
    const ops = box(p, "start a server fix");
    expect(ops).toBeChecked();
    expect(ops).toBeEnabled();
    await user.click(ops);
    // Tolto nella bozza, ridarlo è spento: Laura non ce l'ha.
    await waitFor(() => expect(box(p, "start a server fix")).toBeDisabled());
    await save(user, p);
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
    expect(can(viewerFor(MARCO), "servers.operate", ACQ)).toBe(false);
    expect(within(await members()).getByRole("button", { name: /^Marco/ })).not.toHaveTextContent(
      "start a server fix",
    );
  });
});

describe("i rifiuti in parole", () => {
  it("ultimo gestore: la bozza lo dice prima e Save è spento; Remove anche", async () => {
    writeAccess((s) => {
      s.people.find((p) => p.personId === ROBERTA)!.instanceRoleId = roleIdOf("user");
      s.memberships.find((m) => m.personId === "p-matteo" && m.projectId === ACQ)!.roleId =
        roleIdOf("developer");
    });
    const user = userEvent.setup();
    await openMembers(LAURA);
    const p = await openPanel(user, "Laura");
    expect(p).toHaveTextContent("This is you.");
    await user.click(within(p).getByRole("button", { name: /Role in ACQ/ }));
    await user.click(await screen.findByRole("menuitemradio", { name: /^Developer/ }));
    expect(
      await within(p).findByText(
        "You're the only one who can manage ACQ's members. Give someone else that permission before removing it from yourself.",
      ),
    ).toBeInTheDocument();
    expect(within(p).getByRole("button", { name: "Save" })).toBeDisabled();
    expect(within(p).getByRole("button", { name: "Remove from ACQ…" })).toBeDisabled();
    expect(p).toHaveTextContent(
      "Give someone else that permission before leaving ACQ.",
    );
  });

  it("un ruolo che aggiunge ciò che Laura non ha è spento col motivo", async () => {
    // Laura senza release.merge: «Release manager» lo aggiunge a Marco.
    writeAccess((s) => {
      s.revocations.push({ personId: LAURA, projectId: ACQ, permission: "release.merge" });
    });
    const user = userEvent.setup();
    await openMembers(LAURA);
    const p = await openPanel(user, "Marco");
    await user.click(within(p).getByRole("button", { name: /Role in ACQ/ }));
    const rm = await screen.findByRole("menuitemradio", { name: /^Release manager/ });
    expect(rm).toHaveAttribute("aria-disabled", "true");
    expect(rm).toHaveTextContent("Includes permissions you don't have.");
  });
});

describe("la navigazione di Settings", () => {
  it("le sezioni sono voci rientrate sotto Settings; /settings apre Statuses", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/p/AUD/settings", ROBERTA);
    await screen.findByRole("heading", { level: 1, name: "Statuses" });
    expect(router.state.location.pathname).toBe("/p/AUD/settings/statuses");
    const sub = await screen.findByRole("list", { name: "Settings of AUD" });
    const links = within(sub).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["Statuses", "Members", "Repositories"]);
    await waitFor(() => expect(links[0]).toHaveAttribute("aria-current", "page"));
    await user.click(links[1]!);
    await screen.findByRole("heading", { level: 1, name: "Members" });
    expect(router.state.location.pathname).toBe("/p/AUD/settings/members");
    await user.click(within(sub).getByRole("link", { name: "Repositories" }));
    expect(await screen.findByRole("region", { name: "Repositories" })).toBeInTheDocument();
  });

  it("senza il modulo Releases niente Repositories, e l'indirizzo porta a Statuses", async () => {
    const project = state.projects.find((p) => p.code === "MKX")!;
    expect(project.modules).not.toContain("releases");
    const router = renderRoute("/p/MKX/settings/repositories", ROBERTA);
    await screen.findByRole("heading", { level: 1, name: "Statuses" });
    expect(router.state.location.pathname).toBe("/p/MKX/settings/statuses");
    const sub = await screen.findByRole("list", { name: "Settings of MKX" });
    expect(within(sub).queryByRole("link", { name: "Repositories" })).toBeNull();
  });

  it("le sezioni si chiudono fuori da Settings", async () => {
    renderRoute("/p/ACQ/overview", LAURA);
    await screen.findByRole("navigation", { name: "Project sections" });
    expect(screen.queryByRole("list", { name: "Settings of ACQ" })).toBeNull();
  });
});

describe("dalla pagina della persona", () => {
  it("Edit apre il pannello del membro nel progetto giusto", async () => {
    const user = userEvent.setup();
    const router = renderRoute(`/admin/people/${MARCO}`, LAURA);
    await user.click(await screen.findByRole("link", { name: /^Edit Marco .* in ACQ$/ }));
    expect(await panel("Marco")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/p/ACQ/settings/members");
  });

  it("Add to a project apre «Add member» con la persona già scelta", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/admin/people/p-giulia", LAURA);
    await user.click(await screen.findByRole("button", { name: "Add to a project" }));
    await user.click(await screen.findByRole("menuitem", { name: /ACQ/ }));
    const dialog = await screen.findByRole("dialog", { name: "Add member" });
    expect(router.state.location.pathname).toBe("/p/ACQ/settings/members");
    expect(within(dialog).getByRole("radio", { name: /Giulia/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });
});

describe("in italiano", () => {
  it("le parole della pagina e del pannello", async () => {
    await i18n.changeLanguage("it");
    const user = userEvent.setup();
    renderRoute("/p/ACQ/settings/members", LAURA);
    await screen.findByRole("heading", { level: 1, name: "Membri" });
    const list = await screen.findByRole("list", { name: "Membri di ACQ" });
    await user.click(within(list).getByRole("button", { name: /^Marco/ }));
    const p = await panel("Marco");
    expect(await within(p).findByText("Cosa può fare qui")).toBeInTheDocument();
  });
});
