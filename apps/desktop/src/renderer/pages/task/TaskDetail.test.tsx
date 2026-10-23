import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addComment,
  askDecision,
  failNext,
  getTaskByCode,
  listStalled,
  listTasks,
  resetApi,
  setLatency,
} from "../../data/api";
import { setSessionPersonId } from "../../data/session";
import { ViewerProvider } from "../../data/viewer";
import { createAppRouter } from "../../router";
import { ThemeProvider } from "../../theme/ThemeProvider";

function renderAt(path: string, personId?: string) {
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createAppRouter(history);
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ViewerProvider initialPersonId={personId}>
        <ThemeProvider>
          <RouterProvider router={router} />
        </ThemeProvider>
      </ViewerProvider>
    </QueryClientProvider>,
  );
  return router;
}

/** Il pannello della task (sotto i 1200 px è sovrapposto: un dialogo non modale). */
async function panelOf(code: string) {
  return screen.findByRole("dialog", { name: `Task ${code}` });
}

async function switchPersona(name: RegExp) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Profile and settings" }));
  const menu = await screen.findByRole("dialog", { name: "Profile and settings" });
  await user.click(within(menu).getByRole("radio", { name }));
}

/** Una task aperta di un progetto, non ferma: la decisione nuova sarà il suo motivo. */
async function calmTask(projectId: string, me: string) {
  setSessionPersonId(me);
  const tasks = await listTasks({ projectIds: [projectId], families: ["todo", "active"] });
  const stalled = new Set((await listStalled({ projectIds: [projectId] })).map((r) => r.task.id));
  return tasks.find((t) => !stalled.has(t.id))!;
}

beforeEach(() => {
  setLatency(0);
  resetApi();
});

describe("pannello della task", () => {
  it("si apre su ?task= in ogni route, con codice e titolo; Esc lo chiude", async () => {
    const task = (await getTaskByCode("MKX-2"))!;
    const router = renderAt("/home?task=MKX-2", "p-giulia");
    const panel = await panelOf("MKX-2");
    expect(await within(panel).findByRole("heading", { name: task.title })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    expect(screen.queryByRole("dialog", { name: "Task MKX-2" })).toBeNull();
  });

  it("task inesistente: il pannello lo dice", async () => {
    renderAt("/home?task=MKX-999", "p-giulia");
    const panel = await panelOf("MKX-999");
    expect(
      await within(panel).findByText("This task doesn't exist or you can't see it."),
    ).toBeInTheDocument();
  });

  it("errore di caricamento: Retry", async () => {
    failNext("getTaskByCode");
    renderAt("/home?task=MKX-2", "p-giulia");
    const panel = await panelOf("MKX-2");
    await userEvent.click(await within(panel).findByRole("button", { name: "Retry" }));
    const task = (await getTaskByCode("MKX-2"))!;
    expect(await within(panel).findByRole("heading", { name: task.title })).toBeInTheDocument();
  });

  it("cambiare lo stato scrive una riga nell'attività", async () => {
    setSessionPersonId("p-giulia");
    const task = (await getTaskByCode("MKX-2"))!;
    renderAt("/p/MKX/tasks?task=MKX-2", "p-giulia");
    const panel = await panelOf("MKX-2");
    const status = await within(panel).findByRole("button", { name: /^Status: .*Change$/ });
    await userEvent.click(status);
    const menu = await within(panel).findByRole("menu", { name: "Status of MKX-2" });
    const target = within(menu)
      .getAllByRole("menuitemradio")
      .find((item) => item.getAttribute("aria-checked") === "false")!;
    const name = target.textContent!;
    await userEvent.click(target);
    const feed = within(panel).getByRole("list", { name: "Activity" });
    await waitFor(() =>
      expect(
        within(feed)
          .getAllByRole("listitem")
          .some(
            (li) => /Giulia Ferri/.test(li.textContent!) && li.textContent!.includes(`→ ${name}`),
          ),
      ).toBe(true),
    );
    expect(task.statusId).toBeDefined();
  });

  it("Sara (Contributor) vede i campi in sola lettura ma può commentare", async () => {
    renderAt("/home?task=STW-6", "p-sara");
    const panel = await panelOf("STW-6");
    await within(panel).findByText("Status");
    expect(within(panel).queryByRole("button", { name: /^Status: .*Change$/ })).toBeNull();
    expect(within(panel).queryByRole("button", { name: /^Assignee: .*Change$/ })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Edit description" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Mark as stalled" })).toBeNull();
    expect(within(panel).getByRole("textbox", { name: "Write a comment" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Ask for a decision" })).toBeInTheDocument();
  });

  it("senza tickets.comment: niente commenti né «Ask for a decision»", async () => {
    setSessionPersonId("p-roberta");
    // Andrea ha il ruolo Viewer: entra in MKX come membro.
    const { state } = await import("../../data/store");
    state.projectsById.get("prj-mkx")!.memberIds.push("p-andrea");
    renderAt("/home?task=MKX-2", "p-andrea");
    const panel = await panelOf("MKX-2");
    await within(panel).findByText("Status");
    expect(within(panel).queryByRole("textbox", { name: "Write a comment" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Ask for a decision" })).toBeNull();
  });

  it("eliminare un commento: resta «Comment deleted · by <nome>», senza il testo", async () => {
    setSessionPersonId("p-giulia");
    const task = (await getTaskByCode("MKX-2"))!;
    await addComment(task.id, "Questo testo deve sparire");
    renderAt("/home?task=MKX-2", "p-giulia");
    const panel = await panelOf("MKX-2");
    const text = await within(panel).findByText("Questo testo deve sparire");
    const item = text.closest("li")!;
    await userEvent.click(within(item).getByRole("button", { name: "Delete" }));
    expect(within(item).getByText(/Its text disappears for everyone/)).toBeInTheDocument();
    await userEvent.click(within(item).getByRole("button", { name: "Delete comment" }));
    expect(await within(panel).findByText("Comment deleted · by Giulia Ferri")).toBeInTheDocument();
    expect(within(panel).queryByText("Questo testo deve sparire")).toBeNull();
  });
});

describe("richieste di decisione", () => {
  it("«Ask for a decision» crea la richiesta e la task è ferma per quella persona", async () => {
    const task = await calmTask("prj-mkx", "p-giulia");
    renderAt(`/home?task=${task.code}`, "p-giulia");
    const panel = await panelOf(task.code);
    await userEvent.click(await within(panel).findByRole("button", { name: "Ask for a decision" }));
    const dialog = await screen.findByRole("dialog", { name: "Ask for a decision" });
    await userEvent.click(within(dialog).getByRole("button", { name: /^Who decides/ }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: /Elena Moretti/ }));
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Question" }), "Go or wait?");
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Option 1" }), "Go");
    await userEvent.click(within(dialog).getByRole("button", { name: "Ask" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Ask for a decision" })).toBeNull());
    expect(await within(panel).findByText(/Waiting for Elena's decision/)).toBeInTheDocument();
    expect(within(panel).getByText("Go or wait?")).toBeInTheDocument();
    // Chi ha chiesto può ritirarla.
    expect(within(panel).getByRole("button", { name: "Withdraw" })).toBeInTheDocument();
  });

  it("una seconda richiesta aperta alla stessa persona: il dialogo lo dice", async () => {
    const task = await calmTask("prj-mkx", "p-giulia");
    await askDecision({ taskId: task.id, askedOfId: "p-elena", question: "First?", options: [] });
    renderAt(`/home?task=${task.code}`, "p-giulia");
    const panel = await panelOf(task.code);
    await userEvent.click(await within(panel).findByRole("button", { name: "Ask for a decision" }));
    const dialog = await screen.findByRole("dialog", { name: "Ask for a decision" });
    await userEvent.click(within(dialog).getByRole("button", { name: /^Who decides/ }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: /Elena Moretti/ }));
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Question" }), "Again?");
    await userEvent.click(within(dialog).getByRole("button", { name: "Ask" }));
    expect(
      await within(dialog).findByText(/Elena Moretti already has an open question on this task/),
    ).toBeInTheDocument();
  });

  it("chi è interpellato risponde (cambio persona); chi non ha chiesto non vede «Withdraw»", async () => {
    // Giulia (Contributor in STW) chiede a Laura.
    const task = await calmTask("prj-stw", "p-giulia");
    await askDecision({
      taskId: task.id,
      askedOfId: "p-laura",
      question: "Ship on Friday?",
      options: ["Yes", "No"],
    });
    renderAt(`/home?task=${task.code}`, "p-giulia");
    let panel = await panelOf(task.code);
    expect(await within(panel).findByText("Ship on Friday?")).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "Answer" })).toBeNull();

    await switchPersona(/Laura Costa/);
    panel = await panelOf(task.code);
    expect(await within(panel).findByText("Ship on Friday?")).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "Withdraw" })).toBeNull();
    await userEvent.click(within(panel).getByRole("radio", { name: "Yes" }));
    await userEvent.click(within(panel).getByRole("button", { name: "Answer" }));
    await waitFor(() => expect(within(panel).queryByRole("button", { name: "Answer" })).toBeNull());
    expect(await within(panel).findByText(/Laura Costa chose «Yes»/)).toBeInTheDocument();
    expect(within(panel).queryByText(/Waiting for Laura's decision/)).toBeNull();
  });
});
