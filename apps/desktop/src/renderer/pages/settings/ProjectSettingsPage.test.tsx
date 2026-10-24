import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  failNext,
  getTaskByCode,
  listProjectStatuses,
  listProjects,
  listTasks,
  resetApi,
  setLatency,
} from "../../data/api";
import { setSessionPersonId } from "../../data/session";
import { resetViewerGrants } from "../../data/viewer";
import { clearToasts } from "../../tasks-ui/Toast";
import { renderRoute } from "../../test/renderRoute";

async function settings(code: string, personId: string) {
  renderRoute(`/p/${code}/settings`, personId);
  expect(await screen.findByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
  return screen.findByRole("list", { name: "Statuses, in order" });
}

async function statusesOf(projectId: string) {
  setSessionPersonId("p-roberta");
  return listProjectStatuses(projectId);
}

beforeEach(() => {
  setLatency(0);
  resetApi();
});
afterEach(() => {
  resetViewerGrants();
  clearToasts();
});

describe("ProjectSettingsPage — stati", () => {
  it("elenca gli stati in ordine, con la famiglia e quante task hanno", async () => {
    const list = await settings("STW", "p-roberta");
    const statuses = await statusesOf("prj-stw");
    const rows = [...list.querySelectorAll("[data-status-row]")];
    expect(rows.map((r) => r.getAttribute("data-status-row"))).toEqual(statuses.map((s) => s.id));
    expect(rows.map((r) => r.getAttribute("data-status-family"))).toEqual(
      statuses.map((s) => s.family),
    );
    expect(within(list).getByText("New tasks start here")).toBeInTheDocument();
  });

  it("eliminare uno stato con task chiede dove spostarle, e al salvataggio le task si spostano", async () => {
    const list = await settings("STW", "p-roberta");
    const statuses = await statusesOf("prj-stw");
    const tasks = await listTasks({ projectIds: ["prj-stw"] });
    const victim = statuses.find(
      (s) =>
        s.family === "active" &&
        tasks.some((t) => t.statusId === s.id) &&
        statuses.filter((x) => x.family === "active").length > 1,
    )!;
    const moved = tasks.filter((t) => t.statusId === victim.id);
    const row = list.querySelector<HTMLElement>(`[data-status-row="${victim.id}"]`)!;
    await userEvent.click(within(row).getByRole("button", { name: `Delete ${victim.name}` }));
    const dialog = await screen.findByRole("dialog", { name: `Delete “${victim.name}”?` });
    const target = statuses.find((s) => s.family === "closed")!;
    await userEvent.click(within(dialog).getByRole("radio", { name: new RegExp(target.name) }));
    await userEvent.click(within(dialog).getByRole("button", { name: /^Delete and move/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
    // Ancora una bozza: niente è cambiato.
    expect((await statusesOf("prj-stw")).some((s) => s.id === victim.id)).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(async () =>
      expect((await statusesOf("prj-stw")).some((s) => s.id === victim.id)).toBe(false),
    );
    for (const task of moved) {
      setSessionPersonId("p-roberta");
      expect((await getTaskByCode(task.code))!.statusId).toBe(target.id);
    }
  });

  it("aggiungere, rinominare ed eliminare con spostamento sullo stato nuovo, in un solo salvataggio", async () => {
    const list = await settings("STW", "p-roberta");
    const statuses = await statusesOf("prj-stw");
    const tasks = await listTasks({ projectIds: ["prj-stw"] });
    const victim = statuses.find((s) => s.family === "todo" && tasks.some((t) => t.statusId === s.id))!;
    await userEvent.click(screen.getByRole("button", { name: "Add status" }));
    const inputs = within(list).getAllByRole("textbox", { name: "Status name" });
    await userEvent.type(inputs.at(-1)!, "Backlog");
    const newRow = list.querySelectorAll<HTMLElement>("[data-status-row]")[statuses.length]!;
    await userEvent.click(within(newRow).getByRole("button", { name: /^Family of Backlog/ }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "To do" }));
    const row = list.querySelector<HTMLElement>(`[data-status-row="${victim.id}"]`)!;
    await userEvent.click(within(row).getByRole("button", { name: `Delete ${victim.name}` }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("radio", { name: /Backlog/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: /^Delete and move/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(async () =>
      expect((await statusesOf("prj-stw")).some((s) => s.name === "Backlog")).toBe(true),
    );
    const backlog = (await statusesOf("prj-stw")).find((s) => s.name === "Backlog")!;
    const moved = tasks.filter((t) => t.statusId === victim.id);
    for (const task of moved) {
      setSessionPersonId("p-roberta");
      expect((await getTaskByCode(task.code))!.statusId).toBe(backlog.id);
    }
  });

  it("togliere l'ultimo stato `closed` è impedito, con la spiegazione", async () => {
    // UFF nasce dal modello vuoto: un solo stato chiuso, «Done».
    const list = await settings("UFF", "p-roberta");
    const statuses = await statusesOf("prj-uff");
    const closed = statuses.filter((s) => s.family === "closed");
    expect(closed).toHaveLength(1);
    const row = list.querySelector<HTMLElement>(`[data-status-row="${closed[0]!.id}"]`)!;
    await userEvent.click(within(row).getByRole("button", { name: `Delete ${closed[0]!.name}` }));
    expect(await within(row).findByRole("alert")).toHaveTextContent(
      `${closed[0]!.name} is the only Closed status, and every project needs one.`,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(row.isConnected).toBe(true);
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("un salvataggio che fallisce lo dice e tiene la bozza", async () => {
    const list = await settings("STW", "p-roberta");
    const input = within(list).getAllByRole("textbox", { name: "Status name" })[0]!;
    await userEvent.clear(input);
    await userEvent.type(input, "Inbox");
    failNext("setProjectStatuses");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't save the statuses.");
    expect(input).toHaveValue("Inbox");
    expect((await statusesOf("prj-stw")).some((s) => s.name === "Inbox")).toBe(false);
  });

  it("le soglie «Stalled after N days» si cambiano e si salvano", async () => {
    await settings("STW", "p-roberta");
    const active = screen.getByRole("spinbutton", { name: "In progress tasks" });
    expect(active).toHaveValue(7);
    expect(screen.getByRole("spinbutton", { name: /To-do tasks/ })).toHaveValue(14);
    await userEvent.clear(active);
    await userEvent.type(active, "10");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(async () => {
      setSessionPersonId("p-roberta");
      const stw = (await listProjects()).find((p) => p.id === "prj-stw")!;
      expect(stw.stallThresholds).toEqual({ activeDays: 10, todoDays: 14 });
    });
  });

  it("senza project.settings.manage: sola lettura, e la frase che dice chi può", async () => {
    const list = await settings("STW", "p-sara");
    expect(within(list).queryByRole("textbox")).toBeNull();
    expect(within(list).queryByRole("button")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
    expect(screen.queryByRole("spinbutton")).toBeNull();
    expect(
      screen.getByText(/Only people who manage this project's settings can change them\./),
    ).toBeInTheDocument();
  });
});
