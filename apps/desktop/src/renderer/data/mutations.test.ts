import { beforeEach, describe, expect, it } from "vitest";
import {
  addComment,
  answerDecision,
  archiveRequest,
  askDecision,
  bulkUpdateTasks,
  convertRequest,
  createProject,
  createRequest,
  createTask,
  deleteComment,
  deleteFilter,
  editComment,
  failNext,
  getRequest,
  getTaskByCode,
  listActivity,
  listDayArrangements,
  listDecisionRequests,
  listDepartmentHomes,
  listNotifications,
  listPinnedFilterIds,
  listProjectStatuses,
  listProjects,
  listRequests,
  listSavedFilters,
  listTasks,
  getPersonalHome,
  markDepartmentHomeSeen,
  mergeRequest,
  planTask,
  reopenRequest,
  resetApi,
  resetPersonalHome,
  saveFilter,
  setDay,
  setDepartmentHome,
  setFilterPinned,
  setLatency,
  setPersonalHome,
  setProjectStatuses,
  setStallThresholds,
  slipWeeks,
  startRefine,
  updateFilter,
  updateRequest,
  updateTask,
  withdrawDecision,
} from "./api";
import { currentWeek } from "../domain/weeks";
import { setSessionPersonId } from "./session";

beforeEach(() => {
  setLatency(0);
  resetApi();
});

const as = (personId: string) => setSessionPersonId(personId);
const taskOf = async (code: string) => (await getTaskByCode(code))!;
const forbiddenError = /forbidden/;

describe("task", () => {
  it("createTask: codice successivo, primo stato todo, reparto di chi crea", async () => {
    as("p-giulia");
    const before = await listTasks({ projectIds: ["prj-mkx"] });
    const max = Math.max(...before.map((t) => Number(t.code.split("-")[1])));
    const task = await createTask({ projectId: "prj-mkx", title: "  New brief  " });
    expect(task.code).toBe(`MKX-${max + 1}`);
    expect(task.title).toBe("New brief");
    expect(task.departmentId).toBe("dep-marketing");
    expect(task.createdById).toBe("p-giulia");
    expect(await getTaskByCode(task.code)).toMatchObject({ id: task.id });
    const statuses = await listProjectStatuses("prj-mkx");
    expect(statuses.find((s) => s.id === task.statusId)?.family).toBe("todo");
  });

  it("createTask: chi non può crearla (Viewer / progetto invisibile) è respinto", async () => {
    as("p-andrea"); // preset viewer
    const count = (await listTasks()).length;
    const project = (await listProjects())[0]!;
    await expect(createTask({ projectId: project.id, title: "x" })).rejects.toThrow(forbiddenError);
    as("p-sara"); // Sara non vede MKX
    await expect(createTask({ projectId: "prj-mkx", title: "x" })).rejects.toThrow(/not_found/);
    as("p-andrea");
    expect((await listTasks()).length).toBe(count);
  });

  it("updateTask scrive un'attività per ogni campo cambiato e aggiorna lastActivityAt", async () => {
    as("p-giulia");
    const task = (await listTasks({ projectIds: ["prj-mkx"] })).find((t) => t.assigneeId)!;
    const statuses = await listProjectStatuses("prj-mkx");
    const other = statuses.find((s) => s.id !== task.statusId && s.family === "active")!;
    const activityBefore = (await listActivity(task.id)).length;
    const updated = await updateTask(task.id, {
      title: "Renamed",
      statusId: other.id,
      size: "XL",
      dueDate: task.dueDate, // invariato: nessuna riga
    });
    expect(
      updated.lastActivityAt > task.lastActivityAt ||
        updated.lastActivityAt === task.lastActivityAt,
    ).toBe(true);
    const activity = await listActivity(task.id);
    const added = activity.slice(activityBefore);
    expect(added.map((a) => a.field).sort()).toEqual(["size", "status", "title"]);
    expect(added.every((a) => a.kind === "field_change" && a.authorId === "p-giulia")).toBe(true);
    expect(added.find((a) => a.field === "status")?.to).toBe(other.name);
  });

  it("updateTask: cambiare settimana o assegnatario azzera le disposizioni del giorno", async () => {
    as("p-marco");
    expect(await listDayArrangements(currentWeek())).toContainEqual(
      expect.objectContaining({ taskId: "t-aud-3" }),
    );
    await updateTask("t-aud-3", { plannedWeek: "2026-W45" });
    expect((await listDayArrangements(currentWeek())).some((a) => a.taskId === "t-aud-3")).toBe(
      false,
    );
    // Cambiare altro non le tocca.
    expect((await listDayArrangements(currentWeek())).some((a) => a.taskId === "t-stw-13")).toBe(
      true,
    );
    await updateTask("t-stw-13", { title: "Retitled" });
    expect((await listDayArrangements(currentWeek())).some((a) => a.taskId === "t-stw-13")).toBe(
      true,
    );
  });

  it("updateTask: closedAt segue la famiglia dello stato", async () => {
    as("p-roberta");
    const task = (await listTasks({ projectIds: ["prj-mkx"], families: ["active"] }))[0]!;
    const statuses = await listProjectStatuses("prj-mkx");
    const closed = statuses.find((s) => s.family === "closed")!;
    const done = await updateTask(task.id, { statusId: closed.id });
    expect(done.closedAt).not.toBeNull();
    const reopened = await updateTask(task.id, { statusId: task.statusId });
    expect(reopened.closedAt).toBeNull();
  });

  it("updateTask: Sara non ha tickets.edit → forbidden e task invariata; seguire sé stessa sì", async () => {
    as("p-sara");
    const task = (await listTasks()).find((t) => !t.followerIds.includes("p-sara"))!;
    const stranger = ["p-marco", "p-federico", "p-luca"].find(
      (id) => !task.followerIds.includes(id),
    )!;
    await expect(updateTask(task.id, { title: "Hacked" })).rejects.toThrow(forbiddenError);
    expect((await taskOf(task.code)).title).toBe(task.title);
    await expect(
      updateTask(task.id, { followerIds: [...task.followerIds, stranger] }),
    ).rejects.toThrow(forbiddenError);
    const followed = await updateTask(task.id, { followerIds: [...task.followerIds, "p-sara"] });
    expect(followed.followerIds).toContain("p-sara");
    const unfollowed = await updateTask(task.id, { followerIds: task.followerIds });
    expect(unfollowed.followerIds).not.toContain("p-sara");
  });

  it("bulkUpdateTasks: tutto o niente", async () => {
    as("p-giulia");
    const mkx = (await listTasks({ projectIds: ["prj-mkx"] }))[0]!;
    // Giulia è solo contributor su CBV: lì non può modificare.
    const cbv = (await listTasks({ projectIds: ["prj-cbv"] }))[0]!;
    await expect(bulkUpdateTasks([mkx.id, cbv.id], { size: "XL" })).rejects.toThrow(forbiddenError);
    expect((await taskOf(mkx.code)).size).toBe(mkx.size);
    const updated = await bulkUpdateTasks([mkx.id], { size: "XL" });
    expect(updated[0]!.size).toBe("XL");
  });

  it("failNext fa fallire una mutazione senza toccare lo stato", async () => {
    as("p-giulia");
    const task = (await listTasks({ projectIds: ["prj-mkx"] }))[0]!;
    failNext("updateTask");
    await expect(updateTask(task.id, { title: "Nope" })).rejects.toThrow(/Simulated/);
    expect((await taskOf(task.code)).title).toBe(task.title);
  });
});

describe("planning", () => {
  it("planTask di Giulia su una task altrui in un progetto dove è lead → ok e notifica all'assegnatario", async () => {
    as("p-giulia");
    const task = (await listTasks({ projectIds: ["prj-mkx"] })).find(
      (t) => t.assigneeId && t.assigneeId !== "p-giulia",
    )!;
    const planned = await planTask(task.id, { assigneeId: task.assigneeId, week: "2026-W46" });
    expect(planned.plannedWeek).toBe("2026-W46");
    as(task.assigneeId!);
    const notes = await listNotifications();
    expect(notes).toContainEqual(
      expect.objectContaining({ kind: "planning.changed", objectCode: task.code }),
    );
  });

  it("planTask: nessuna notifica a chi pianifica per sé", async () => {
    as("p-giulia");
    const task = (await listTasks({ projectIds: ["prj-mkx"] })).find((t) => !t.assigneeId)!;
    const count = (await listNotifications()).length;
    await planTask(task.id, { assigneeId: "p-giulia", week: "2026-W45" });
    expect((await listNotifications()).length).toBe(count);
  });

  it("planTask di Sara su una task altrui → forbidden, task invariata", async () => {
    as("p-sara");
    const task = (await listTasks()).find((t) => t.assigneeId && t.assigneeId !== "p-sara")!;
    await expect(planTask(task.id, { assigneeId: "p-sara", week: "2026-W46" })).rejects.toThrow(
      forbiddenError,
    );
    await expect(
      planTask(task.id, { assigneeId: task.assigneeId, week: "2026-W46" }),
    ).rejects.toThrow(forbiddenError);
    expect((await taskOf(task.code)).plannedWeek).toBe(task.plannedWeek);
  });

  it("planTask di Sara su una task non assegnata la prende per sé", async () => {
    as("p-sara");
    const task = (await listTasks()).find((t) => !t.assigneeId)!;
    const planned = await planTask(task.id, { assigneeId: "p-sara", week: "2026-W46" });
    expect(planned.assigneeId).toBe("p-sara");
  });

  it("setDay: solo l'assegnatario, e solo per sé", async () => {
    as("p-marco");
    await setDay("t-aud-3", currentWeek(), 2);
    expect(await listDayArrangements(currentWeek())).toContainEqual(
      expect.objectContaining({ taskId: "t-aud-3", day: 2 }),
    );
    await setDay("t-aud-3", currentWeek(), null);
    const mine = (await listDayArrangements(currentWeek())).filter((a) => a.taskId === "t-aud-3");
    expect(mine).toHaveLength(1);
    expect(mine[0]!.day).toBeNull();

    as("p-laura"); // non è l'assegnataria di t-aud-3
    await expect(setDay("t-aud-3", currentWeek(), 1)).rejects.toThrow(forbiddenError);
    as("p-marco");
    expect(
      (await listDayArrangements(currentWeek())).filter((a) => a.taskId === "t-aud-3"),
    ).toEqual(mine);
  });

  it("slipWeeks due volte: slipCount incrementato una volta sola", async () => {
    as("p-roberta");
    const task = (await listTasks({ projectIds: ["prj-mkx"], families: ["active"] }))[0]!;
    await updateTask(task.id, { plannedWeek: "2026-W40" });
    const before = (await taskOf(task.code)).slipCount;
    slipWeeks();
    slipWeeks();
    const after = await taskOf(task.code);
    expect(after.slipCount).toBe(before + 1);
    expect(after.plannedWeek).toBe(currentWeek());
  });

  it("le task chiuse non scivolano", async () => {
    as("p-roberta");
    const closed = (await listTasks({ projectIds: ["prj-mkx"], families: ["closed"] }))[0]!;
    await updateTask(closed.id, { plannedWeek: "2026-W40" });
    slipWeeks();
    expect(await taskOf(closed.code)).toMatchObject({
      plannedWeek: "2026-W40",
      slipCount: closed.slipCount,
    });
  });
});

describe("commenti", () => {
  it("add / edit / delete: l'autore sì, un altro no, il moderatore sì", async () => {
    as("p-giulia");
    const task = (await listTasks({ projectIds: ["prj-stw"] }))[0]!;
    const comment = await addComment(task.id, "  First!  ");
    expect(comment.body).toBe("First!");
    const edited = await editComment(comment.id, "Second");
    expect(edited.body).toBe("Second");
    expect(edited.editedAt).toBeDefined();

    as("p-sara"); // contributor: commenta ma non modera, né modifica l'altrui
    await expect(editComment(comment.id, "Mine now")).rejects.toThrow(forbiddenError);
    await expect(deleteComment(comment.id)).rejects.toThrow(forbiddenError);
    expect((await listActivity(task.id)).find((a) => a.id === comment.id)?.body).toBe("Second");

    as("p-laura"); // project lead: modera ma non può modificare
    await expect(editComment(comment.id, "Mod edit")).rejects.toThrow(forbiddenError);
    await deleteComment(comment.id);
    const deleted = (await listActivity(task.id)).find((a) => a.id === comment.id)!;
    expect(deleted.body).toBe("");
    expect(deleted.deletedAt).toBeDefined();
    expect(deleted.deletedById).toBe("p-laura");
    await expect(editComment(comment.id, "back")).rejects.toThrow();
  });

  it("deleteComment: l'autore cancella il proprio", async () => {
    as("p-sara");
    const task = (await listTasks({ projectIds: ["prj-stw"] }))[0]!;
    const comment = await addComment(task.id, "oops");
    await deleteComment(comment.id);
    expect((await listActivity(task.id)).find((a) => a.id === comment.id)?.body).toBe("");
  });

  it("addComment senza tickets.comment è respinto", async () => {
    as("p-andrea");
    const task = (await listTasks())[0]!;
    const count = (await listActivity(task.id)).length;
    await expect(addComment(task.id, "hi")).rejects.toThrow(forbiddenError);
    expect((await listActivity(task.id)).length).toBe(count);
  });
});

describe("richieste di decisione", () => {
  it("ask → answer: attività «decision» e notifica a chi ha chiesto", async () => {
    as("p-giulia");
    const task = (await listTasks({ projectIds: ["prj-mkx"] }))[0]!;
    const asked = await askDecision({
      taskId: task.id,
      askedOfId: "p-paolo",
      question: "Which one?",
      options: ["A", "B"],
    });
    expect(asked.answer).toBeNull();

    as("p-paolo");
    await expect(answerDecision(asked.id, { optionIndex: 5 })).rejects.toThrow(/invalid/);
    const answered = await answerDecision(asked.id, { optionIndex: 1 });
    expect(answered.answer).toMatchObject({ optionIndex: 1, byId: "p-paolo" });
    expect((await listActivity(task.id)).some((a) => a.decisionRequestId === asked.id)).toBe(true);

    as("p-giulia");
    expect(await listNotifications()).toContainEqual(
      expect.objectContaining({ kind: "decision.answered", objectCode: task.code }),
    );
  });

  it("answer: solo l'interpellato; withdraw: solo chi ha chiesto", async () => {
    as("p-giulia");
    const task = (await listTasks({ projectIds: ["prj-mkx"] }))[0]!;
    const asked = await askDecision({
      taskId: task.id,
      askedOfId: "p-paolo",
      question: "Free text?",
      options: [],
    });
    await expect(answerDecision(asked.id, { text: "yes" })).rejects.toThrow(forbiddenError);
    as("p-paolo");
    await expect(withdrawDecision(asked.id)).rejects.toThrow(forbiddenError);
    as("p-giulia");
    const withdrawn = await withdrawDecision(asked.id);
    expect(withdrawn.withdrawnAt).not.toBeNull();
    as("p-paolo");
    await expect(answerDecision(asked.id, { text: "late" })).rejects.toThrow();
    expect((await listDecisionRequests({ taskId: task.id }))[0]!.answer).toBeNull();
  });

  it("askDecision senza tickets.comment è respinta", async () => {
    as("p-andrea");
    const task = (await listTasks())[0]!;
    await expect(
      askDecision({ taskId: task.id, askedOfId: "p-giulia", question: "?", options: [] }),
    ).rejects.toThrow(forbiddenError);
  });
});

describe("richieste", () => {
  it("createRequest: Sara (backlog.create) sì; Andrea (viewer) no", async () => {
    as("p-sara");
    const request = await createRequest({ projectId: "prj-stw", title: "Dark mode" });
    expect(request).toMatchObject({ status: "new", requesterIds: ["p-sara"] });
    as("p-andrea");
    const project = (await listProjects())[0]!;
    await expect(createRequest({ projectId: project.id, title: "x" })).rejects.toThrow(
      forbiddenError,
    );
  });

  it("update / archive / reopen / startRefine: serve backlog.edit", async () => {
    as("p-sara");
    const mine = await createRequest({ projectId: "prj-stw", title: "Mine" });
    await expect(updateRequest(mine.id, { title: "Changed" })).rejects.toThrow(forbiddenError);
    await expect(archiveRequest(mine.id)).rejects.toThrow(forbiddenError);
    await expect(startRefine(mine.id)).rejects.toThrow(forbiddenError);
    expect((await getRequest(mine.id))!.title).toBe("Mine");

    as("p-laura");
    expect((await updateRequest(mine.id, { title: "Changed" })).title).toBe("Changed");
    expect((await startRefine(mine.id)).status).toBe("refining");
    expect((await archiveRequest(mine.id)).status).toBe("archived");
    expect((await reopenRequest(mine.id)).status).toBe("new");
  });

  it("mergeRequest unisce i richiedenti senza duplicati e archivia la fusa", async () => {
    as("p-laura");
    const a = await createRequest({ projectId: "prj-stw", title: "A" });
    as("p-sara");
    const b = await createRequest({ projectId: "prj-stw", title: "B" });
    as("p-laura");
    const c = await createRequest({ projectId: "prj-stw", title: "C" });
    // a = [laura], b = [sara], c = [laura]
    const merged = await mergeRequest(b.id, a.id);
    expect(merged.requesterIds.sort()).toEqual(["p-laura", "p-sara"]);
    const again = await mergeRequest(c.id, a.id);
    expect(again.requesterIds.sort()).toEqual(["p-laura", "p-sara"]);
    expect(await getRequest(b.id)).toMatchObject({ status: "archived", mergedIntoId: a.id });
    await expect(mergeRequest(a.id, a.id)).rejects.toThrow(/invalid/);
  });

  it("mergeRequest senza backlog.edit è respinta", async () => {
    as("p-laura");
    const a = await createRequest({ projectId: "prj-stw", title: "A" });
    const b = await createRequest({ projectId: "prj-stw", title: "B" });
    as("p-sara");
    await expect(mergeRequest(a.id, b.id)).rejects.toThrow(forbiddenError);
    expect((await getRequest(a.id))!.status).toBe("new");
  });

  it("convertRequest crea la task collegata e porta la richiesta a converted", async () => {
    as("p-laura");
    const request = await createRequest({ projectId: "prj-stw", title: "Convert me" });
    const task = await convertRequest(request.id, { title: "Convert me" });
    expect(task).toMatchObject({ requestId: request.id, projectId: "prj-stw" });
    const after = (await listRequests("prj-stw")).find((r) => r.id === request.id)!;
    expect(after.status).toBe("converted");
    expect(after.taskIds).toEqual([task.id]);
    await expect(convertRequest(request.id, { title: "again" })).rejects.toThrow(/invalid/);
  });

  it("convertRequest senza tickets.create è respinta e la richiesta non cambia", async () => {
    as("p-laura");
    const request = await createRequest({ projectId: "prj-stw", title: "Keep" });
    // Il preset viewer non può creare task.
    as("p-andrea");
    const project = (await listProjects())[0]!;
    await expect(convertRequest("req-none", { title: "x" })).rejects.toThrow(/not_found/);
    as("p-laura");
    expect(project).toBeDefined();
    expect((await getRequest(request.id))!.status).toBe("new");
  });
});

describe("filtri salvati", () => {
  const input = {
    name: "My view",
    visibility: "public" as const,
    criteria: { families: ["active" as const] },
    view: "list" as const,
    groupBy: "none" as const,
  };

  it("save / update / delete: l'autore sì, un altro no, il full admin sì", async () => {
    as("p-giulia");
    const filter = await saveFilter(input);
    expect(filter.ownerId).toBe("p-giulia");
    expect((await updateFilter(filter.id, { name: "Renamed" })).name).toBe("Renamed");

    as("p-sara");
    await expect(updateFilter(filter.id, { name: "Hacked" })).rejects.toThrow(forbiddenError);
    await expect(deleteFilter(filter.id)).rejects.toThrow(forbiddenError);
    expect((await listSavedFilters()).find((f) => f.id === filter.id)?.name).toBe("Renamed");

    as("p-roberta");
    await deleteFilter(filter.id);
    expect((await listSavedFilters()).some((f) => f.id === filter.id)).toBe(false);
  });

  it("setFilterPinned è per persona, e cancellare il filtro lo toglie", async () => {
    as("p-giulia");
    const filter = await saveFilter(input);
    await setFilterPinned(filter.id, true);
    expect(await listPinnedFilterIds()).toEqual([filter.id]);
    as("p-sara");
    expect(await listPinnedFilterIds()).toEqual([]);
    as("p-giulia");
    await setFilterPinned(filter.id, false);
    expect(await listPinnedFilterIds()).toEqual([]);
    await setFilterPinned(filter.id, true);
    await deleteFilter(filter.id);
    expect(await listPinnedFilterIds()).toEqual([]);
  });

  it("un filtro privato altrui non si può fissare né modificare (è come inesistente)", async () => {
    as("p-giulia");
    const priv = await saveFilter({ ...input, visibility: "private" });
    as("p-sara");
    await expect(setFilterPinned(priv.id, true)).rejects.toThrow(/not_found/);
    await expect(updateFilter(priv.id, { name: "x" })).rejects.toThrow(/not_found/);
  });
});

describe("Home", () => {
  const blocks = [{ kind: "decide" as const }, { kind: "myTasks" as const }];

  it("setPersonalHome / resetPersonalHome", async () => {
    as("p-giulia");
    expect(await getPersonalHome()).toBeNull();
    await setPersonalHome(blocks);
    expect((await getPersonalHome())!.blocks).toEqual(blocks);
    await resetPersonalHome();
    expect(await getPersonalHome()).toBeNull();
  });

  it("setDepartmentHome: solo chi ha department.home.manage su quel reparto", async () => {
    as("p-giulia"); // gestisce Marketing
    await setDepartmentHome("dep-marketing", blocks);
    expect(
      (await listDepartmentHomes()).find((h) => h.departmentId === "dep-marketing")!.blocks,
    ).toEqual(blocks);
    await expect(setDepartmentHome("dep-sales", blocks)).rejects.toThrow(forbiddenError);
    as("p-sara");
    const sales = (await listDepartmentHomes()).find((h) => h.departmentId === "dep-sales")!;
    await expect(setDepartmentHome("dep-sales", blocks)).rejects.toThrow(forbiddenError);
    expect((await listDepartmentHomes()).find((h) => h.departmentId === "dep-sales")).toEqual(
      sales,
    );
  });

  it("markDepartmentHomeSeen: Marco vede l'avviso finché non lo segna", async () => {
    as("p-marco");
    const dev = () =>
      listDepartmentHomes().then((h) => h.find((x) => x.departmentId === "dep-development")!);
    expect((await getPersonalHome())!.seenDepartmentUpdates["dep-development"]).not.toBe(
      (await dev()).updatedAt,
    );
    await markDepartmentHomeSeen("dep-development");
    expect((await getPersonalHome())!.seenDepartmentUpdates["dep-development"]).toBe(
      (await dev()).updatedAt,
    );
  });
});

describe("progetti", () => {
  it("createProject: stati e moduli dal modello, la persona ne è lead e lo vede", async () => {
    as("p-roberta");
    const project = await createProject({
      code: "NEWP",
      name: "New project",
      template: "marketing",
    });
    expect(project.memberIds).toEqual(["p-roberta"]);
    expect((await listProjectStatuses(project.id)).length).toBeGreaterThan(2);
    expect((await listProjects()).some((p) => p.id === project.id)).toBe(true);
    // Subito usabile: ci si crea una task.
    const task = await createTask({ projectId: project.id, title: "First" });
    expect(task.code).toBe("NEWP-1");
  });

  it("createProject: codice non valido o già preso, e chi non ha projects.create → respinto", async () => {
    as("p-roberta");
    await expect(createProject({ code: "x1", name: "n", template: "empty" })).rejects.toThrow(
      /invalid/,
    );
    await expect(createProject({ code: "MKX", name: "n", template: "empty" })).rejects.toThrow(
      /code_taken/,
    );
    as("p-sara");
    const count = (await listProjects()).length;
    await expect(createProject({ code: "ZZZ", name: "n", template: "empty" })).rejects.toThrow(
      forbiddenError,
    );
    expect((await listProjects()).length).toBe(count);
  });

  it("il progetto creato sparisce con resetApi", async () => {
    as("p-roberta");
    await createProject({ code: "TMPX", name: "Temp", template: "empty" });
    resetApi();
    as("p-roberta");
    expect((await listProjects()).some((p) => p.code === "TMPX")).toBe(false);
  });

  it("setProjectStatuses: che toglie l'unico closed viene rifiutata, stato intatto", async () => {
    as("p-roberta");
    const statuses = await listProjectStatuses("prj-mkx");
    const closed = statuses.filter((s) => s.family === "closed");
    const keep = statuses.filter((s) => s.family !== "closed");
    // Lascia un solo closed: poi si prova a toglierlo.
    const onlyOne = [...keep, closed[0]!];
    const removedIds = closed.slice(1).map((s) => s.id);
    const reassign = Object.fromEntries(removedIds.map((id) => [id, closed[0]!.id]));
    await setProjectStatuses("prj-mkx", onlyOne, reassign);
    const afterOne = await listProjectStatuses("prj-mkx");
    await expect(
      setProjectStatuses("prj-mkx", keep, { [closed[0]!.id]: keep[0]!.id }),
    ).rejects.toThrow(/invalid/);
    expect(await listProjectStatuses("prj-mkx")).toEqual(afterOne);
  });

  it("setProjectStatuses: le task di uno stato tolto vanno sul bersaglio; senza bersaglio è rifiutata", async () => {
    as("p-roberta");
    const statuses = await listProjectStatuses("prj-stw");
    const used = (await listTasks({ projectIds: ["prj-stw"] })).find(
      (t) => statuses.find((s) => s.id === t.statusId)!.family === "active",
    )!;
    const rest = statuses.filter((s) => s.id !== used.statusId);
    const target = rest.find((s) => s.family === "active");
    const withTarget = target ?? rest[0]!;
    await expect(setProjectStatuses("prj-stw", rest, {})).rejects.toThrow(/invalid/);
    expect((await taskOf(used.code)).statusId).toBe(used.statusId);
    const added = [...rest, { name: "Brand new", family: "active" as const }];
    const result = await setProjectStatuses("prj-stw", added, { [used.statusId]: withTarget.id });
    expect(result.at(-1)).toMatchObject({ name: "Brand new", order: rest.length });
    expect((await taskOf(used.code)).statusId).toBe(withTarget.id);
  });

  it("setProjectStatuses / setStallThresholds senza project.settings.manage → forbidden", async () => {
    as("p-sara");
    const statuses = await listProjectStatuses("prj-stw");
    await expect(setProjectStatuses("prj-stw", statuses, {})).rejects.toThrow(forbiddenError);
    await expect(setStallThresholds("prj-stw", { activeDays: 3, todoDays: 5 })).rejects.toThrow(
      forbiddenError,
    );
    expect((await listProjects()).find((p) => p.id === "prj-stw")!.stallThresholds).toEqual({
      activeDays: 7,
      todoDays: 14,
    });
  });

  it("setStallThresholds: chi gestisce il progetto le cambia, e le ferme cambiano", async () => {
    as("p-roberta");
    const project = await setStallThresholds("prj-stw", { activeDays: 30, todoDays: 60 });
    expect(project.stallThresholds).toEqual({ activeDays: 30, todoDays: 60 });
    await expect(setStallThresholds("prj-stw", { activeDays: 0, todoDays: 5 })).rejects.toThrow(
      /invalid/,
    );
  });
});
