import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetApi, setLatency } from "../data/api";
import { PEOPLE } from "../data/seed/people";
import { TASKS } from "../data/seed/tasks";
import type { Stall } from "../domain/stalled";
import { renderWithData } from "../test/renderWithData";
import { TaskRow } from "./TaskRow";

beforeEach(() => {
  setLatency(0);
  resetApi();
});

const task = TASKS.find(
  (t) => t.projectId === "prj-mkx" && t.departmentId === "dep-marketing" && t.assigneeId,
)!;
const assignee = PEOPLE.find((p) => p.id === task.assigneeId)!;

describe("TaskRow", () => {
  it("mostra codice e titolo, il titolo intero nel `title`, e apre al clic", async () => {
    const onOpen = vi.fn();
    renderWithData(<TaskRow task={task} onOpen={onOpen} />);
    const row = document.querySelector<HTMLElement>(`[data-task-row="${task.code}"]`)!;
    expect(within(row).getByText(task.code)).toBeInTheDocument();
    const title = within(row).getByText(task.title);
    expect(title).toHaveAttribute("title", task.title);

    await userEvent.click(within(row).getByRole("button", { name: new RegExp(task.code) }));
    expect(onOpen).toHaveBeenCalledWith(task);
  });

  it("ha la striscia del reparto col nome accessibile, lo stato e l'assegnatario", async () => {
    renderWithData(<TaskRow task={task} onOpen={() => {}} />);
    const row = document.querySelector<HTMLElement>(`[data-task-row="${task.code}"]`)!;
    expect(await within(row).findByText("Department: Marketing")).toHaveClass("sr-only");
    expect(row.querySelector("[data-dept-strip]")).not.toBeNull();
    expect(await within(row).findByText(assignee.name)).toBeInTheDocument();
    expect(row.querySelector("[data-status-family]")).not.toBeNull();
  });

  it("mostra il segno «ferma» solo se è ferma, col motivo", async () => {
    const stall: Stall = { reason: { kind: "unassigned" }, since: "2026-10-19", days: 4 };
    const { rerender } = renderWithData(<TaskRow task={task} onOpen={() => {}} />);
    expect(document.querySelector("[data-stall-mark]")).toBeNull();
    rerender(<TaskRow task={task} stall={stall} onOpen={() => {}} />);
    const mark = document.querySelector<HTMLElement>("[data-stall-mark]")!;
    expect(mark).toHaveTextContent("Nobody assigned · 4 days");
  });

  it("un clic su una cella apre la task una volta sola, come il bottone", async () => {
    const onOpen = vi.fn();
    renderWithData(<TaskRow task={task} onOpen={onOpen} />);
    const row = document.querySelector<HTMLElement>(`[data-task-row="${task.code}"]`)!;
    await userEvent.click(await within(row).findByText(assignee.name));
    expect(onOpen).toHaveBeenCalledTimes(1);
    await userEvent.click(within(row).getByRole("button", { name: new RegExp(task.code) }));
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("il bottone porta il titolo intero; le celle col tooltip stanno sopra lo strato del clic", async () => {
    renderWithData(<TaskRow task={task} onOpen={() => {}} />);
    const row = document.querySelector<HTMLElement>(`[data-task-row="${task.code}"]`)!;
    expect(within(row).getByRole("button", { name: new RegExp(task.code) })).toHaveAttribute(
      "title",
      task.title,
    );
    const person = await within(row).findByText(assignee.name);
    expect(person.closest("[data-person]")!.parentElement).toHaveClass("relative");
    expect(row.querySelector("[data-status-family]")!.parentElement).toHaveClass("relative");
  });

  it("la riga selezionata lo dichiara", () => {
    renderWithData(<TaskRow task={task} selected onOpen={() => {}} />);
    const row = document.querySelector<HTMLElement>(`[data-task-row="${task.code}"]`)!;
    expect(row).toHaveAttribute("data-selected", "true");
    expect(screen.getByRole("button", { name: new RegExp(task.code) })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });
});
