import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetApi, setLatency } from "../../data/api";
import { useMilestones } from "../../data/queries";
import type { GroupBy, Task } from "../../data/types";
import { makeTask } from "../../domain/fixtures";
import { renderWithData } from "../../test/renderWithData";
import { useGroupContext } from "./context";
import { TaskTimeline, weekRange } from "./TaskTimeline";

beforeEach(() => {
  setLatency(0);
  resetApi();
});

function Harness({
  tasks,
  groupBy = "none",
  onOpen = () => {},
}: {
  tasks: Task[];
  groupBy?: GroupBy;
  onOpen?: (task: Task) => void;
}) {
  const ctx = useGroupContext(tasks, "prj-mkx");
  const milestones = useMilestones("prj-mkx").data;
  if (!ctx || !milestones) return null;
  return (
    <TaskTimeline
      tasks={tasks}
      groupBy={groupBy}
      ctx={ctx}
      milestones={milestones}
      stalls={new Map()}
      onOpen={onOpen}
    />
  );
}

const base = { projectId: "prj-mkx", statusId: "st-mkx-2", departmentId: "dep-marketing" };

describe("TaskTimeline", () => {
  it("l'asse va da 2 settimane prima di oggi a 8 dopo", () => {
    expect(weekRange()).toEqual([
      "2026-W41",
      "2026-W42",
      "2026-W43",
      "2026-W44",
      "2026-W45",
      "2026-W46",
      "2026-W47",
      "2026-W48",
      "2026-W49",
      "2026-W50",
      "2026-W51",
    ]);
  });

  it("una task con le due date è una barra lunga quanto la sua durata; con la sola scadenza è un punto", async () => {
    const tasks = [
      makeTask({ ...base, id: "a", code: "MKX-901", title: "Bar", plannedWeek: "2026-W44", dueDate: "2026-11-06" }),
      makeTask({ ...base, id: "b", code: "MKX-902", title: "Dot", dueDate: "2026-10-28" }),
    ];
    renderWithData(<Harness tasks={tasks} />, { personId: "p-giulia" });
    const bar = await screen.findByRole("button", { name: /^MKX-901 Bar, from/ });
    expect(bar).toHaveAttribute("data-shape", "bar");
    // W44 (lun 26 ott) → ven 6 nov: 12 giorni.
    expect(bar.dataset.days).toBe("12");
    const dot = screen.getByRole("button", { name: /^MKX-902 Dot, due/ });
    expect(dot).toHaveAttribute("data-shape", "point");
  });

  it("una task con la sola settimana è un punto; senza date finisce in «No dates»", async () => {
    const onOpen = vi.fn();
    const tasks = [
      makeTask({ ...base, id: "c", code: "MKX-903", title: "Week only", plannedWeek: "2026-W45" }),
      makeTask({ ...base, id: "d", code: "MKX-904", title: "Undated" }),
    ];
    renderWithData(<Harness tasks={tasks} onOpen={onOpen} />, { personId: "p-giulia" });
    expect(
      await screen.findByRole("button", { name: /^MKX-903 Week only, planned for/ }),
    ).toHaveAttribute("data-shape", "point");
    const noDates = screen.getByRole("region", { name: "No dates" });
    expect(within(noDates).getByText("Undated")).toBeInTheDocument();
    expect(document.querySelector(`[data-timeline-item="MKX-904"]`)).toBeNull();
    await userEvent.click(within(noDates).getByRole("button", { name: /^MKX-904/ }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ code: "MKX-904" }));
  });

  it("mostra oggi e i traguardi del progetto come linee col nome", async () => {
    renderWithData(<Harness tasks={[]} />, { personId: "p-giulia" });
    await waitFor(() => expect(document.querySelector("[data-today]")).not.toBeNull());
    const lines = [...document.querySelectorAll<HTMLElement>("[data-milestone]")];
    for (const line of lines) expect(line.getAttribute("aria-label")).toMatch(/^Milestone /);
  });
});
