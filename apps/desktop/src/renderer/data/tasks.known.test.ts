import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { strangersTo } from "../test/strangers";
import { getTaskByCode, listActivity, listTasks, resetApi, setLatency } from "./api";
import { planTask } from "./api-mutations";
import { setSessionPersonId } from "./session";
import { state, visibleProjectIds } from "./store";

// Registro, A11 r.1414 (decisioni del maintainer, 23 nov 2026), le task e le
// attività del prototipo: chi guarda non riceve l'id di chi non conosce (chi
// l'ha creata, chi la segue, chi l'ha fermata a mano, chi ha scritto o
// eliminato un'attività, l'assegnatario): al suo posto `hidden-<n>`. Un
// `assigneeId` omesso in una scrittura vuol dire «invariato» (scelta A di 46).

const LAURA = "p-laura";
const ACQ = "prj-acq";

beforeEach(() => {
  resetApi();
  setLatency(0);
});
afterEach(() => resetApi());

describe("task e attività senza id di chi non si conosce (r.1414)", () => {
  it("creatore, chi segue, chi l'ha fermata: segnaposti, in elenco e nel dettaglio", async () => {
    const task = state.tasks.find((t) => t.projectId === ACQ)!;
    const [who] = strangersTo(LAURA);
    task.createdById = who!;
    task.assigneeId = who!;
    task.followerIds = [LAURA, who!];
    task.manualStall = { reason: "blocked", note: "", since: "2026-11-20T10:00:00Z", byId: who! };
    setSessionPersonId(LAURA);
    const listed = (await listTasks()).find((t) => t.id === task.id)!;
    expect(listed.createdById).toBe("hidden-1");
    expect(listed.assigneeId).toBe("hidden-1");
    expect(listed.followerIds).toEqual([LAURA, "hidden-1"]);
    expect(listed.manualStall!.byId).toBe("hidden-1");
    const one = (await getTaskByCode(task.code))!;
    expect(JSON.stringify(one)).not.toContain(who!);
    expect(JSON.stringify(await listTasks())).not.toContain(who!);
  });

  it("le attività: chi ha scritto e chi ha eliminato", async () => {
    const visible = visibleProjectIds(LAURA);
    const task = state.tasks.find(
      (t) => visible.has(t.projectId) && state.activity.some((a) => a.taskId === t.id),
    )!;
    expect(task).toBeDefined();
    const entry = state.activity.find((a) => a.taskId === task.id)!;
    const [who] = strangersTo(LAURA);
    entry.authorId = who!;
    entry.deletedById = who!;
    setSessionPersonId(LAURA);
    const out = (await listActivity(task.id)).find((a) => a.id === entry.id)!;
    expect(out.authorId).toMatch(/^hidden-\d+$/);
    expect(out.deletedById).toBe(out.authorId);
    expect(JSON.stringify(await listActivity(task.id))).not.toContain(who!);
  });
});

// Scelta A di 46 (23 nov 2026): un `assigneeId` omesso vuol dire «invariato»,
// e un segnaposto non si scrive mai.
describe("pianificare con l'assegnatario segnaposto (r.1414)", () => {
  it("spostare di settimana senza `assigneeId`: la settimana cambia, l'assegnatario no", async () => {
    const task = state.tasks.find((t) => t.code === "MKX-3")!;
    const before = task.assigneeId;
    setSessionPersonId("p-giulia");
    const out = await planTask(task.id, { week: null });
    expect(out.plannedWeek).toBeNull();
    expect(task.assigneeId).toBe(before);
  });

  it("un segnaposto come assegnatario: rifiutato come assegnatario non valido, e nulla cambia", async () => {
    // Sara (senza planning.others) su una sua task: senza la regola, il rifiuto
    // sarebbe un altro («forbidden»), non quello del segnaposto.
    const task = state.tasks.find((t) => t.assigneeId === "p-sara")!;
    expect(task).toBeDefined();
    const before = { assigneeId: task.assigneeId, week: task.plannedWeek };
    setSessionPersonId("p-sara");
    await expect(planTask(task.id, { assigneeId: "hidden-1", week: null })).rejects.toThrow(
      "invalid: assignee",
    );
    expect({ assigneeId: task.assigneeId, week: task.plannedWeek }).toEqual(before);
  });
});
