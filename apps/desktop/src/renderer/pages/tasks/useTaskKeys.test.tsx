import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetApi, setLatency } from "../../data/api";
import { renderRoute } from "../../test/renderRoute";

const search = (router: ReturnType<typeof renderRoute>) =>
  router.state.matches.at(-1)!.search as { task?: string };

/** I codici delle righe dell'elenco, nell'ordine in cui si vedono. */
const listCodes = () =>
  [...document.querySelectorAll("[data-tasks-body] [data-task-row]")].map(
    (el) => el.getAttribute("data-task-row")!,
  );

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setLatency(0);
  resetApi();
  writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
});

async function openFirst() {
  const router = renderRoute("/p/MKX/tasks", "p-giulia");
  await waitFor(() => expect(listCodes().length).toBeGreaterThan(2));
  const [first] = listCodes();
  await router.navigate({ to: ".", search: (prev: object) => ({ ...prev, task: first }) } as never);
  await waitFor(() => expect(document.querySelector(`[data-task-detail="${first}"]`)).not.toBeNull());
  return router;
}

describe("J/K e ⌘C sulle pagine di task", () => {
  it("J va alla task dopo nell'ordine della vista, K a quella prima", async () => {
    const router = await openFirst();
    const codes = listCodes();
    await userEvent.keyboard("j");
    await waitFor(() => expect(search(router).task).toBe(codes[1]));
    await userEvent.keyboard("j");
    await waitFor(() => expect(search(router).task).toBe(codes[2]));
    await userEvent.keyboard("k");
    await waitFor(() => expect(search(router).task).toBe(codes[1]));
  });

  it("K sulla prima resta sulla prima; senza pannello aperto J non fa nulla", async () => {
    const router = await openFirst();
    const [first] = listCodes();
    await userEvent.keyboard("k");
    expect(search(router).task).toBe(first);
    await router.navigate({ to: ".", search: (prev: object) => ({ ...prev, task: undefined }) } as never);
    await waitFor(() => expect(search(router).task).toBeUndefined());
    document.body.focus();
    await userEvent.keyboard("j");
    expect(search(router).task).toBeUndefined();
  });

  it("non scatta scrivendo in un campo né con un dialogo aperto", async () => {
    const router = await openFirst();
    const [first] = listCodes();
    const box = screen.getByRole("searchbox", { name: "Search tasks" });
    await userEvent.click(box);
    await userEvent.keyboard("j");
    expect(search(router).task).toBe(first);
    expect(box).toHaveValue("j");
    const toolbar = screen.getByRole("toolbar", { name: "Tasks commands" });
    await userEvent.click(within(toolbar).getByRole("button", { name: "Save as filter" }));
    const dialog = await screen.findByRole("dialog", { name: "Save as filter" });
    within(dialog).getByRole("radio", { name: /Private/ }).focus();
    await userEvent.keyboard("j");
    expect(search(router).task).toBe(first);
  });

  it("Ctrl+C (fuori da mac) copia il codice della task col fuoco e lo dice", async () => {
    renderRoute("/p/MKX/tasks", "p-giulia");
    await waitFor(() => expect(listCodes().length).toBeGreaterThan(1));
    const second = listCodes()[1]!;
    const row = document.querySelector<HTMLElement>(`[data-tasks-body] [data-task-row="${second}"]`)!;
    row.querySelector<HTMLElement>("button")!.focus();
    await userEvent.keyboard("{Control>}c{/Control}");
    expect(writeText).toHaveBeenCalledWith(second);
    expect(await screen.findByText(`Copied ${second}.`)).toBeInTheDocument();
  });

  it("Ctrl+C senza una task col fuoco copia quella aperta nel pannello", async () => {
    const router = await openFirst();
    document.body.focus();
    await userEvent.keyboard("{Control>}c{/Control}");
    expect(writeText).toHaveBeenCalledWith(search(router).task);
  });
});
