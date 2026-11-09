import { describe, expect, it } from "vitest";
import { pulseOf } from "./pulse.js";

/**
 * Il polso di un progetto per l'app nuova (integrazione area 2, fetta 4):
 * la formula del prototipo (`pulseOf` di `data/store.ts`), pura, sui dati che
 * il renderer ha già letto. `/api/projects/pulse` resta per web e mobile.
 */
const base = { projectId: "p", claudeWorking: false, decisionsForMe: 0, requestsToConvert: 0, claudeWaitingForMe: 0 };

describe("pulseOf", () => {
  it("aperte per famiglia (le chiuse no) e ferme", () => {
    const p = pulseOf({
      ...base,
      tasks: [
        { family: "todo", stalled: false },
        { family: "todo", stalled: true },
        { family: "active", stalled: true },
        { family: "closed", stalled: false },
      ],
      milestones: [],
    });
    expect(p).toMatchObject({ projectId: "p", open: { todo: 2, active: 1 }, stalled: 2, waitingOnMe: false, nextMilestone: null });
  });

  it("aspetta te: una decisione per me, una richiesta da trasformare, o Claude che aspetta me", () => {
    const tasks: { family: "todo"; stalled: boolean }[] = [];
    expect(pulseOf({ ...base, tasks, milestones: [], decisionsForMe: 1 }).waitingOnMe).toBe(true);
    expect(pulseOf({ ...base, tasks, milestones: [], requestsToConvert: 2 }).waitingOnMe).toBe(true);
    expect(pulseOf({ ...base, tasks, milestones: [], claudeWaitingForMe: 1 }).waitingOnMe).toBe(true);
    expect(pulseOf({ ...base, tasks, milestones: [] }).waitingOnMe).toBe(false);
  });

  it("il prossimo traguardo: l'aperto con la data più vicina, anche passata; senza data o chiusi no", () => {
    const milestones = [
      { id: "a", dueDate: "2026-12-01", closed: false },
      { id: "b", dueDate: "2026-10-01", closed: false },
      { id: "c", dueDate: "2026-09-01", closed: true },
      { id: "d", dueDate: null, closed: false },
    ];
    expect(pulseOf({ ...base, tasks: [], milestones }).nextMilestone?.id).toBe("b");
    expect(pulseOf({ ...base, tasks: [], milestones: [milestones[3]!] }).nextMilestone).toBeNull();
  });
});
