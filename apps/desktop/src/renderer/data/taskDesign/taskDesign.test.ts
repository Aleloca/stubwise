import { beforeEach, describe, expect, it } from "vitest";
import { getTaskDesignPlan, listTasks, removeTaskDesign, removeTaskPlan, resetApi, setLatency } from "../api";
import { setSessionPersonId } from "../session";

// Design e piano di una task (shape `design-plan-remove.md`, DP-Q2/Q2b/Q3):
// si leggono a sé, e li toglie chi ha `tickets.edit`.

beforeEach(() => {
  resetApi();
  setLatency(0);
});

const aud5 = async () => (await listTasks()).find((t) => t.code === "AUD-5")!;

describe("design e piano di una task", () => {
  it("AUD-5 ha design e piano; un'altra task nessuno dei due", async () => {
    setSessionPersonId("p-laura");
    const r = await getTaskDesignPlan((await aud5()).id);
    expect(r.design).toContain("Call history export");
    expect(r.plan).toBeTruthy();
    const other = (await listTasks()).find((t) => t.code === "AUD-4")!;
    expect(await getTaskDesignPlan(other.id)).toEqual({ design: null, plan: null });
  });

  it("togliere il design lascia la descrizione e il piano; poi il piano", async () => {
    setSessionPersonId("p-laura");
    const task = await aud5();
    await removeTaskDesign(task.id);
    expect(await getTaskDesignPlan(task.id)).toMatchObject({ design: null });
    expect((await aud5()).description).toBe(task.description);
    await removeTaskPlan(task.id);
    expect(await getTaskDesignPlan(task.id)).toEqual({ design: null, plan: null });
  });

  it("senza `tickets.edit` è vietato", async () => {
    setSessionPersonId("p-giulia");
    const task = await aud5();
    await expect(removeTaskDesign(task.id)).rejects.toThrow("forbidden");
  });
});
