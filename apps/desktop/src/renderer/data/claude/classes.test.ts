import { beforeEach, describe, expect, it } from "vitest";
import { visiblePeopleFor } from "../access/whoCan";
import { wouldNotify } from "../alerts/visibility";
import { automations, resetApi, setLatency } from "../api";
import { createTaskAs } from "../api-mutations";
import { automationsStartingOn } from "../automations/sources";
import type { ProposedAction, Task } from "../model";
import { PEOPLE } from "../seed/people";
import { setSessionPersonId } from "../session";
import { state } from "../store";
import { classOf, classOfGroup } from "./classes";

// La classe calcolata (area 10a, Task 4; Review Focus 1). Un'azione è A
// solo se non avvisa altre persone e non fa partire un'automazione; la
// classe sale coi dati del momento e non scende mai sotto quella dichiarata.
//
// Seme: Giulia è Project Lead in MKX e in OLV (dove Marco è Developer, P3)
// e Contributor in AUD, dove Matteo segue le task nuove
// (`ALERT_SUBSCRIPTIONS`). Le automazioni le crea Roberta (full admin).

const GIULIA = "p-giulia";
const MARCO = "p-marco";
const MATTEO = "p-matteo";
const ROBERTA = "p-roberta";
const CLAUDE = "p-claude";
const MKX = "prj-mkx";
const AUD = "prj-aud";
const OLV = "prj-olv";

const as = (personId: string) => setSessionPersonId(personId);
const create = (args: Record<string, unknown>): Pick<ProposedAction, "fn" | "args"> => ({
  fn: "createTask",
  args: { title: "Prova", ...args },
});
const A = { cls: "A", reasons: [] };

beforeEach(() => {
  resetApi();
  setLatency(0);
  as(ROBERTA);
});

/** Un'automazione di Roberta su un evento di Stubwise in un progetto: accesa, in bozza o in pausa. */
async function automationOn(
  event: "task_created" | "task_closed",
  projectId: string,
  status: "active" | "draft" | "paused" = "active",
): Promise<string> {
  const a = await automations.createAutomation({
    name: `Su ${event}`,
    projectId,
    flow: {
      trigger: { kind: "stubwise", event },
      steps: [{ id: "w", kind: "wait", for: { days: 1 } }],
      titleTemplate: "{{task.codice}}",
    },
  });
  if (status !== "draft") await automations.activate(a.id);
  if (status === "paused") await automations.pause(a.id);
  return a.id;
}

describe("classOf: creare una task", () => {
  it("Giulia crea in MKX una task sua: A, nessun motivo", () => {
    expect(classOf(GIULIA, create({ projectId: MKX, assigneeId: GIULIA }))).toEqual(A);
  });

  it("una task non assegnata di Giulia in MKX, senza avvisi né automazioni: A", () => {
    expect(classOf(GIULIA, create({ projectId: MKX }))).toEqual(A);
  });

  it("in AUD, dove Matteo segue le task nuove: B, «Notifies Matteo Conti»", () => {
    expect(classOf(GIULIA, create({ projectId: AUD, assigneeId: GIULIA }))).toEqual({
      cls: "B",
      reasons: [{ kind: "notifies", personIds: [MATTEO], more: false }],
    });
  });

  it("chi chiede non è mai fra chi viene avvisato: Matteo che crea in AUD resta A", () => {
    expect(classOf(MATTEO, create({ projectId: AUD, assigneeId: MATTEO }))).toEqual(A);
  });

  it("con un'automazione attiva su task_created nel progetto: B col motivo; in bozza o in pausa: A", async () => {
    await automationOn("task_created", MKX, "draft");
    await automationOn("task_created", MKX, "paused");
    expect(classOf(GIULIA, create({ projectId: MKX, assigneeId: GIULIA }))).toEqual(A);
    const id = await automationOn("task_created", MKX);
    expect(classOf(GIULIA, create({ projectId: MKX, assigneeId: GIULIA }))).toEqual({
      cls: "B",
      reasons: [{ kind: "automation", projectId: MKX }],
    });
    expect(
      automationsStartingOn({
        event: "task_created",
        projectId: MKX,
        payload: {
          task: { codice: "MKX-99", titolo: "x", progetto: "MKX", incaricato: "", stato: "" },
        },
      }),
    ).toEqual([id]);
    // Un altro progetto non la fa partire.
    expect(classOf(GIULIA, create({ projectId: OLV, assigneeId: GIULIA }))).toEqual(A);
  });

  it("assegnata a Marco in OLV: B, «Notifies Marco Bellini» (task.assigned)", () => {
    expect(classOf(GIULIA, create({ projectId: OLV, assigneeId: MARCO }))).toEqual({
      cls: "B",
      reasons: [{ kind: "notifies", personIds: [MARCO], more: false }],
    });
  });

  it("assegnata a Claude: nessuno da avvisare (R-K5), resta A", () => {
    expect(classOf(GIULIA, create({ projectId: MKX, assigneeId: CLAUDE }))).toEqual(A);
  });
});

describe("classOf: pianificare e modificare", () => {
  const giuliaTask = (projectId = OLV, assigneeId: string | null = GIULIA): Task =>
    createTaskAs(GIULIA, { projectId, title: "Raccolta", assigneeId });

  it("una task di Giulia in OLV spostata a Marco con planTask: B, «Notifies Marco Bellini» (P9)", () => {
    const task = giuliaTask();
    expect(
      classOf(GIULIA, {
        fn: "planTask",
        args: { id: task.id, plan: { assigneeId: MARCO, week: null } },
      }),
    ).toEqual({ cls: "B", reasons: [{ kind: "notifies", personIds: [MARCO], more: false }] });
  });

  it("la stessa spostata solo di settimana, restando di Giulia: A", () => {
    const task = giuliaTask();
    expect(
      classOf(GIULIA, {
        fn: "planTask",
        args: { id: task.id, plan: { assigneeId: GIULIA, week: "2026-W46" } },
      }),
    ).toEqual(A);
  });

  it("una task di Marco spostata di settimana da Giulia avvisa Marco (planning.changed)", () => {
    const task = giuliaTask(OLV, MARCO);
    expect(
      classOf(GIULIA, {
        fn: "planTask",
        args: { id: task.id, plan: { assigneeId: MARCO, week: "2026-W46" } },
      }),
    ).toEqual({ cls: "B", reasons: [{ kind: "notifies", personIds: [MARCO], more: false }] });
  });

  it("updateTask della propria task a «done» con un'automazione su task_closed: B", async () => {
    const task = giuliaTask(MKX);
    const done = state.statuses.find((s) => s.projectId === MKX && s.family === "closed")!;
    const patch = { id: task.id, patch: { statusId: done.id } };
    expect(classOf(GIULIA, { fn: "updateTask", args: patch })).toEqual(A);
    await automationOn("task_closed", MKX);
    expect(classOf(GIULIA, { fn: "updateTask", args: patch })).toEqual({
      cls: "B",
      reasons: [{ kind: "automation", projectId: MKX }],
    });
  });

  it("updateTask che riassegna a Marco: B con «Notifies Marco Bellini»", () => {
    const task = giuliaTask();
    expect(
      classOf(GIULIA, { fn: "updateTask", args: { id: task.id, patch: { assigneeId: MARCO } } }),
    ).toEqual({ cls: "B", reasons: [{ kind: "notifies", personIds: [MARCO], more: false }] });
  });

  it("updateTask di una task non assegnata a chi chiede: B", () => {
    const task = giuliaTask(MKX, null);
    expect(
      classOf(GIULIA, { fn: "updateTask", args: { id: task.id, patch: { title: "Altro" } } }).cls,
    ).toBe("B");
  });

  it("una task che chi chiede non vede: nessun motivo che ne parli", () => {
    const hidden = state.tasks.find((t) => t.projectId === "prj-acq")!;
    expect(
      classOf(GIULIA, {
        fn: "planTask",
        args: { id: hidden.id, plan: { assigneeId: MARCO, week: null } },
      }),
    ).toEqual(A);
  });
});

describe("classOf: le altre voci", () => {
  it("addMember è C con la riconferma; deleteTask è B e non si annulla", () => {
    expect(
      classOf(ROBERTA, {
        fn: "addMember",
        args: { projectId: OLV, personId: "p-laura", roleId: "role-developer" },
      }),
    ).toEqual({ cls: "C", reasons: [{ kind: "reauth" }] });
    expect(classOf(ROBERTA, { fn: "deleteTask", args: { id: "t-olv-1" } })).toEqual({
      cls: "B",
      reasons: [{ kind: "irreversible" }],
    });
  });

  it("le righe d'istanza: B, o C con la riconferma; registerPlugin e retryJob non si annullano", () => {
    for (const fn of ["setModel", "saveWebhook", "pauseQueue"] as const)
      expect(classOf(ROBERTA, { fn, args: {} }), fn).toEqual({ cls: "B", reasons: [] });
    expect(classOf(ROBERTA, { fn: "updatePluginRef", args: {} })).toEqual({
      cls: "C",
      reasons: [{ kind: "irreversible" }, { kind: "reauth" }],
    });
    expect(classOf(ROBERTA, { fn: "saveStorage", args: {} })).toEqual({
      cls: "C",
      reasons: [{ kind: "reauth" }],
    });
    expect(classOf(ROBERTA, { fn: "registerPlugin", args: {} })).toEqual({
      cls: "C",
      reasons: [{ kind: "irreversible" }, { kind: "reauth" }],
    });
    expect(classOf(ROBERTA, { fn: "retryJob", args: {} })).toEqual({
      cls: "B",
      reasons: [{ kind: "irreversible" }],
    });
  });

  it("setSubscription è A: è solo tuo", () => {
    expect(
      classOf(GIULIA, {
        fn: "setSubscription",
        args: { projectId: AUD, type: "task.created", app: true },
      }),
    ).toEqual(A);
  });

  it("una funzione fuori dal catalogo non è mai A", () => {
    expect(classOf(GIULIA, { fn: "recordDecision", args: {} }).cls).not.toBe("A");
  });
});

describe("classOfGroup", () => {
  it("la classe più alta, coi motivi di tutte e una sola riga «Notifies»", () => {
    expect(
      classOfGroup(GIULIA, [
        create({ projectId: MKX, assigneeId: GIULIA }),
        create({ projectId: OLV, assigneeId: MARCO }),
        create({ projectId: AUD, assigneeId: GIULIA }),
        { fn: "deleteTask", args: { id: "t-olv-1" } },
      ]),
    ).toEqual({
      cls: "B",
      reasons: [
        { kind: "notifies", personIds: [MARCO, MATTEO], more: false },
        { kind: "irreversible" },
      ],
    });
    expect(classOfGroup(GIULIA, [create({ projectId: MKX, assigneeId: GIULIA })])).toEqual(A);
  });
});

describe("R-G5: chi viene avvisato e chi chiede non vede", () => {
  /** Una persona che Giulia non vede, che però vede AUD (ne è membro solo lì). */
  function strangerInAud(): string {
    const seen = visiblePeopleFor(GIULIA);
    const stranger = PEOPLE.find((p) => !p.isClaude && !seen.has(p.id))!;
    expect(stranger).toBeDefined();
    state.projectsById.get(AUD)!.memberIds.push(stranger.id);
    return stranger.id;
  }

  it("wouldNotify non la nomina e accende `more`; chi chiede e Claude non ci sono", () => {
    const stranger = strangerInAud();
    expect(
      wouldNotify(GIULIA, {
        kind: "task.created_by_automation",
        projectId: AUD,
        mandatory: [
          { personId: stranger, reason: "assignee" },
          { personId: GIULIA, reason: "assignee" },
          { personId: CLAUDE, reason: "assignee" },
        ],
      }),
    ).toEqual({ personIds: [], more: true });
    expect(wouldNotify(GIULIA, { kind: "task.created", projectId: AUD })).toEqual({
      personIds: [MATTEO],
      more: false,
    });
    expect(wouldNotify(MATTEO, { kind: "task.created", projectId: AUD })).toEqual({
      personIds: [],
      more: false,
    });
  });

  it("una task assegnata a chi chi chiede non vede: B, senza il suo nome", () => {
    const stranger = strangerInAud();
    expect(classOf(GIULIA, create({ projectId: AUD, assigneeId: stranger }))).toEqual({
      cls: "B",
      reasons: [{ kind: "notifies", personIds: [MATTEO], more: true }],
    });
  });
});
