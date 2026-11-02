import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convertRequest, failNext, resetApi, setLatency } from "../../data/api";
import { createTaskAs } from "../../data/api-mutations";
import type { AppNotification, ChatMessage, Conversation, Task } from "../../data/model";
import { AUTOMATION_TASKS } from "../../data/seed/automations/created";
import { setSessionPersonId } from "../../data/session";
import { copy, now, state } from "../../data/store";
import { deleteTaskAs } from "../../data/taskDelete";
import { resetViewerGrants, revokeProjectPermission } from "../../data/viewer";
import { renderRoute } from "../../test/renderRoute";

// «Elimina task» (area 10a, Task 10, shape task-delete.md): la voce del menu
// «⋯» della task, il dialogo, il seguito (pannello chiuso, toast, fuoco
// sulla riga che prende il posto) e ciò che la nominava — la richiesta
// d'origine, la notifica, l'esecuzione d'automazione, il codice in Chat.

const MKX = "prj-mkx";
const ACQ = "prj-acq";

afterEach(() => resetViewerGrants());

beforeEach(() => {
  setLatency(0);
  resetApi();
});

/** Una task nuova, creata da `by` (aperta, senza lavoro sopra). */
const newTask = (
  by: string,
  projectId: string,
  title: string,
  extra: Parameters<typeof createTaskAs>[2] = {},
): Task => createTaskAs(by, { projectId, title }, extra);

/** Una sessione di lavoro di Claude sulla task, non finita (copia di una del seme). */
function addRun(task: Task): Conversation {
  const seed = state.conversations.find((c) => c.kind === "task_run")!;
  const c: Conversation = {
    ...copy(seed),
    id: `c-delete-${state.conversations.length}`,
    projectId: task.projectId,
    taskId: task.id,
    state: "working",
  };
  state.conversations.push(c);
  return c;
}

const panelOf = (code: string) => screen.findByRole("dialog", { name: `Task ${code}` });

/** Apre «⋯» della task nel pannello e restituisce menu e bottone. */
async function openMore(user: ReturnType<typeof userEvent.setup>, code: string) {
  const panel = await panelOf(code);
  const more = await within(panel).findByRole("button", { name: `More actions for ${code}` });
  await user.click(more);
  return { more, menu: await screen.findByRole("menu") };
}

/** La voce «Delete task…» quando la vista è arrivata (non più «Checking…»). */
async function deleteItem(menu: HTMLElement) {
  return waitFor(() => {
    const item = within(menu).getByRole("menuitem", { name: /^Delete task…/ });
    expect(menu).not.toHaveTextContent("Checking…");
    return item;
  });
}

async function openDialog(user: ReturnType<typeof userEvent.setup>, code: string) {
  const { more, menu } = await openMore(user, code);
  await user.click(await deleteItem(menu));
  return { more, dialog: await screen.findByRole("dialog", { name: `Delete ${code}?` }) };
}

/** I codici delle righe del corpo della pagina, in ordine (fuori dal pannello). */
const rowCodes = () =>
  [...document.querySelectorAll<HTMLElement>("[data-task-row]")]
    .filter((el) => !el.closest("[data-detail-panel]"))
    .map((el) => el.getAttribute("data-task-row")!);

describe("la voce del menu e il dialogo", () => {
  it("Giulia elimina una sua task: pannello chiuso, toast col codice, riga tolta, fuoco sulla riga che prende il posto", async () => {
    const user = userEvent.setup();
    const task = newTask("p-giulia", MKX, "Prova");
    const router = renderRoute(`/p/MKX/tasks?task=${task.code}`, "p-giulia");
    await waitFor(() => expect(rowCodes()).toContain(task.code));
    const before = rowCodes();
    const at = before.indexOf(task.code);
    const expected = before[at + 1] ?? before[at - 1];
    expect(expected).toBeDefined();

    const { dialog } = await openDialog(user, task.code);
    expect(dialog).toHaveTextContent(`${task.code} “Prova”`);
    expect(dialog).toHaveTextContent("This can't be undone.");
    expect(dialog).toHaveTextContent("Its comments, attachments and history.");
    expect(dialog).toHaveTextContent(`The code ${task.code} won't be used again.`);
    // Il fuoco parte da Cancel; nessun codice da scrivere né riconferma.
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: `Delete ${task.code}` }));

    expect(await screen.findByText(`${task.code} was deleted.`)).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.search).not.toHaveProperty("task"));
    expect(screen.queryByRole("dialog", { name: `Task ${task.code}` })).toBeNull();
    expect(screen.queryByRole("dialog", { name: `Delete ${task.code}?` })).toBeNull();
    await waitFor(() => expect(rowCodes()).not.toContain(task.code));
    await waitFor(() =>
      expect(document.activeElement?.closest("[data-task-row]")?.getAttribute("data-task-row")).toBe(
        expected,
      ),
    );
    expect(document.activeElement).not.toBe(document.body);
    expect(state.tasksById.has(task.id)).toBe(false);
  });

  it("chi modera (Laura in ACQ) elimina una task di un altro", async () => {
    const user = userEvent.setup();
    const task = newTask("p-marco", ACQ, "Di Marco");
    renderRoute(`/p/ACQ/tasks?task=${task.code}`, "p-laura");
    const { dialog } = await openDialog(user, task.code);
    await user.click(within(dialog).getByRole("button", { name: `Delete ${task.code}` }));
    expect(await screen.findByText(`${task.code} was deleted.`)).toBeInTheDocument();
    expect(state.tasksById.has(task.id)).toBe(false);
  });

  it("Cancel: niente cambia e il fuoco torna su «⋯»", async () => {
    const user = userEvent.setup();
    const task = newTask("p-giulia", MKX, "Prova");
    renderRoute(`/p/MKX/tasks?task=${task.code}`, "p-giulia");
    const { more, dialog } = await openDialog(user, task.code);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: `Delete ${task.code}?` })).toBeNull();
    expect(more).toHaveFocus();
    expect(state.tasksById.has(task.id)).toBe(true);
  });

  it("Sara su una task non sua: la voce è spenta, con la frase e «Who?» (deleteTasks)", async () => {
    const user = userEvent.setup();
    const task = newTask("p-laura", ACQ, "Di Laura");
    renderRoute(`/p/ACQ/tasks?task=${task.code}`, "p-sara");
    const { more, menu } = await openMore(user, task.code);
    const item = await deleteItem(menu);
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(menu).toHaveTextContent(
      "Only its author or someone who can moderate tasks in ACQ can delete it. · Who?",
    );
    expect(within(menu).getByRole("menuitem", { name: /Who/ })).toHaveAttribute(
      "data-who-can",
      "deleteTasks",
    );
    await user.click(item);
    expect(screen.queryByRole("dialog", { name: /^Delete/ })).toBeNull();
    await user.keyboard("{Escape}");
    expect(more).toHaveFocus();
  });

  it("una task con una sessione di Claude viva: il dialogo lo dice, il bottone rosso è spento con la frase, senza «Who?»", async () => {
    const user = userEvent.setup();
    const task = newTask("p-giulia", MKX, "Prova");
    const run = addRun(task);
    renderRoute(`/p/MKX/tasks?task=${task.code}`, "p-giulia");
    const { dialog } = await openDialog(user, task.code);
    await within(dialog).findByText(`${task.code} can't be deleted yet`);
    expect(dialog).toHaveTextContent("Claude is working on it.");
    expect(within(dialog).getByRole("link", { name: "Open the session" })).toHaveAttribute(
      "href",
      `/claude/${run.id}`,
    );
    expect(dialog).toHaveTextContent(
      "Wait for it to finish, or close it from its page, then try again.",
    );
    const submit = within(dialog).getByRole("button", { name: `Delete ${task.code}` });
    expect(submit).toBeDisabled();
    expect(submit).toHaveAccessibleDescription("You can delete it when nothing is running on it.");
    expect(dialog.querySelector("[data-who-can]")).toBeNull();
  });

  it("una PR aperta senza numero: la frase senza numero (ruling T2)", async () => {
    const user = userEvent.setup();
    const project = state.projects.find((p) => p.template === "software" && !p.archived)!;
    const task = newTask("p-roberta", project.id, "PR senza numero");
    const run = addRun(task);
    run.state = "finished";
    // Come la scrive la pipeline (`conversation-scripts.ts`): niente numero né link.
    state.conversationEvents.set(run.id, [
      {
        id: "ev-delete-pr",
        at: now(),
        type: "work_result",
        kind: "pr_opened",
        text: `Pull request opened for ${task.code}`,
      },
    ]);
    renderRoute(`/p/${project.code}/tasks?task=${task.code}`, "p-roberta");
    const { dialog } = await openDialog(user, task.code);
    await within(dialog).findByText(`${task.code} can't be deleted yet`);
    expect(dialog).toHaveTextContent("A pull request for it is open.");
    expect(dialog).not.toHaveTextContent("#null");
  });

  it("due figlie: «2 tasks stay, without a parent» e i loro codici", async () => {
    const user = userEvent.setup();
    const parent = newTask("p-laura", ACQ, "Bill download rework");
    const a = newTask("p-laura", ACQ, "Export CSV", { links: [{ kind: "parent", taskId: parent.id }] });
    const b = newTask("p-laura", ACQ, "PDF layout", { links: [{ kind: "parent", taskId: parent.id }] });
    renderRoute(`/p/ACQ/tasks?task=${parent.code}`, "p-laura");
    const { dialog } = await openDialog(user, parent.code);
    const stays = await within(dialog).findByText("2 tasks stay, without a parent:");
    const list = stays.closest("li")!;
    expect(list).toHaveTextContent(`${a.code} “Export CSV”`);
    expect(list).toHaveTextContent(`${b.code} “PDF layout”`);
    await user.click(within(dialog).getByRole("button", { name: `Delete ${parent.code}` }));
    expect(await screen.findByText(`${parent.code} was deleted.`)).toBeInTheDocument();
    expect(state.tasksById.has(a.id)).toBe(true);
    expect(state.tasksById.has(b.id)).toBe(true);
  });

  it("un fallimento poi Retry: il seguito (chiusura e toast) arriva; un doppio clic su Retry elimina una volta", async () => {
    const user = userEvent.setup();
    const task = newTask("p-giulia", MKX, "Prova");
    const router = renderRoute(`/p/MKX/tasks?task=${task.code}`, "p-giulia");
    const { dialog } = await openDialog(user, task.code);
    failNext("deleteTask");
    await user.click(within(dialog).getByRole("button", { name: `Delete ${task.code}` }));
    await within(dialog).findByText(`Couldn't delete ${task.code}. Try again.`);
    expect(state.tasksById.has(task.id)).toBe(true);
    await user.dblClick(within(dialog).getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(`${task.code} was deleted.`)).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.search).not.toHaveProperty("task"));
    expect(screen.queryByRole("dialog", { name: `Delete ${task.code}?` })).toBeNull();
    expect(state.changelog.filter((e) => e.kind === "task.deleted")).toHaveLength(1);
    expect(screen.queryByText(`Can't find ${task.code}.`)).toBeNull();
  });

  it("rifiutato perché nel frattempo l'autrice ha perso il permesso: la frase e «Who?», niente eliminato", async () => {
    const user = userEvent.setup();
    const task = newTask("p-giulia", MKX, "Prova");
    renderRoute(`/p/MKX/tasks?task=${task.code}`, "p-giulia");
    const { dialog } = await openDialog(user, task.code);
    // Nel frattempo Giulia perde la modifica e la moderazione delle task di MKX.
    for (const p of ["tickets.edit", "tickets.moderate"])
      revokeProjectPermission("p-giulia", MKX, p as never);
    await user.click(within(dialog).getByRole("button", { name: `Delete ${task.code}` }));
    await waitFor(() =>
      expect(dialog).toHaveTextContent(
        `You can no longer delete ${task.code}. Nothing was deleted. · Who?`,
      ),
    );
    // Autrice senza più tickets.edit: il «Who?» è quello della modifica (whoAction).
    expect(dialog.querySelector('[data-who-can="editTasks"]')).not.toBeNull();
    expect(state.tasksById.has(task.id)).toBe(true);
  });
});

describe("ciò che la nominava", () => {
  it("la richiesta d'origine dice «Task ACQ-n was deleted», senza link", async () => {
    setSessionPersonId("p-laura");
    const task = await convertRequest("req-acq-1", { title: "Rate" });
    expect(deleteTaskAs("p-laura", task.id)).toEqual({ ok: true });
    renderRoute("/p/ACQ/requests?request=req-acq-1", "p-laura");
    const line = await screen.findByText(`Task ${task.code} was deleted`);
    expect(line.closest("a, button")).toBeNull();
    // La nota della trasformata non promette lavoro «qui sotto» che non c'è più.
    expect(document.querySelector('[data-read-only="converted"]')).toHaveTextContent(
      "Turned into a task, which was later deleted. This request is now read-only.",
    );
    expect(document.querySelector(`[data-request-task="${task.code}"]`)).toBeNull();
    expect(screen.queryByRole("link", { name: new RegExp(task.code, "i") })).toBeNull();
    expect(screen.queryByRole("button", { name: new RegExp(task.code, "i") })).toBeNull();
  });

  it("l'elenco delle richieste non conta le task eliminate", async () => {
    setSessionPersonId("p-laura");
    const task = await convertRequest("req-acq-1", { title: "Rate" });
    expect(deleteTaskAs("p-laura", task.id)).toEqual({ ok: true });
    renderRoute("/p/ACQ/requests", "p-laura");
    // Di base l'elenco mostra le aperte: la trasformata sta in «All».
    await userEvent.click(await screen.findByRole("button", { name: /^Status:/ }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "All" }));
    const row = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-request-row="req-acq-1"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(row).not.toHaveTextContent(/\d+ tasks?$/);
  });

  it("la notifica dice «Task deleted» e non apre niente", async () => {
    const user = userEvent.setup();
    const task = newTask("p-marco", ACQ, "Prova");
    const n: AppNotification = {
      id: "n-delete",
      kind: "ticket.created",
      projectId: ACQ,
      objectCode: task.code,
      departmentId: task.departmentId,
      recipientIds: ["p-laura"],
      title: "New task",
      body: task.title,
      createdAt: now(),
      read: false,
      archived: false,
      snoozedUntil: null,
      link: `#/p/ACQ/tasks?task=${task.code}`,
    };
    state.notifications.push(n);
    expect(deleteTaskAs("p-laura", task.id)).toEqual({ ok: true });
    const router = renderRoute("/home", "p-laura");
    await user.click(await screen.findByRole("button", { name: /^Notifications/ }));
    const item = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-notification="n-delete"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(item).toHaveTextContent("Task deleted");
    const code = item.querySelector("[data-object-code]")!;
    expect(code).toHaveTextContent(task.code);
    expect(code.closest("a, button")).toBeNull();
    await user.click(code);
    expect(router.state.location.search).not.toHaveProperty("task");
  });

  it("l'esecuzione d'automazione che l'aveva creata: «Created task … · task deleted», senza link", async () => {
    const created = AUTOMATION_TASKS[0]!;
    const task = state.tasks.find((t) => t.code === created.code)!;
    expect(deleteTaskAs("p-roberta", task.id)).toEqual({ ok: true });
    renderRoute("/automations/AUT-1/runs/1", "p-roberta");
    const sentence = await waitFor(() => {
      const el = [...document.querySelectorAll<HTMLElement>("[data-entry-path]")].find((e) =>
        e.textContent?.includes(`Created task ${task.code}`),
      );
      expect(el).toBeDefined();
      return el!;
    });
    expect(sentence).toHaveTextContent(`Created task ${task.code} · task deleted`);
    expect(
      [...sentence.querySelectorAll("a")].some((a) => a.textContent?.includes(task.code)),
    ).toBe(false);
  });

  it("il codice scritto nella Chat si legge come uno inesistente (stessa resa di ACQ-99)", async () => {
    const task = newTask("p-laura", ACQ, "Prova");
    expect(deleteTaskAs("p-laura", task.id)).toEqual({ ok: true });
    // Come `put` di ChannelView.test: un messaggio scritto a mano, come il seme.
    const message: ChatMessage = {
      id: "m-delete-code",
      channelId: "ch-acq-general",
      createdAt: now(),
      threadOf: null,
      authorId: "p-marco",
      kind: "person",
      text: `See ${task.code} and ACQ-99 please`,
      attachments: [],
      citations: [],
      reactions: [],
      asksReplyOf: [],
      linkedCodes: [],
      editedAt: null,
      deletedAt: null,
      deletedById: null,
    };
    state.chatMessages.push(message);
    renderRoute("/chat/ch-acq-general", "p-laura");
    const row = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-message="m-delete-code"]');
      expect(el).not.toBeNull();
      return el!;
    });
    const p = [...row.querySelectorAll("p")].find((el) => el.textContent?.includes("ACQ-99"))!;
    expect(p.innerHTML.toLowerCase()).toContain(`see ${task.code} and acq-99 please`.toLowerCase());
    expect(row.textContent!.toLowerCase()).not.toContain("deleted");
    expect(row.querySelector("[data-citation]")).toBeNull();
  });
});
