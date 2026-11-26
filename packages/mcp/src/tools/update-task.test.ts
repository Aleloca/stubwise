import { describe, expect, it, vi } from "vitest";

import { StubwiseApiError, type StubwiseClient } from "../client.js";
import type { StubwiseConfig } from "../config.js";
import { isoWeekOf, taskWriteTools } from "./tasks.js";
import type { ToolContext, ToolDef, ToolResult } from "./types.js";

/**
 * `update_task` (lotto 2 della parità, decisione di 46): una task per codice o
 * per id, coi campi che si cambiano dall'app — stato, assegnatario, settimana,
 * giorno, priorità, reparto, taglia — in parole (nomi, «me», «giovedì»), non
 * in id. Copre «sposta ACQ-12 a giovedì».
 */
const config: StubwiseConfig = { baseUrl: "https://stubwise.example.com", token: "stw_pat_x", projectSlug: null };

const TASK = {
  id: "11111111-1111-4111-8111-111111111111",
  code: "ACQ-12",
  projectId: "p1",
  title: "Login col secondo fattore",
  statusId: "s-todo",
  departmentId: "d-dev",
  size: "M",
  priority: "medium",
  type: "task",
  assigneeId: "u-laura",
  plannedWeek: "2026-W49",
};
const STATUSES = [
  { id: "s-todo", name: "Da fare", family: "todo", position: 0 },
  { id: "s-review", name: "In review", family: "active", position: 1 },
];
const DEPARTMENTS = [
  { id: "d-dev", name: "Sviluppo", isDefault: true },
  { id: "d-des", name: "Design", isDefault: false },
];
const PEOPLE = [
  { id: "u-laura", name: "Laura Bianchi", email: "laura@acq.it", isClaude: false, deactivated: false },
  { id: "u-marco", name: "Marco Rossi", email: "marco@acq.it", isClaude: false, deactivated: false },
  { id: "u-claude", name: "Claude", email: "claude@stubwise.local", isClaude: true, deactivated: false },
];

function makeClient(over: Partial<Record<keyof StubwiseClient, unknown>> = {}) {
  return {
    getTaskByCode: vi.fn().mockResolvedValue(TASK),
    getTicket: vi.fn().mockResolvedValue({ id: TASK.id, projectId: "p1", number: 12 }),
    listProjectStatuses: vi.fn().mockResolvedValue(STATUSES),
    listDepartments: vi.fn().mockResolvedValue(DEPARTMENTS),
    listPeople: vi.fn().mockResolvedValue(PEOPLE),
    getMe: vi.fn().mockResolvedValue({ id: "u-laura", email: "laura@acq.it", role: "member" }),
    patchTask: vi.fn().mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({ ...TASK, ...patch })),
    setTaskDay: vi.fn().mockImplementation(async (taskId: string, body: { week: string; day: number | null }) => ({ taskId, ...body })),
    ...over,
  };
}
function ctxOf(client: ReturnType<typeof makeClient>): ToolContext {
  return { client: client as unknown as StubwiseClient, config };
}
const tool: ToolDef = taskWriteTools.find((t) => t.name === "update_task")!;
const text = (r: ToolResult) => r.content[0]?.text ?? "";

describe("update_task", () => {
  it("«sposta ACQ-12 a giovedì»: il giorno nella settimana della task, senza toccare i campi", async () => {
    const client = makeClient();
    const r = await tool.handler({ task: "acq-12", day: "giovedì" }, ctxOf(client));
    expect(r.isError).toBeUndefined();
    expect(client.getTaskByCode).toHaveBeenCalledWith("ACQ-12");
    expect(client.patchTask).not.toHaveBeenCalled();
    expect(client.setTaskDay).toHaveBeenCalledWith(TASK.id, { week: "2026-W49", day: 4 });
    expect(text(r)).toContain("ACQ-12");
    expect(text(r)).toContain("giorno: giovedì (2026-W49)");
  });

  it("un giorno come data: la settimana viene dalla data, e la task si sposta lì se era altrove", async () => {
    const client = makeClient();
    // 2026-12-10 è un giovedì della 2026-W50.
    await tool.handler({ task: "ACQ-12", day: "2026-12-10" }, ctxOf(client));
    expect(client.patchTask).toHaveBeenCalledWith(TASK.id, { plannedWeek: "2026-W50" });
    expect(client.setTaskDay).toHaveBeenCalledWith(TASK.id, { week: "2026-W50", day: 4 });
  });

  it("i campi in parole: stato e reparto per nome, assegnatario per email, priorità e taglia", async () => {
    const client = makeClient();
    const r = await tool.handler({ task: "ACQ-12", status: "in review", assignee: "MARCO@acq.it", department: "design", priority: "high", size: "l" }, ctxOf(client));
    expect(r.isError).toBeUndefined();
    expect(client.patchTask).toHaveBeenCalledWith(TASK.id, { statusId: "s-review", assigneeId: "u-marco", departmentId: "d-des", priority: "high", size: "L" });
    expect(client.setTaskDay).not.toHaveBeenCalled();
  });

  it("«me», «none» e la settimana da togliere", async () => {
    const client = makeClient();
    await tool.handler({ task: "ACQ-12", assignee: "none", week: "none", size: "none" }, ctxOf(client));
    expect(client.patchTask).toHaveBeenCalledWith(TASK.id, { assigneeId: null, plannedWeek: null, size: null });
    const me = makeClient();
    await tool.handler({ task: "ACQ-12", assignee: "me" }, ctxOf(me));
    expect(me.patchTask).toHaveBeenCalledWith(TASK.id, { assigneeId: "u-laura" });
  });

  it("assegnare «Claude» si può, e la risposta dice che il lavoro parte", async () => {
    const client = makeClient();
    const r = await tool.handler({ task: "ACQ-12", assignee: "Claude" }, ctxOf(client));
    expect(client.patchTask).toHaveBeenCalledWith(TASK.id, { assigneeId: "u-claude" });
    expect(text(r)).toContain("avvia il lavoro");
    expect(tool.description).toContain("runs.start");
  });

  it("per id: la task si cerca dal ticket, e senza settimana un giorno a parole non si indovina", async () => {
    const client = makeClient();
    await tool.handler({ task: TASK.id, status: "In review" }, ctxOf(client));
    expect(client.getTicket).toHaveBeenCalledWith(TASK.id);
    expect(client.listProjectStatuses).toHaveBeenCalledWith("p1");
    expect(client.patchTask).toHaveBeenCalledWith(TASK.id, { statusId: "s-review" });
    const r = await tool.handler({ task: TASK.id, day: "giovedì" }, ctxOf(makeClient()));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("settimana");
  });

  it("nomi sconosciuti o ambigui: l'errore elenca i validi, e non scrive nulla", async () => {
    const client = makeClient({ listPeople: vi.fn().mockResolvedValue([...PEOPLE, { id: "u-m2", name: "Marco Verdi", email: "mv@acq.it", isClaude: false, deactivated: false }]) });
    const r = await tool.handler({ task: "ACQ-12", status: "Fatto", assignee: "marco" }, ctxOf(client));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("stato sconosciuto: Fatto (validi: Da fare, In review)");
    expect(text(r)).toContain("«marco» è ambiguo");
    expect(client.patchTask).not.toHaveBeenCalled();
    expect(client.setTaskDay).not.toHaveBeenCalled();
  });

  it("un giorno di fine settimana, o nessun campo: errore senza scritture", async () => {
    const client = makeClient();
    expect((await tool.handler({ task: "ACQ-12", day: "sabato" }, ctxOf(client))).isError).toBe(true);
    expect((await tool.handler({ task: "ACQ-12", day: "2026-12-12" }, ctxOf(client))).isError).toBe(true);
    const none = await tool.handler({ task: "ACQ-12" }, ctxOf(client));
    expect(none.isError).toBe(true);
    expect(text(none)).toContain("niente da cambiare");
    expect(client.patchTask).not.toHaveBeenCalled();
  });

  it("revisione I3: se i campi passano e il giorno no, la risposta dice cosa è fatto e cosa no", async () => {
    const client = makeClient({ setTaskDay: vi.fn().mockRejectedValue(new StubwiseApiError("HTTP 409 not_in_week: The task is not planned in this week", 409, "not_in_week")) });
    const r = await tool.handler({ task: "ACQ-12", priority: "urgent", day: "lunedì" }, ctxOf(client));
    expect(client.patchTask).toHaveBeenCalledWith(TASK.id, { priority: "urgent" });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("Aggiornata ACQ-12: priorità: urgent; il giorno NON è stato impostato: HTTP 409 not_in_week: The task is not planned in this week");
  });

  it("revisione I3: il giorno di una task che resta o finisce a un altro si rifiuta PRIMA di scrivere", async () => {
    const toMarco = makeClient();
    const r = await tool.handler({ task: "ACQ-12", assignee: "marco@acq.it", day: "giovedì" }, ctxOf(toMarco));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("il giorno lo sistema solo chi ha la task in carico");
    expect(toMarco.patchTask).not.toHaveBeenCalled();
    expect(toMarco.setTaskDay).not.toHaveBeenCalled();
    const notMine = makeClient({ getMe: vi.fn().mockResolvedValue({ id: "u-marco", email: "marco@acq.it", role: "member" }) });
    expect((await tool.handler({ task: "ACQ-12", day: "giovedì" }, ctxOf(notMine))).isError).toBe(true);
    expect(notMine.setTaskDay).not.toHaveBeenCalled();
  });

  it("revisione I4: una task slittata usa la settimana EFFETTIVA che dà il server, la stessa che controlla il giorno", async () => {
    // Pianificata nella W45 e mai chiusa: `loadTaskViews` la dà già nella settimana corrente (W49).
    const client = makeClient({ getTaskByCode: vi.fn().mockResolvedValue({ ...TASK, plannedWeek: "2026-W49", slipCount: 4 }) });
    await tool.handler({ task: "ACQ-12", day: "martedì" }, ctxOf(client));
    expect(client.patchTask).not.toHaveBeenCalled();
    expect(client.setTaskDay).toHaveBeenCalledWith(TASK.id, { week: "2026-W49", day: 2 });
  });

  it("revisione M1: la settimana `this` e `next` dal giorno di oggi (Europe/Rome)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-12-09T10:00:00Z")); // mercoledì della W50
    try {
      const client = makeClient();
      await tool.handler({ task: "ACQ-12", week: "this" }, ctxOf(client));
      expect(client.patchTask).toHaveBeenLastCalledWith(TASK.id, { plannedWeek: "2026-W50" });
      await tool.handler({ task: "ACQ-12", week: "next" }, ctxOf(client));
      expect(client.patchTask).toHaveBeenLastCalledWith(TASK.id, { plannedWeek: "2026-W51" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("revisione M2 e M3: `day: 0` si rifiuta col suo nome; «Claude» per id avvia il lavoro come per nome", async () => {
    const zero = await tool.handler({ task: "ACQ-12", day: 0 }, ctxOf(makeClient()));
    expect(zero.isError).toBe(true);
    expect(text(zero)).toContain("0 non è un giorno lavorativo");
    const CLAUDE_ID = "33333333-3333-4333-8333-333333333333";
    const client = makeClient({ listPeople: vi.fn().mockResolvedValue([{ id: CLAUDE_ID, name: "Claude", email: "claude@stubwise.local", isClaude: true }]) });
    const r = await tool.handler({ task: "ACQ-12", assignee: CLAUDE_ID }, ctxOf(client));
    expect(client.patchTask).toHaveBeenCalledWith(TASK.id, { assigneeId: CLAUDE_ID });
    expect(text(r)).toContain("avvia il lavoro");
  });
});

describe("isoWeekOf", () => {
  it("la settimana ISO di una data, anche a cavallo d'anno", () => {
    expect(isoWeekOf("2026-12-10")).toBe("2026-W50");
    expect(isoWeekOf("2027-01-01")).toBe("2026-W53");
    expect(isoWeekOf("2026-01-01")).toBe("2026-W01");
  });
});
