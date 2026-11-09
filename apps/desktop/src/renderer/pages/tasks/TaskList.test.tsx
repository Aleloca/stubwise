import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { failNext, getTaskByCode, resetApi, setLatency } from "../../data/api";
import { useTasks } from "../../data/queries";
import type { GroupBy, Task } from "../../data/types";
import { renderWithData } from "../../test/renderWithData";
import { ToastRegion, clearToasts } from "../../tasks-ui/Toast";
import { useGroupContext, useStallMap } from "./context";
import { TaskList } from "./TaskList";

beforeEach(() => {
  setLatency(0);
  resetApi();
  clearToasts();
});

/** L'elenco di un progetto, coi dati veri del livello finto (si ricarica dopo le modifiche). */
function Harness({
  projectId,
  groupBy = "none",
  onOpen,
}: {
  projectId: string;
  groupBy?: GroupBy;
  onOpen: (task: Task) => void;
}) {
  const criteria = { projectIds: [projectId], families: ["todo" as const, "active" as const] };
  const tasks = useTasks(criteria).data;
  const ctx = useGroupContext(tasks, projectId);
  const stalls = useStallMap(criteria);
  if (!tasks || !ctx) return null;
  return (
    <>
      <TaskList tasks={tasks} groupBy={groupBy} ctx={ctx} stalls={stalls} onOpen={onOpen} />
      <ToastRegion />
    </>
  );
}

const rows = () => [...document.querySelectorAll<HTMLElement>("[data-task-row]")];
const openButton = (row: HTMLElement) =>
  within(row).getByRole("button", { name: new RegExp(`^${row.dataset.taskRow!}(?!\\d)`) });

describe("TaskList", () => {
  it("con tickets.edit: ⌘+clic e Maiusc+clic selezionano senza aprire, e compare la barra", async () => {
    const onOpen = vi.fn();
    renderWithData(<Harness projectId="prj-mkx" onOpen={onOpen} />, { personId: "p-giulia" });
    await waitFor(() => expect(rows().length).toBeGreaterThan(4));
    const [first, , third] = rows();
    const user = userEvent.setup();

    await user.keyboard("{Meta>}");
    await user.click(openButton(first!));
    await user.keyboard("{/Meta}");
    expect(onOpen).not.toHaveBeenCalled();
    const bar = await screen.findByRole("region", { name: "Change the selected tasks" });
    expect(bar).toHaveTextContent("1 selected");

    await user.keyboard("{Shift>}");
    await user.click(openButton(third!));
    await user.keyboard("{/Shift}");
    expect(bar).toHaveTextContent("3 selected");
    expect(rows().filter((r) => r.dataset.selected === "true")).toHaveLength(3);

    // In blocco: la taglia di tutte e tre.
    await user.click(within(bar).getByRole("button", { name: /Size/ }));
    await user.click(screen.getByRole("menuitemradio", { name: "XL" }));
    for (const code of [first!, rows()[1]!, third!].map((r) => r.dataset.taskRow!)) {
      await waitFor(async () => expect((await getTaskByCode(code))?.size).toBe("XL"));
    }
  });

  it("un clic semplice seleziona e apre (la barra c'è); ⌘A seleziona tutto, Esc toglie", async () => {
    const onOpen = vi.fn();
    renderWithData(<Harness projectId="prj-mkx" onOpen={onOpen} />, { personId: "p-giulia" });
    await waitFor(() => expect(rows().length).toBeGreaterThan(4));
    const user = userEvent.setup();
    await user.click(openButton(rows()[0]!));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByRole("region", { name: "Change the selected tasks" }),
    ).toHaveTextContent("1 selected");
    expect(rows()[0]).toHaveAttribute("data-selected", "true");

    await user.keyboard("{Meta>}a{/Meta}");
    const bar = await screen.findByRole("region", { name: "Change the selected tasks" });
    expect(bar).toHaveTextContent(`${rows().length} selected`);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: "Change the selected tasks" })).toBeNull();
  });

  it("Sara (senza tickets.edit) non seleziona: ⌘+clic apre, nessuna barra né menu in riga", async () => {
    const onOpen = vi.fn();
    renderWithData(<Harness projectId="prj-stw" onOpen={onOpen} />, { personId: "p-sara" });
    await waitFor(() => expect(rows().length).toBeGreaterThan(2));
    const user = userEvent.setup();
    await user.keyboard("{Meta>}");
    await user.click(openButton(rows()[0]!));
    await user.keyboard("{/Meta}");
    expect(onOpen).toHaveBeenCalledTimes(1);
    await user.keyboard("{Meta>}a{/Meta}");
    expect(screen.queryByRole("region", { name: "Change the selected tasks" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Status of/ })).toBeNull();
  });

  it("stato in riga: cambia subito; se non riesce torna com'era e lo dice", async () => {
    renderWithData(<Harness projectId="prj-mkx" groupBy="status" onOpen={() => {}} />, {
      personId: "p-giulia",
    });
    await waitFor(() => expect(rows().length).toBeGreaterThan(4));
    const row = rows()[0]!;
    const code = row.dataset.taskRow!;
    const before = (await getTaskByCode(code))!.statusId;
    const user = userEvent.setup();

    failNext("updateTask");
    await user.click(within(row).getByRole("button", { name: /^Status of/ }));
    const other = screen
      .getAllByRole("menuitemradio")
      .find((item) => item.getAttribute("aria-checked") === "false")!;
    await user.click(other);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      `Couldn't change ${code}. It's back as it was.`,
    );
    expect((await getTaskByCode(code))!.statusId).toBe(before);
  });

  it("raggruppa per stato con intestazioni e conteggi, e ordina per colonna", async () => {
    renderWithData(<Harness projectId="prj-mkx" groupBy="status" onOpen={() => {}} />, {
      personId: "p-giulia",
    });
    const headings = await screen.findAllByRole("heading", { level: 2 });
    expect(headings.map((h) => h.textContent)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^Idea/), expect.stringMatching(/^Draft/)]),
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Sort by Code" }));
    const codes = rows().map((r) => Number(r.dataset.taskRow!.split("-")[1]));
    // Dentro il primo gruppo i codici crescono.
    const firstGroup = within(headings[0]!.closest("section")!)
      .getAllByRole("button", { name: /^MKX-/ })
      .map((b) => Number(b.textContent!.match(/MKX-(\d+)/)![1]));
    expect(firstGroup).toEqual([...firstGroup].sort((a, b) => a - b));
    expect(codes.length).toBeGreaterThan(0);
  });
});
