import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  failNext,
  instance,
  listPinnedProjectIds,
  listProjectPulses,
  listProjects,
  listTasks,
  resetApi,
  setLatency,
  startRun,
} from "../../data/api";
import { setSessionPersonId } from "../../data/session";
import { state } from "../../data/store";
import { resetViewerGrants } from "../../data/viewer";
import { clearToasts } from "../../tasks-ui/Toast";
import { renderRoute } from "../../test/renderRoute";

const path = (router: ReturnType<typeof renderRoute>) => router.state.location.pathname;
const search = (router: ReturnType<typeof renderRoute>) =>
  router.state.matches.at(-1)!.search as Record<string, unknown>;

async function portfolio(personId: string) {
  const router = renderRoute("/projects", personId);
  expect(await screen.findByRole("heading", { level: 1, name: "All projects" })).toBeInTheDocument();
  await screen.findByRole("list", { name: "All projects" });
  return router;
}

const codesIn = (name: string) =>
  [...screen.getByRole("list", { name }).querySelectorAll("[data-project-row]")].map((r) =>
    r.getAttribute("data-project-row"),
  );

/** I valori attesi, letti dal «server» a nome di quella persona. */
async function expected(personId: string) {
  setSessionPersonId(personId);
  const [projects, pulses] = await Promise.all([listProjects(), listProjectPulses()]);
  const waiting = new Set(pulses.filter((p) => p.waitingOnMe).map((p) => p.projectId));
  const sorted = [...projects].sort(
    (a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.code.localeCompare(b.code),
  );
  return {
    waiting: sorted.filter((p) => waiting.has(p.id)).map((p) => p.code),
    rest: sorted.filter((p) => !waiting.has(p.id)).map((p) => p.code),
  };
}

beforeEach(() => {
  setLatency(0);
  resetApi();
});
afterEach(() => {
  resetViewerGrants();
  clearToasts();
});

describe("AllProjectsPage — elenco", () => {
  it("prima i progetti che aspettano chi guarda, poi tutti gli altri in ordine alfabetico", async () => {
    const want = await expected("p-giulia");
    expect(want.waiting.length).toBeGreaterThan(0);
    await portfolio("p-giulia");
    expect(codesIn("Waiting on you")).toEqual(want.waiting);
    expect(codesIn("All projects")).toEqual(want.rest);
    const waiting = screen.getByRole("heading", { level: 2, name: /Waiting on you/ });
    const all = screen.getByRole("heading", { level: 2, name: /All projects/ });
    expect(waiting.compareDocumentPosition(all) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("la riga dice codice, nome, cliente, modello e polso; il nome porta all'Overview", async () => {
    const router = await portfolio("p-giulia");
    const row = document.querySelector<HTMLElement>('[data-project-row="MKX"]')!;
    expect(row).toHaveTextContent("MKX");
    expect(row).toHaveTextContent("Campagne primavera Mix Cucine");
    expect(row).toHaveTextContent("Mix Cucine Srl");
    expect(row).toHaveTextContent("Marketing");
    expect(row.querySelector("[data-pulse-line]")).toHaveTextContent(/stalled/);
    await userEvent.click(within(row).getByRole("link", { name: /Campagne primavera Mix Cucine/ }));
    await waitFor(() => expect(path(router)).toBe("/p/MKX/overview"));
  });

  it("le ferme nel polso aprono le Tasks del progetto filtrate sulle ferme", async () => {
    const router = await portfolio("p-giulia");
    const row = document.querySelector<HTMLElement>('[data-project-row="MKX"]')!;
    await userEvent.click(within(row).getByRole("link", { name: /\d+ stalled/ }));
    await waitFor(() => expect(path(router)).toBe("/p/MKX/tasks"));
    expect(search(router).filters).toEqual({ stalled: true });
  });

  it("Sara non vede «New project»; Roberta sì", async () => {
    await portfolio("p-sara");
    expect(screen.queryByRole("button", { name: "New project" })).toBeNull();
    // Sara vede solo i suoi progetti.
    setSessionPersonId("p-sara");
    const mine = (await listProjects()).length;
    expect(document.querySelectorAll("[data-project-row]").length).toBe(mine);
    expect(document.querySelector('[data-project-row="AUD"]')).toBeNull();
  });

  it("fissa e sgancia dalla riga; un errore rimette com'era e lo dice", async () => {
    await portfolio("p-giulia");
    const row = () => document.querySelector<HTMLElement>('[data-project-row="GLT"]')!;
    setSessionPersonId("p-giulia");
    const pinnedBefore = (await listPinnedProjectIds()).includes("prj-glt");
    const pinLabel = pinnedBefore ? "Unpin GLT" : "Pin GLT";
    failNext("setPinned");
    await userEvent.click(within(row()).getByRole("button", { name: pinLabel }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/GLT/);
    await waitFor(() =>
      expect(within(row()).getByRole("button", { name: pinLabel })).toHaveAttribute(
        "aria-pressed",
        String(pinnedBefore),
      ),
    );
    await userEvent.click(within(row()).getByRole("button", { name: pinLabel }));
    await waitFor(async () => {
      setSessionPersonId("p-giulia");
      expect((await listPinnedProjectIds()).includes("prj-glt")).toBe(!pinnedBefore);
    });
  });

  it("filtri: testo, fissati e reparto (progetti con task aperte di quel reparto)", async () => {
    await portfolio("p-giulia");
    await userEvent.type(screen.getByRole("searchbox", { name: "Code, name or client" }), "mix");
    expect(document.querySelectorAll("[data-project-row]").length).toBe(1);
    await userEvent.clear(screen.getByRole("searchbox", { name: "Code, name or client" }));
    await userEvent.click(screen.getByRole("button", { name: /^Department:/ }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Support" }));
    setSessionPersonId("p-giulia");
    const open = await listTasks({ departmentIds: ["dep-support"], families: ["todo", "active"] });
    const projects = await listProjects();
    const want = new Set(open.map((t) => projects.find((p) => p.id === t.projectId)!.code));
    await waitFor(() => {
      const shown = [...document.querySelectorAll("[data-project-row]")].map((r) =>
        r.getAttribute("data-project-row"),
      );
      expect(new Set(shown)).toEqual(want);
    });
  });

  it("filtri senza risultati: «No projects match» e «Clear filters»", async () => {
    await portfolio("p-giulia");
    await userEvent.type(screen.getByRole("searchbox", { name: "Code, name or client" }), "zzzz");
    expect(await screen.findByRole("heading", { name: "No projects match" })).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: "Clear filters" })[0]!);
    expect(await screen.findByRole("list", { name: "All projects" })).toBeInTheDocument();
  });

  it("errore di caricamento con «Retry»", async () => {
    failNext("listProjectPulses");
    renderRoute("/projects", "p-giulia");
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load the projects.");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("list", { name: "All projects" })).toBeInTheDocument();
  });
});

describe("AllProjectsPage — schede", () => {
  it("Stalled: le ferme raggruppate per progetto, dalla più vecchia", async () => {
    await portfolio("p-giulia");
    await userEvent.click(screen.getByRole("tab", { name: "Stalled" }));
    await waitFor(() => expect(document.querySelector("[data-stalled-project]")).not.toBeNull());
    const groups = [...document.querySelectorAll<HTMLElement>("[data-stalled-project]")];
    expect(groups.length).toBeGreaterThan(1);
    const oldest = (g: HTMLElement) =>
      parseInt(g.querySelector("[data-task-row] .num")!.textContent!, 10);
    for (let i = 1; i < groups.length; i++) {
      expect(oldest(groups[i - 1]!)).toBeGreaterThanOrEqual(oldest(groups[i]!));
    }
    const mkx = groups.find((g) => g.getAttribute("data-stalled-project") === "MKX")!;
    expect(mkx).toHaveTextContent("Campagne primavera Mix Cucine");
    const rows = [...mkx.querySelectorAll("[data-task-row]")].map((r) =>
      r.getAttribute("data-task-row"),
    );
    expect(rows[0]).toBe("MKX-5");
  });

  it("Activity: per giorno, dal più recente, col progetto accanto", async () => {
    await portfolio("p-giulia");
    await userEvent.click(screen.getByRole("tab", { name: "Activity" }));
    await waitFor(() => expect(document.querySelector("[data-activity-day]")).not.toBeNull());
    const days = [...document.querySelectorAll("[data-activity-day]")].map((d) =>
      d.getAttribute("data-activity-day")!,
    );
    expect(days).toEqual([...days].sort().reverse());
    expect(days.every((d) => d <= "2026-10-23")).toBe(true);
    expect(document.querySelector("[data-activity-project]")).not.toBeNull();
  });
});

describe("NewProjectDialog", () => {
  async function openDialog() {
    const router = await portfolio("p-roberta");
    await userEvent.click(screen.getByRole("button", { name: "New project" }));
    const dialog = await screen.findByRole("dialog", { name: "New project" });
    return { router, dialog };
  }

  it("propone il codice dalle iniziali mentre si scrive il nome", async () => {
    const { dialog } = await openDialog();
    await userEvent.type(within(dialog).getByLabelText("Name"), "Brennero Logistics");
    const code = within(dialog).getByLabelText("Code") as HTMLInputElement;
    expect(code.value).toMatch(/^[A-Z]{2,4}$/);
    expect(code.value).toBe("BRL");
  });

  it("un codice già usato è rifiutato con un messaggio chiaro", async () => {
    const { dialog } = await openDialog();
    await userEvent.type(within(dialog).getByLabelText("Name"), "Brennero Logistics");
    const code = within(dialog).getByLabelText("Code");
    await userEvent.clear(code);
    await userEvent.type(code, "AUD");
    expect(within(dialog).getByText("AUD is already used by another project. Try another code.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Create project" }));
    setSessionPersonId("p-roberta");
    expect((await listProjects()).filter((p) => p.code === "AUD").length).toBe(1);
    expect(screen.getByRole("dialog", { name: "New project" })).toBeInTheDocument();
  });

  it("crea il progetto e atterra sulla sua Overview", async () => {
    const { router, dialog } = await openDialog();
    await userEvent.type(within(dialog).getByLabelText("Name"), "Brennero Logistics");
    await userEvent.click(within(dialog).getByRole("radio", { name: /For a client/ }));
    await userEvent.click(screen.getByRole("button", { name: "Create project" }));
    expect(await within(dialog).findByText("Say which client the project is for.")).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText("Client"), "Brennero Logistics Srl");
    await userEvent.click(within(dialog).getByRole("radio", { name: /Software/ }));
    await userEvent.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(path(router)).toBe("/p/BRL/overview"));
    setSessionPersonId("p-roberta");
    const created = (await listProjects()).find((p) => p.code === "BRL")!;
    expect(created).toMatchObject({
      name: "Brennero Logistics",
      kind: "client",
      clientName: "Brennero Logistics Srl",
      template: "software",
    });
  });
});

describe("AllProjectsPage — la coda in pausa (area 9b, shape instance-effects [EF 4])", () => {
  const row = (code: string) => document.querySelector<HTMLElement>(`[data-project-row="${code}"]`)!;

  it("la riga di STW dice «‖ Queue paused» sulla seconda linea, ACQ no; ripresa, sparisce", async () => {
    await portfolio("p-roberta");
    await waitFor(() =>
      expect(row("STW").querySelector("[data-queue-paused]")).toHaveTextContent("Queue paused"),
    );
    expect(row("ACQ").querySelector("[data-queue-paused]")).toBeNull();

    await act(async () => {
      await instance.resumeQueue("prj-stw");
    });
    await waitFor(() => expect(row("STW").querySelector("[data-queue-paused]")).toBeNull());
  });

  it("col budget raggiunto la riga di STW dice ancora «Queue paused»", async () => {
    state.instance.simulate.budgetReached = true;
    await portfolio("p-roberta");
    await waitFor(() =>
      expect(row("STW").querySelector("[data-queue-paused]")).toHaveTextContent("Queue paused"),
    );
  });

  it("con lavoro di Claude in attesa il polso di STW lo dice", async () => {
    setSessionPersonId("p-roberta");
    await startRun("t-stw-7");
    await portfolio("p-roberta");
    await waitFor(() =>
      expect(row("STW").querySelector("[data-pulse-line]")).toHaveTextContent(
        "Claude waiting: queue paused",
      ),
    );
  });
});
