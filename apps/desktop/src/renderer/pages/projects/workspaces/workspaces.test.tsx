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
