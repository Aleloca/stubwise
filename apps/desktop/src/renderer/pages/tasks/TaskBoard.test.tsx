import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  failNext,
  getTaskByCode,
  listProjectStatuses,
  resetApi,
  setLatency,
  setProjectStatuses,
} from "../../data/api";
import { useTasks } from "../../data/queries";
import { setSessionPersonId } from "../../data/session";
import type { Task } from "../../data/types";
import { renderWithData } from "../../test/renderWithData";
import { ToastRegion, clearToasts } from "../../tasks-ui/Toast";
import { useGroupContext, useStallMap } from "./context";
import i18n from "../../i18n";
import { TaskBoard, pointerAnnouncements } from "./TaskBoard";

beforeEach(() => {
  setLatency(0);
  resetApi();
  clearToasts();
});

function Harness({
  projectId,
  lanes = "none",
  onOpen = () => {},
}: {
  projectId: string;
  lanes?: "none" | "assignee" | "department";
  onOpen?: (task: Task) => void;
}) {
  const criteria = { projectIds: [projectId] };
  const tasks = useTasks(criteria).data;
  const ctx = useGroupContext(tasks, projectId);
  const stalls = useStallMap(criteria);
  if (!tasks || !ctx) return null;
  return (
    <>
      <TaskBoard
        tasks={tasks}
        projectId={projectId}
        lanes={lanes}
        ctx={ctx}
        stalls={stalls}
        onOpen={onOpen}
      />
      <ToastRegion />
    </>
  );
}

const columnNames = () =>
  [...document.querySelectorAll<HTMLElement>("[data-column-header]")].map((h) => h.title);
const columnOf = (code: string) =>
  document.querySelector(`[data-card="${code}"]`)?.closest<HTMLElement>("[data-column]")?.dataset
    .column;

/** La prima carta del primo stato `todo` di MKX. */
async function firstTodoCard(): Promise<HTMLElement> {
  const statuses = await listProjectStatuses("prj-mkx");
  const todo = statuses.find((s) => s.family === "todo")!;
  await waitFor(() =>
    expect(document.querySelector(`[data-column="${todo.id}"] [data-card]`)).not.toBeNull(),
  );
  return document.querySelector<HTMLElement>(`[data-column="${todo.id}"] [data-card]`)!;
}

describe("TaskBoard", () => {
  it("una colonna per stato, nell'ordine del progetto", async () => {
    setSessionPersonId("p-giulia");
    const statuses = await listProjectStatuses("prj-mkx");
    renderWithData(<Harness projectId="prj-mkx" />, { personId: "p-giulia" });
    await waitFor(() => expect(columnNames()).toEqual(statuses.map((s) => s.name)));
  });

  it("tastiera: Spazio prende, freccia destra sposta, Spazio lascia → lo stato cambia", async () => {
    renderWithData(<Harness projectId="prj-mkx" />, { personId: "p-giulia" });
    const card = await firstTodoCard();
    const code = card.dataset.card!;
    const statuses = await listProjectStatuses("prj-mkx");
    const next = statuses[statuses.findIndex((s) => s.family === "todo") + 1]!;
    const user = userEvent.setup();

    card.focus();
    await user.keyboard(" ");
    expect(screen.getByTestId("board-announcer")).toHaveTextContent(`Picked up ${code}`);
    await user.keyboard("{ArrowRight}");
    expect(screen.getByTestId("board-announcer")).toHaveTextContent(
      `${code} is over ${next.name}.`,
    );
    await user.keyboard(" ");
    await waitFor(async () => expect((await getTaskByCode(code))!.statusId).toBe(next.id));
    await waitFor(() => expect(columnOf(code)).toBe(next.id));
    expect(screen.getByTestId("board-announcer")).toHaveTextContent(
      `${code} moved to ${next.name}.`,
    );
    // La carta rinata nella colonna nuova ha ancora il fuoco.
    await waitFor(() =>
      expect((document.activeElement as HTMLElement | null)?.dataset.card).toBe(code),
    );
    expect(document.activeElement!.closest<HTMLElement>("[data-column]")!.dataset.column).toBe(
      next.id,
    );
  });

  it("Esc annulla e Invio apre", async () => {
    const onOpen = vi.fn();
    renderWithData(<Harness projectId="prj-mkx" onOpen={onOpen} />, { personId: "p-giulia" });
    const card = await firstTodoCard();
    const code = card.dataset.card!;
    const before = (await getTaskByCode(code))!.statusId;
    const user = userEvent.setup();
    card.focus();
    await user.keyboard(" {ArrowRight}{Escape}");
    expect(screen.getByTestId("board-announcer")).toHaveTextContent("Move cancelled");
    expect((await getTaskByCode(code))!.statusId).toBe(before);
    await user.keyboard("{Enter}");
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ code }));
  });

  it("se lo spostamento non riesce la carta torna dov'era e il messaggio lo dice", async () => {
    renderWithData(<Harness projectId="prj-mkx" />, { personId: "p-giulia" });
    const card = await firstTodoCard();
    const code = card.dataset.card!;
    const origin = columnOf(code);
    const user = userEvent.setup();
    failNext("updateTask");
    card.focus();
    await user.keyboard(" {ArrowRight} ");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      `Couldn't move ${code}. It's back where it was.`,
    );
    await waitFor(() => expect(columnOf(code)).toBe(origin));
    // Anche dopo il ritorno indietro il fuoco è sulla carta, nella colonna d'origine.
    await waitFor(() =>
      expect((document.activeElement as HTMLElement | null)?.dataset.card).toBe(code),
    );
    expect(document.activeElement!.closest<HTMLElement>("[data-column]")!.dataset.column).toBe(
      origin,
    );
  });

  it("senza tickets.edit le carte non si prendono, ma si aprono", async () => {
    const onOpen = vi.fn();
    renderWithData(<Harness projectId="prj-stw" onOpen={onOpen} />, { personId: "p-sara" });
    await waitFor(() => expect(document.querySelector("[data-card]")).not.toBeNull());
    expect(screen.getByText("You can open these tasks but not move them.")).toBeInTheDocument();
    const card = document.querySelector<HTMLElement>("[data-card]")!;
    expect(card).not.toHaveAttribute("aria-roledescription");
    const user = userEvent.setup();
    card.focus();
    await user.keyboard(" ");
    expect(screen.getByTestId("board-announcer")).toHaveTextContent("");
    await user.keyboard("{Enter}");
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("un nome di stato lungo si tronca e resta intero nel `title` (Review Focus 5)", async () => {
    setSessionPersonId("p-giulia");
    const statuses = await listProjectStatuses("prj-mkx");
    const long = "In approvazione dal cliente finale e dall'ufficio legale";
    await act(() =>
      setProjectStatuses(
        "prj-mkx",
        statuses.map((s) => ({
          id: s.id,
          name: s.name === "In approval" ? long : s.name,
          family: s.family,
        })),
        {},
      ),
    );
    renderWithData(<Harness projectId="prj-mkx" />, { personId: "p-giulia" });
    await waitFor(() => expect(columnNames()).toContain(long));
    const header = [...document.querySelectorAll<HTMLElement>("[data-column-header]")].find(
      (h) => h.title === long,
    )!;
    expect(within(header).getByText(long)).toHaveClass("truncate");
    const column = document.querySelector<HTMLElement>(`[data-column="${header.dataset.columnHeader}"]`)!;
    expect(column).toHaveAccessibleName(new RegExp(`^${long}, \\d+ tasks?$`));
  });

  it("corsie per assegnatario: spostare in un'altra corsia cambia l'assegnatario", async () => {
    renderWithData(<Harness projectId="prj-mkx" lanes="assignee" />, { personId: "p-giulia" });
    const card = await firstTodoCard();
    const code = card.dataset.card!;
    const before = (await getTaskByCode(code))!.assigneeId;
    const user = userEvent.setup();
    card.focus();
    await user.keyboard(" {ArrowDown} ");
    await waitFor(async () => expect((await getTaskByCode(code))!.assigneeId).not.toBe(before));
  });
});

describe("pointerAnnouncements", () => {
  const place = (id: string) =>
    id === "st-mkx-2::all"
      ? { column: "Draft", lane: "" }
      : id === "st-mkx-1::all"
        ? { column: "Idea", lane: "" }
        : undefined;
  const code = (id: string) => (id === "t-mkx-4" ? "MKX-4" : undefined);
  const active = { id: "t-mkx-4", data: { current: { cell: "st-mkx-1::all" } } };

  it("dice codice e colonne, tradotti, mai gli id interni", async () => {
    const a = pointerAnnouncements(i18n.t, code, place);
    const start = a.onDragStart({ active } as never)!;
    const over = a.onDragOver({ active, over: { id: "st-mkx-2::all" } } as never)!;
    expect(start).toBe("Picked up MKX-4, in Idea.");
    expect(over).toBe("MKX-4 is over Draft.");
    expect(a.onDragEnd({ active, over: { id: "st-mkx-2::all" } } as never)).toBeUndefined();
    expect(a.onDragCancel({ active, over: null } as never)).toBe(
      "Move cancelled. MKX-4 is back in Idea.",
    );
    for (const text of [start, over]) expect(text).not.toMatch(/t-mkx|st-mkx|::/);

    await i18n.changeLanguage("it");
    try {
      const it = pointerAnnouncements(i18n.t, code, place);
      expect(it.onDragOver({ active, over: { id: "st-mkx-2::all" } } as never)).toBe(
        "MKX-4 è sopra Draft.",
      );
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});
