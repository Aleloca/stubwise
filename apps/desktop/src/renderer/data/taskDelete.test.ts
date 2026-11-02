import { beforeEach, describe, expect, it } from "vitest";
import { linksOf } from "../domain/links";
import {
  access,
  changelog,
  convertRequest,
  getRequest,
  getRequestByCode,
  getTaskByCode,
  listNotifications,
  listPeopleActivity,
  listPortfolioActivity,
  listRequests,
  listTimeline,
  resetApi,
  setLatency,
} from "./api";
import { createTaskAs } from "./api-mutations";
import { viewRun } from "./automations/runView";
import type { AppNotification, Conversation, Task } from "./model";
import { CLAUDE_ID } from "./seed/people";
import { setSessionPersonId } from "./session";
import { copy, now, state } from "./store";
import { canDeleteTask, deleteTask, deleteTaskAs, getTaskDeletion } from "./taskDelete";

// «Elimina task» (area 10a, Task 2), livello dati. Chi: l'autore con
// `tickets.edit` o chi ha `tickets.moderate` (maintainer); Claude collega
// non elimina una task che non ha creato (R-L9, P24). Una task eliminata si
// legge come un codice che non è mai esistito (R-G5) e il suo codice non
// torna (`state.deletedTasks`).

const ACQ = "prj-acq";
const as = (personId: string) => setSessionPersonId(personId);

beforeEach(() => {
  resetApi();
  setLatency(0);
});

/** Una task nuova in ACQ, creata da `by` (aperta, senza lavoro sopra). */
const newTask = (by: string, title = "Prova", projectId = ACQ): Task =>
  createTaskAs(by, { projectId, title });

/** Lo stato che una scrittura rifiutata non deve toccare. */
const snapshot = () =>
  JSON.stringify({
    tasks: state.tasks,
    deletedTasks: state.deletedTasks,
    activity: state.activity,
    changelog: state.changelog,
  });

/** Una sessione di lavoro della task, nello stato dato (copia di una del seme). */
function addRun(task: Task, runState: Conversation["state"]): Conversation {
  const seed = state.conversations.find((c) => c.kind === "task_run")!;
  const c: Conversation = {
    ...copy(seed),
    id: `c-test-${state.conversations.length}`,
    projectId: task.projectId,
    taskId: task.id,
    state: runState,
  };
  state.conversations.push(c);
  return c;
}

describe("chi elimina", () => {
  it("l'autore con tickets.edit elimina la sua; un altro senza tickets.moderate no; chi modera sì", () => {
    // Marco (Developer in ACQ) crea due task.
    const own = newTask("p-marco", "Mia");
    expect(deleteTaskAs("p-marco", own.id)).toEqual({ ok: true });
    expect(state.tasksById.has(own.id)).toBe(false);

    const other = newTask("p-marco", "Di Marco");
    // Sara (Contributor in ACQ): né autrice né moderatrice.
    const before = snapshot();
    expect(deleteTaskAs("p-sara", other.id)).toEqual({ ok: false, error: "forbidden" });
    expect(snapshot()).toBe(before);
    expect(state.changelog.filter((e) => e.kind === "task.deleted")).toHaveLength(1);

    // Laura (Project Lead in ACQ) ha tickets.moderate.
    expect(deleteTaskAs("p-laura", other.id)).toEqual({ ok: true });
    expect(state.tasksById.has(other.id)).toBe(false);
  });

  it("invisibile o inesistente: not_found, prima del permesso", () => {
    const task = newTask("p-marco");
    // Giulia non è membro di ACQ.
    expect(deleteTaskAs("p-giulia", task.id)).toEqual({ ok: false, error: "not_found" });
    expect(deleteTaskAs("p-laura", "t-nope")).toEqual({ ok: false, error: "not_found" });
    expect(state.tasksById.has(task.id)).toBe(true);
  });

  it("Claude collega non elimina una task che non ha creato, e «Who?» non lo include (P24)", async () => {
    const task = newTask("p-marco");
    expect(canDeleteTask(CLAUDE_ID, task)).toBe(false);
    expect(deleteTaskAs(CLAUDE_ID, task.id)).toEqual({ ok: false, error: "forbidden" });
    expect(state.tasksById.has(task.id)).toBe(true);
    as("p-laura");
    const who = await access.whoCan("deleteTasks", ACQ);
    if (!who.visible) throw new Error("invisibile");
    expect(who.permission).toBe("tickets.moderate");
    expect(who.claude.allowed).toBe(false);
    expect(who.people.map((p) => p.personId)).not.toContain(CLAUDE_ID);
    expect(who.people.map((p) => p.personId)).toContain("p-laura");
  });
});

describe("busy", () => {
  it("una sessione di Claude non finita (anche in attesa) blocca; una finita no", () => {
    const task = newTask("p-marco");
    const run = addRun(task, "working");
    const res = deleteTaskAs("p-laura", task.id);
    expect(res).toEqual({
      ok: false,
      error: "busy",
      reasons: [{ kind: "claude_session", code: task.code }],
    });
    expect(state.tasksById.has(task.id)).toBe(true);
    expect(state.changelog.some((e) => e.kind === "task.deleted")).toBe(false);

    // Ferma, in attesa della coda in pausa (area 9b): non lavora ancora, ma conta.
    run.state = "paused";
    run.waiting = { reason: "queue_paused", byId: "p-laura", byName: "Laura Costa", since: now() };
    expect(deleteTaskAs("p-laura", task.id)).toMatchObject({ ok: false, error: "busy" });

    run.state = "finished";
    expect(deleteTaskAs("p-laura", task.id)).toEqual({ ok: true });
  });

  it("chi non vede la sessione legge la ragione senza codice", async () => {
    const task = newTask("p-sara", "Di Sara");
    addRun(task, "working");
    // Sara (Contributor, senza repos.view) non vede le sessioni di lavoro.
    as("p-sara");
    const view = await getTaskDeletion(task.id);
    expect(view?.busy).toEqual([{ kind: "claude_session", code: null }]);
  });

  it("una PR aperta blocca", () => {
    const project = state.projects.find((p) => p.template === "software" && !p.archived)!;
    const task = newTask("p-roberta", "Con PR", project.id);
    state.pullRequests.push({
      id: "pr-test",
      projectId: project.id,
      taskId: task.id,
      kind: "pr_opened",
      at: now(),
      number: 42,
      repo: "acme/audin-web",
    });
    expect(deleteTaskAs("p-roberta", task.id)).toEqual({
      ok: false,
      error: "busy",
      reasons: [{ kind: "open_pr", repo: "acme/audin-web", number: 42 }],
    });
  });

  it("una PR aperta dalla pipeline senza numero né link blocca lo stesso", () => {
    const project = state.projects.find((p) => p.template === "software" && !p.archived)!;
    const task = newTask("p-roberta", "PR senza numero", project.id);
    const run = addRun(task, "finished");
    // Come la scrive la pipeline (`conversation-scripts.ts`).
    state.conversationEvents.set(run.id, [
      {
        id: "ev-test",
        at: now(),
        type: "work_result",
        kind: "pr_opened",
        text: `Pull request opened for ${task.code}`,
      },
    ]);
    expect(deleteTaskAs("p-roberta", task.id)).toEqual({
      ok: false,
      error: "busy",
      reasons: [{ kind: "open_pr", repo: null, number: null }],
    });
  });

  it("la correzione di un server, ancora aperta, blocca; chiusa no", () => {
    // ACQ-6: la correzione del server SRV-1, aperta, creata da Claude.
    const task = state.tasks.find((t) => t.code === "ACQ-6")!;
    expect(deleteTaskAs("p-laura", task.id)).toEqual({
      ok: false,
      error: "busy",
      reasons: [{ kind: "server_fix", serverCode: task.serverRef!.serverCode }],
    });
    task.statusId = state.statuses.find((s) => s.projectId === ACQ && s.family === "closed")!.id;
    expect(deleteTaskAs("p-laura", task.id)).toEqual({ ok: true });
  });

  it("la correzione di un rilascio, ancora aperta, blocca", () => {
    const release = state.releases[0]!;
    const task = newTask("p-roberta", "Fix rilascio", release.projectId);
    task.releaseRef = { releaseId: release.id };
    expect(deleteTaskAs("p-roberta", task.id)).toEqual({
      ok: false,
      error: "busy",
      reasons: [{ kind: "release_fix", releaseCode: release.code }],
    });
  });
});

describe("ciò che le sta intorno", () => {
  it("le figlie restano senza madre; i collegamenti si tolgono da entrambe le parti", () => {
    const parent = newTask("p-marco", "Madre");
    const a = newTask("p-marco", "Figlia A");
    const b = newTask("p-marco", "Figlia B");
    const blocked = newTask("p-marco", "Bloccata");
    const blocker = newTask("p-marco", "Bloccante");
    a.links.push({ kind: "parent", taskId: parent.id });
    b.links.push({ kind: "parent", taskId: parent.id }, { kind: "relates", taskId: a.id });
    parent.links.push({ kind: "blocks", taskId: blocked.id });
    blocker.links.push({ kind: "blocks", taskId: parent.id });

    expect(linksOf(blocked, state.tasks).map((l) => l.kind)).toEqual(["blocked_by"]);
    expect(deleteTaskAs("p-laura", parent.id)).toEqual({ ok: true });

    expect(state.tasksById.get(a.id)?.links).toEqual([]);
    expect(state.tasksById.get(b.id)?.links).toEqual([{ kind: "relates", taskId: a.id }]);
    expect(state.tasksById.get(blocker.id)?.links).toEqual([]);
    expect(linksOf(blocked, state.tasks)).toEqual([]);
  });

  it("toglie attività, accordi della giornata e domande della task", () => {
    const task = newTask("p-marco");
    const activity = state.activity.find((x) => x.kind === "comment")!;
    state.activity.push({ ...copy(activity), id: "a-test", taskId: task.id });
    const arrangement = state.arrangements[0]!;
    state.arrangements.push({ ...copy(arrangement), taskId: task.id });
    const decision = state.decisions[0]!;
    state.decisions.push({ ...copy(decision), id: "d-test", taskId: task.id });

    expect(deleteTaskAs("p-laura", task.id)).toEqual({ ok: true });
    expect(state.activity.some((x) => x.taskId === task.id)).toBe(false);
    expect(state.arrangements.some((x) => x.taskId === task.id)).toBe(false);
    expect(state.decisions.some((x) => x.taskId === task.id)).toBe(false);
  });

  it("il codice non si riusa: dopo ACQ-<max> eliminata, la nuova prende ACQ-<max+1>", () => {
    const max = Math.max(
      ...state.tasks.filter((t) => t.projectId === ACQ).map((t) => Number(t.code.split("-")[1])),
    );
    const last = newTask("p-marco");
    expect(last.code).toBe(`ACQ-${max + 1}`);
    expect(deleteTaskAs("p-marco", last.id)).toEqual({ ok: true });
    expect(state.deletedTasks).toEqual([
      {
        id: last.id,
        code: `ACQ-${max + 1}`,
        projectId: ACQ,
        title: "Prova",
        deletedAt: now(),
        deletedById: "p-marco",
      },
    ]);
    expect(newTask("p-marco").code).toBe(`ACQ-${max + 2}`);
  });
});

describe("dopo: eliminata = inesistente (R-G5), e le letture che la nominavano", () => {
  it("il codice non si trova più, per nessuno", async () => {
    const task = newTask("p-marco");
    expect(deleteTaskAs("p-marco", task.id)).toEqual({ ok: true });
    for (const who of ["p-marco", "p-laura", "p-roberta", CLAUDE_ID]) {
      as(who);
      expect(await getTaskByCode(task.code)).toBeNull();
    }
  });

  it("la richiesta d'origine dice i codici delle task eliminate", async () => {
    as("p-laura");
    const task = await convertRequest("req-acq-1", { title: "Rate" });
    expect((await getRequest("req-acq-1"))?.deletedTaskCodes ?? []).toEqual([]);
    expect(deleteTaskAs("p-laura", task.id)).toEqual({ ok: true });
    expect((await getRequest("req-acq-1"))?.deletedTaskCodes).toEqual([task.code]);
    const request = state.requests.find((r) => r.id === "req-acq-1")!;
    expect((await getRequestByCode(request.code))?.deletedTaskCodes).toEqual([task.code]);
    const listed = (await listRequests(ACQ)).find((r) => r.id === "req-acq-1");
    expect(listed?.deletedTaskCodes).toEqual([task.code]);
    // Nel seme non c'è: il campo nasce solo a lettura.
    expect(request.deletedTaskCodes).toBeUndefined();
  });

  it("la notifica della task resta, con objectGone", async () => {
    const task = newTask("p-marco");
    const n: AppNotification = {
      id: "n-test",
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
    as("p-laura");
    const before = (await listNotifications()).find((x) => x.id === "n-test");
    expect(before).toBeDefined();
    expect(before?.objectGone).toBeUndefined();
    expect(deleteTaskAs("p-laura", task.id)).toEqual({ ok: true });
    const after = (await listNotifications()).find((x) => x.id === "n-test");
    expect(after?.objectGone).toBe(true);
    expect(state.notifications.find((x) => x.id === "n-test")?.objectGone).toBeUndefined();
  });

  it("l'effetto d'automazione che l'aveva creata dice «task deleted», senza codice per chi non vede", () => {
    const task = newTask("p-marco");
    const run = state.automationRuns[0]!;
    run.log[0]!.effects = [{ kind: "task", code: task.code }];
    expect(viewRun("p-laura", run).log[0]!.effects).toEqual([{ kind: "task", code: task.code }]);
    expect(deleteTaskAs("p-laura", task.id)).toEqual({ ok: true });
    expect(viewRun("p-laura", run).log[0]!.effects).toEqual([
      { kind: "task", code: task.code, deleted: true },
    ]);
    // Giulia non vede ACQ: né codice né «deleted».
    expect(viewRun("p-giulia", run).log[0]!.effects).toEqual([{ kind: "task", code: "" }]);
  });
});

describe("la traccia", () => {
  it("la voce task.deleted: la leggono chi gestisce il progetto e chi modera, non Sara né chi non vede ACQ", async () => {
    const task = newTask("p-marco", "Prova");
    expect(deleteTaskAs("p-marco", task.id)).toEqual({ ok: true });
    const entry = state.changelog.find((e) => e.kind === "task.deleted")!;
    expect(entry).toMatchObject({
      actorId: "p-marco",
      projectId: ACQ,
      object: { type: "task", id: task.id, label: task.code },
      params: { title: "Prova" },
    });
    const reads = async (who: string) => {
      as(who);
      return (await changelog.listChanges()).some((e) => e.kind === "task.deleted");
    };
    expect(await reads("p-laura")).toBe(true); // Project Lead: gestisce
    expect(await reads("p-marco")).toBe(true); // Developer: tickets.moderate
    expect(await reads("p-sara")).toBe(false); // Contributor
    expect(await reads("p-giulia")).toBe(false); // non vede ACQ
    expect(await reads(CLAUDE_ID)).toBe(false);
  });

  it("storia del progetto e rassegna: task_deleted con codice e titolo; la persona conta l'eliminata", async () => {
    const task = newTask("p-marco", "Prova");
    expect(deleteTaskAs("p-marco", task.id)).toEqual({ ok: true });
    const expected = {
      kind: "task_deleted",
      at: now(),
      taskId: task.id,
      code: task.code,
      title: "Prova",
      byId: "p-marco",
    };
    as("p-laura");
    expect(await listTimeline(ACQ)).toContainEqual(expected);
    expect(await listPortfolioActivity()).toContainEqual({ ...expected, projectId: ACQ });
    as("p-giulia");
    expect((await listPortfolioActivity()).some((e) => e.kind === "task_deleted")).toBe(false);

    as("p-roberta");
    const d = new Date(now());
    const pad = (n: number) => String(n).padStart(2, "0");
    const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const marco = (await listPeopleActivity(day)).find((p) => p.personId === "p-marco");
    expect(marco?.tasksDeleted).toEqual([
      {
        taskId: task.id,
        code: task.code,
        title: "Prova",
        projectId: ACQ,
        at: now(),
        viaClaude: false,
      },
    ]);
  });
});

describe("la vista e la pubblica", () => {
  it("getTaskDeletion: invisibile → null; Sara su una non sua → deleteTasks; sulla sua → editTasks", async () => {
    const marcos = newTask("p-marco", "Di Marco");
    const child = newTask("p-marco", "Figlia");
    child.links.push({ kind: "parent", taskId: marcos.id });
    const saras = newTask("p-sara", "Di Sara");

    as("p-giulia");
    expect(await getTaskDeletion(marcos.id)).toBeNull();
    expect(await getTaskDeletion("t-nope")).toBeNull();

    as("p-sara");
    expect(await getTaskDeletion(marcos.id)).toEqual({
      taskId: marcos.id,
      code: marcos.code,
      title: "Di Marco",
      canDelete: false,
      whoAction: "deleteTasks",
      busy: [],
      children: [{ code: child.code, title: "Figlia" }],
    });
    // Contributor: crea ma non modifica, quindi nemmeno la sua.
    expect(await getTaskDeletion(saras.id)).toMatchObject({
      canDelete: false,
      whoAction: "editTasks",
    });

    as("p-laura");
    expect(await getTaskDeletion(marcos.id)).toMatchObject({ canDelete: true, whoAction: null });
  });

  it("deleteTask passa dal cancello con la persona della sessione", async () => {
    const task = newTask("p-marco");
    as("p-sara");
    expect(await deleteTask(task.id)).toEqual({ ok: false, error: "forbidden" });
    as("p-marco");
    expect(await deleteTask(task.id)).toEqual({ ok: true });
    expect(state.tasksById.has(task.id)).toBe(false);
  });
});
