import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { strangersTo } from "../test/strangers";
import { calendar, listStalled, resetApi, setLatency } from "./api";
import { daysFromToday } from "./seed/dates";
import { setSessionPersonId } from "./session";
import { familyOf, state } from "./store";

// Registro, A11 r.1414, revisione del lotto 2-3 (46): le task ferme. «Ferma su
// chi» (`stall.reason.personId`, una decisione chiesta a qualcuno) e la task
// stessa (l'assegnatario) non dicono l'id di chi chi guarda non conosce; né
// nell'elenco delle ferme né nella scheda di preparazione del Calendario.

const LAURA = "p-laura";
const AUD = "prj-aud";
/** La prossima revisione di AUD: Laura è invitata. */
const NEXT_REVIEW = `ev-aud-review-${daysFromToday(6)}`;

beforeEach(() => {
  resetApi();
  setLatency(0);
});
afterEach(() => resetApi());

/** Una task aperta di AUD, assegnata a uno sconosciuto a Laura e ferma su una sua decisione. */
function stalledOnStranger() {
  const [who] = strangersTo(LAURA);
  const task = state.tasks.find(
    (t) => t.projectId === AUD && familyOf(t) !== "closed" && !t.manualStall,
  )!;
  task.assigneeId = who!;
  task.dueDate = daysFromToday(3);
  state.decisions.push({
    id: "dec-known-1",
    taskId: task.id,
    askedById: "p-matteo",
    askedOfId: who!,
    question: "Which supplier?",
    options: ["A", "B"],
    createdAt: "2026-01-01T09:00:00Z",
    withdrawnAt: null,
    answer: null,
  });
  return { who: who!, task };
}

describe("le task ferme senza id di chi non si conosce (r.1414)", () => {
  it("elenco delle ferme: «ferma su» e l'assegnatario col segnaposto", async () => {
    const { who, task } = stalledOnStranger();
    setSessionPersonId(LAURA);
    const row = (await listStalled()).find((r) => r.task.id === task.id)!;
    expect(row).toBeDefined();
    expect(row.stall.reason).toEqual({ kind: "decision", personId: "hidden-1" });
    expect(row.task.assigneeId).toBe("hidden-1");
    expect(JSON.stringify(row)).not.toContain(who);
  });

  it("la scheda di preparazione: ferme e scadenze col segnaposto", async () => {
    const { who, task } = stalledOnStranger();
    setSessionPersonId(LAURA);
    const prep = (await calendar.getMeetingPrep(NEXT_REVIEW))!;
    expect(prep).not.toBeNull();
    expect(prep.status.stalled.some((r) => r.task.id === task.id)).toBe(true);
    expect(JSON.stringify(prep.status)).not.toContain(who);
  });
});
