import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { resetApi, setLatency } from "../../../data/api";
import { accessState } from "../../../data/access/index";
import { markReauthenticated } from "../../../data/auth/reauth";
import { visibleProjectIds } from "../../../data/store";
import { renderRoute } from "../../../test/renderRoute";

// Le workspace nel prototipo (shape `workspaces.md`): la colonna di All
// projects, la pagina filtrata, la scheda People col pannello, l'invito e
// «Add projects» con la riga dell'effetto prima di salvare.

const ROBERTA = "p-roberta";
const GIULIA = "p-giulia";

beforeEach(() => {
  resetApi();
  setLatency(0);
});

const column = () => screen.getByRole("navigation", { name: "Projects and workspaces" });
const rowsShown = () => document.querySelectorAll("[data-project-row]").length;

describe("la colonna di All projects", () => {
  it("All projects, le workspace col numero dei progetti, poi No workspace; un clic filtra la pagina", async () => {
    const user = userEvent.setup();
    renderRoute("/projects", ROBERTA);
    const nav = await screen.findByRole("navigation", { name: "Projects and workspaces" });
    const list = await within(nav).findByRole("list", { name: "Workspaces" });
    const items = within(list)
      .getAllByRole("link")
      .map((a) => a.textContent);
    expect(items.slice(0, 2)).toEqual(["Clienti storici4", "Prodotti3"]);
    expect(items[2]).toMatch(/^No workspace\d+$/);
    expect(within(nav).getByRole("button", { name: "New workspace" })).toBeInTheDocument();

    await user.click(within(list).getByRole("link", { name: /Clienti storici/ }));
    expect(await screen.findByRole("heading", { level: 1, name: "Clienti storici" })).toBeInTheDocument();
    await waitFor(() => expect(rowsShown()).toBe(4));
    expect(document.querySelector("[data-workspace-summary]")).toHaveTextContent("4 projects · 2 people");
    expect(within(list).getByRole("link", { name: /Clienti storici/ })).toHaveAttribute("aria-current", "page");
  });

  it("D5: chi vede un solo progetto della workspace la vede, col numero dei soli visibili; senza permesso niente «+»", async () => {
    renderRoute("/projects", GIULIA);
    const list = await within(
      await screen.findByRole("navigation", { name: "Projects and workspaces" }),
    ).findByRole("list", { name: "Workspaces" });
    expect(within(list).getByRole("link", { name: /Clienti storici/ })).toHaveTextContent("Clienti storici1");
    expect(within(column()).queryByRole("button", { name: "New workspace" })).toBeNull();
  });

  it("No workspace: i soli progetti fuori da ogni workspace", async () => {
    renderRoute("/projects?workspace=none", ROBERTA);
    expect(await screen.findByRole("heading", { level: 1, name: "No workspace" })).toBeInTheDocument();
    await waitFor(() => expect(rowsShown()).toBe(visibleProjectIds(ROBERTA).size - 7));
  });
});

describe("la scheda People", () => {
  it("le persone col ruolo di workspace e i ruoli per progetto in più; il pannello dice la fonte progetto per progetto", async () => {
    const user = userEvent.setup();
    renderRoute("/projects?workspace=clienti-storici&view=people", ROBERTA);
    const list = await screen.findByRole("list", { name: "People in Clienti storici" });
    const marco = within(list).getByText("Marco Bellini").closest("li")!;
    expect(marco).toHaveTextContent("Developer");
    expect(marco).toHaveTextContent("+ Developer in BSC");
    await user.click(within(list).getByRole("button", { name: /Nicola Orlando/ }));
    const panel = await screen.findByRole("complementary", { name: "Nicola Orlando" });
    const each = within(panel).getByRole("region", { name: "In each project" });
    expect(each).toHaveTextContent("ORT");
    expect(each).toHaveTextContent("Viewer — from the workspace");
    expect(each).not.toHaveTextContent("member of");
  });

  it("invitare: Viewer di base, l'effetto prima di salvare, poi la persona c'è", async () => {
    const user = userEvent.setup();
    markReauthenticated(ROBERTA);
    renderRoute("/projects?workspace=clienti-storici&view=people", ROBERTA);
    await user.click(await screen.findByRole("button", { name: "Invite to Clienti storici" }));
    const dialog = await screen.findByRole("dialog", { name: "Invite to Clienti storici" });
    expect(within(dialog).getByRole("combobox", { name: "Role" })).toHaveDisplayValue(/^Viewer/);
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Person" }), "p-irene");
    await waitFor(() =>
      expect(dialog.querySelector("[data-invite-effect]")).toHaveTextContent("Irene will see 4 projects: BSC, LNT, ORT, SPZ."),
    );
    await user.click(within(dialog).getByRole("button", { name: "Invite" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Invite to Clienti storici" })).toBeNull());
    expect(await screen.findByText("Irene Caruso")).toBeInTheDocument();
    expect(visibleProjectIds("p-irene").has("prj-spz")).toBe(true);
  });
});

describe("Add projects", () => {
  it("scelto un progetto, la riga dice chi comincia a vederlo; aggiunto, è nella workspace", async () => {
    const user = userEvent.setup();
    markReauthenticated(ROBERTA);
    renderRoute("/projects?workspace=clienti-storici", ROBERTA);
    await user.click(await screen.findByRole("button", { name: "Add projects" }));
    const dialog = await screen.findByRole("dialog", { name: "Add projects to Clienti storici" });
    await user.click(within(dialog).getByRole("checkbox", { name: /^MKX/ }));
    await waitFor(() =>
      expect(dialog.querySelector("[data-effect='start']")).toHaveTextContent(/will start seeing MKX/),
    );
    expect(dialog.querySelector("[data-effect='start']")).toHaveTextContent("Nicola Orlando");
    await user.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(accessState().workspaceProjects).toContainEqual({ workspaceId: "ws-storici", projectId: "prj-mkx" });
    await waitFor(() => expect(rowsShown()).toBe(5));
  });
});

const MEMBERS_OF_ORT = "Members of ORT";

describe("Members del progetto: da dove viene un accesso [WS 3]", () => {
  it("chi c'è solo dalla workspace ha una riga, col ruolo di workspace e «Give a role in ORT»", async () => {
    const user = userEvent.setup();
    renderRoute("/p/ORT/settings/members", GIULIA);
    const list = await screen.findByRole("list", { name: MEMBERS_OF_ORT });
    const nicola = list.querySelector<HTMLElement>("[data-member-row='p-nicola']")!;
    expect(nicola.querySelector("[data-member-roles]")).toHaveTextContent("Viewer from Clienti storici");
    expect(nicola).toHaveTextContent("Give a role in ORT");
    const marco = list.querySelector<HTMLElement>("[data-member-row='p-marco']")!;
    expect(marco.querySelector("[data-member-roles]")).toHaveTextContent(
      /^\S+ · Developer from Clienti storici$/,
    );
    expect(document.querySelector("[data-workspace-note]")).toHaveTextContent(
      "People in Clienti storici see ORT with their workspace role.",
    );
    // Il filtro: dalla workspace ci sono Marco e Nicola.
    await user.click(screen.getByRole("button", { name: "From the workspace" }));
    expect([...list.querySelectorAll("[data-member-row]")].map((r) => r.getAttribute("data-member-row")).sort()).toEqual([
      "p-marco",
      "p-nicola",
    ]);
    // «Give a role in ORT»: il dialogo Add member con Nicola già scelto.
    await user.click(nicola);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Nicola Orlando");
  });

  it("il pannello di un membro che è anche nella workspace dice le due porte e che il ruolo aggiunge soltanto (D1)", async () => {
    renderRoute("/p/ORT/settings/members?member=p-marco", GIULIA);
    const because = await waitFor(() => {
      const el = document.querySelector("[data-sees-because]");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(because).toHaveTextContent("Sees ORT because: member of ORT · in Clienti storici");
    expect(document.querySelector("[data-workspace-adds]")).toHaveTextContent(
      "Clienti storici already gives Developer",
    );
  });
});

describe("Settings → General: la workspace del progetto", () => {
  it("chi gestisce cambia la workspace dal menu, vedendo prima chi smette di vedere il progetto", async () => {
    const user = userEvent.setup();
    markReauthenticated(ROBERTA);
    renderRoute("/p/ORT/settings/general", ROBERTA);
    const select = await screen.findByRole("combobox", { name: "Workspace" });
    expect(select).toHaveDisplayValue("Clienti storici");
    await user.selectOptions(select, "");
    await waitFor(() =>
      expect(document.querySelector("[data-workspace-row] [data-effect='stop']")).toHaveTextContent(
        "1 person will stop seeing ORT: Nicola Orlando.",
      ),
    );
    const row = document.querySelector<HTMLElement>("[data-workspace-row]")!;
    await user.click(within(row).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(visibleProjectIds("p-nicola").has("prj-ort")).toBe(false));
  });

  it("senza permesso si legge soltanto", async () => {
    renderRoute("/p/ORT/settings/general", GIULIA);
    await waitFor(() =>
      expect(document.querySelector("[data-workspace-row]")).toHaveTextContent("In Clienti storici"),
    );
    expect(screen.queryByRole("combobox", { name: "Workspace" })).toBeNull();
  });
});

describe("New project dentro una workspace", () => {
  it("dalla pagina filtrata la workspace è già scelta, e il progetto nuovo ci entra", async () => {
    const user = userEvent.setup();
    markReauthenticated(ROBERTA);
    renderRoute("/projects?workspace=clienti-storici", ROBERTA);
    await screen.findByRole("heading", { level: 1, name: "Clienti storici" });
    await user.click(screen.getByRole("button", { name: "New project" }));
    const dialog = await screen.findByRole("dialog", { name: "New project" });
    expect(within(dialog).getByRole("combobox", { name: "Workspace" })).toHaveDisplayValue("Clienti storici");
    expect(dialog.querySelector("[data-new-project-workspace]")).toHaveTextContent(
      "The people in Clienti storici will see it.",
    );
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Vivaio Collina Nuova");
    await user.click(within(dialog).getByRole("button", { name: "Create project" }));
    await waitFor(() => {
      const ids = accessState()
        .workspaceProjects.filter((w) => w.workspaceId === "ws-storici")
        .map((w) => w.projectId);
      expect(ids).toHaveLength(5);
    });
    const added = accessState().workspaceProjects.filter((w) => w.workspaceId === "ws-storici").at(-1)!;
    expect(visibleProjectIds("p-nicola").has(added.projectId)).toBe(true);
  });
});

describe("⌘K", () => {
  it("il gruppo Workspaces apre All projects filtrato; i progetti portano la loro workspace", async () => {
    const user = userEvent.setup();
    const router = renderRoute("/home", ROBERTA);
    await screen.findByRole("heading", { name: "Home", level: 1 });
    await user.keyboard("{Control>}k{/Control}");
    const dialog = await screen.findByRole("dialog", { name: "Search and commands" });
    await user.type(within(dialog).getByRole("combobox"), "Clienti");
    const group = await within(dialog).findByRole("group", { name: "Workspaces" });
    const option = within(group).getByRole("option", { name: /Clienti storici/ });
    expect(option).toHaveTextContent("4 projects");
    await user.clear(within(dialog).getByRole("combobox"));
    await user.type(within(dialog).getByRole("combobox"), "Ortofrutta");
    const projects = await within(dialog).findByRole("group", { name: "Projects" });
    expect(await within(projects).findByRole("option", { name: /Ortofrutta/ })).toHaveTextContent(
      "Clienti storici",
    );
    await user.clear(within(dialog).getByRole("combobox"));
    await user.type(within(dialog).getByRole("combobox"), "Clienti");
    await user.click(within(await within(dialog).findByRole("group", { name: "Workspaces" })).getByRole("option", { name: /Clienti storici/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/projects"));
    expect(await screen.findByRole("heading", { level: 1, name: "Clienti storici" })).toBeInTheDocument();
  });
});

describe("La pagina della persona", () => {
  it("Nicola: i progetti visti dalla workspace con la fonte, e la parte Workspaces", async () => {
    renderRoute("/admin/people/p-nicola", ROBERTA);
    const part = await waitFor(() => {
      const el = document.querySelector("[data-person-workspaces]");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(part).toHaveTextContent("Clienti storici");
    expect(part).toHaveTextContent("Viewer");
    const roles = [...document.querySelectorAll("[data-person-project-role]")].map((e) => e.textContent);
    expect(roles).toContain("Viewer from Clienti storici");
  });

  it("Marco: in ORT il ruolo per progetto e, accanto, quello della workspace", async () => {
    renderRoute("/admin/people/p-marco", ROBERTA);
    await waitFor(() => expect(document.querySelector("[data-person-workspaces]")).not.toBeNull());
    const roles = [...document.querySelectorAll("[data-person-project-role]")].map((e) => e.textContent);
    expect(roles.some((r) => /· also Developer from Clienti storici$/.test(r ?? ""))).toBe(true);
  });
});
