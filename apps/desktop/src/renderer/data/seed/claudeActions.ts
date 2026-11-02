import type { ChangeEntry } from "../changelog/types";
import type { ClaudeActionRecord } from "../claude/types";
import type { ActivityEntry, AppNotification } from "../types";
import { daysFromToday } from "./dates";
import { TASKS } from "./tasks";

// Il seme delle azioni di Claude (area 10a, Task 7): due conversazioni di
// Giulia nate dal riquadro e la notifica di Marco. Sono FATTI scritti come li
// scrivono le funzioni vere (le stesse righe che un giro di `planTask` e
// `saveProjectAutomations` lascia: un test del seme le confronta con
// quelle), così «Annulla», il «com'era» e «Undone by» leggono un seme coerente.
//
// - Conversazione 1 («Move my MKX task»): un `planTask` di classe A su una
//   task di Giulia in MKX, eseguito e poi annullato. Non scrive niente nel
//   registro, solo attività.
// - Conversazione 2 («MKX brief and a task for Marco»): una scheda B
//   confermata con due azioni, `planTask` di una task di OLV a Marco e
//   `saveProjectAutomations` di MKX col brief spento; poi annullata. La
//   task sta in OLV perché Marco non è membro di MKX e `planTaskAs`
//   rifiuterebbe l'assegnatario (ruling del controller (pre-flight), P3).
// - Lo stato finale delle due task e delle impostazioni è quello del seme:
//   l'«Annulla» ha rimesso tutto com'era. Per questo l'interruttore del
//   brief di MKX, che nel seme è SPENTO, ha una voce a mano di Roberta dopo
//   l'«Annulla» (Off → On, poi On → Off): senza, il registro direbbe che il
//   brief è acceso.
//
// Gli `seq` seguono l'ordine in cui le scritture sono avvenute (P4): lo
// store parte da `SEED_MAX_SEQ`, quindi ogni scrittura della sessione viene
// dopo tutte quelle del seme. Le date sono relative a `CLOCK_START`.

const at = (days: number, hm: string) => `${daysFromToday(-days)}T${hm}:00Z`;

const GIULIA = "p-giulia";
const MARCO = "p-marco";

export const CLAUDE_SEED_IDS = {
  move: { conversation: "cv-giulia-claude-move", group: "cg-seed-1", action: "ca-seed-1", undo: "ca-seed-2" },
  brief: {
    conversation: "cv-giulia-claude-brief",
    group: "cg-seed-2",
    plan: "ca-seed-3",
    switch: "ca-seed-4",
    undoPlan: "ca-seed-5",
    undoSwitch: "ca-seed-6",
  },
  notification: "n-claude-1",
  /** L'avviso a Marco dell'«Annulla» confermato dalla sua scheda (I1). */
  undoNotification: "n-claude-2",
} as const;

/** Il tempo di ogni scena: esecuzione e «Annulla». */
export const CLAUDE_SEED_TIMES = {
  move: { run: at(4, "10:21"), undo: at(4, "10:34") },
  brief: { run: at(1, "09:42"), undo: at(1, "09:58") },
} as const;

/** Il numero più alto di `seq` del seme: lo store parte da qui. */
export const SEED_MAX_SEQ = 9;

const { move, brief } = CLAUDE_SEED_IDS;

/** Una task di Giulia in MKX (chiusa: è l'unica sua nel progetto) spostata di una settimana. */
export const MOVE_TASK = { id: "t-mkx-1", code: "MKX-1", from: "2026-W41", to: "2026-W42" } as const;
/** Una task di OLV che Giulia dà a Marco: assegnatario Giulia, settimana invariata. */
export const HANDOVER_TASK = { id: "t-olv-1", code: "OLV-1", week: "2026-W45" } as const;

/** Le azioni eseguite: una riga per azione, in ordine di esecuzione. */
export const CLAUDE_ACTIONS: ClaudeActionRecord[] = [
  {
    id: move.action,
    groupId: move.group,
    conversationId: move.conversation,
    personId: GIULIA,
    at: CLAUDE_SEED_TIMES.move.run,
    seq: 2,
    fn: "planTask",
    args: { id: MOVE_TASK.id, plan: { assigneeId: GIULIA, week: MOVE_TASK.to } },
    cls: "A",
    inverse: {
      fn: "planTask",
      args: { id: MOVE_TASK.id, plan: { assigneeId: GIULIA, week: MOVE_TASK.from } },
    },
    objects: [{ kind: "task", id: MOVE_TASK.id }],
    undone: { at: CLAUDE_SEED_TIMES.move.undo, byId: GIULIA },
  },
  {
    id: brief.plan,
    groupId: brief.group,
    conversationId: brief.conversation,
    personId: GIULIA,
    at: CLAUDE_SEED_TIMES.brief.run,
    seq: 6,
    fn: "planTask",
    args: { id: HANDOVER_TASK.id, plan: { assigneeId: MARCO, week: HANDOVER_TASK.week } },
    cls: "B",
    inverse: {
      fn: "planTask",
      args: { id: HANDOVER_TASK.id, plan: { assigneeId: GIULIA, week: HANDOVER_TASK.week } },
    },
    objects: [{ kind: "task", id: HANDOVER_TASK.id }],
    undone: { at: CLAUDE_SEED_TIMES.brief.undo, byId: GIULIA },
  },
  {
    id: brief.switch,
    groupId: brief.group,
    conversationId: brief.conversation,
    personId: GIULIA,
    at: CLAUDE_SEED_TIMES.brief.run,
    seq: 7,
    fn: "saveProjectAutomations",
    args: {
      projectId: "prj-mkx",
      switches: briefSwitches(false),
      pulseEveryDays: 7,
      correctionCap: 3,
    },
    cls: "B",
    inverse: {
      fn: "saveProjectAutomations",
      args: {
        projectId: "prj-mkx",
        switches: briefSwitches(true),
        pulseEveryDays: 7,
        correctionCap: 3,
      },
    },
    objects: [{ kind: "projectSettings", projectId: "prj-mkx" }],
    undone: { at: CLAUDE_SEED_TIMES.brief.undo, byId: GIULIA },
  },
];

/** Gli interruttori di MKX nel seme (software: docs e report; pulse acceso) con il brief come detto. */
function briefSwitches(weeklyBrief: boolean) {
  return {
    docsNightly: false,
    dailyReport: false,
    backlogDiscovery: true,
    pulse: true,
    weeklyBrief,
  };
}

const fieldChange = (
  id: string,
  taskId: string,
  when: string,
  field: string,
  from: string | null,
  to: string | null,
  actionId: string,
  seq: number,
): ActivityEntry => ({
  id,
  taskId,
  kind: "field_change",
  authorId: GIULIA,
  at: when,
  field,
  from,
  to,
  via: "claude",
  claudeActionId: actionId,
  seq,
});

/** L'attività con `via`: in fondo a quella del seme (gli indici di prima non si spostano). */
export const CLAUDE_ACTIVITY: ActivityEntry[] = [
  fieldChange("act-seed-claude-1", MOVE_TASK.id, CLAUDE_SEED_TIMES.move.run, "week", MOVE_TASK.from, MOVE_TASK.to, move.action, 1),
  fieldChange("act-seed-claude-2", MOVE_TASK.id, CLAUDE_SEED_TIMES.move.undo, "week", MOVE_TASK.to, MOVE_TASK.from, move.undo, 3),
  fieldChange("act-seed-claude-3", HANDOVER_TASK.id, CLAUDE_SEED_TIMES.brief.run, "assignee", "Giulia Ferri", "Marco Bellini", brief.plan, 4),
  fieldChange("act-seed-claude-4", HANDOVER_TASK.id, CLAUDE_SEED_TIMES.brief.undo, "assignee", "Marco Bellini", "Giulia Ferri", brief.undoPlan, 9),
];

type SeedChange = Omit<ChangeEntry, "before" | "after" | "params"> &
  Partial<Pick<ChangeEntry, "before" | "after" | "params">>;

const mkx = { type: "project", id: "prj-mkx", label: "MKX" };

/**
 * Le voci del registro: il brief di MKX spento da Claude per Giulia, il suo
 * inverso (con `undoOf`) e, dopo, la voce a mano che riporta il seme.
 */
export const CLAUDE_CHANGES: SeedChange[] = [
  {
    id: "chg-seed-claude-1",
    kind: "project.switch_changed",
    at: CLAUDE_SEED_TIMES.brief.run,
    actorId: GIULIA,
    projectId: "prj-mkx",
    object: mkx,
    before: "on",
    after: "off",
    params: { switch: "weeklyBrief" },
    via: "claude",
    claudeActionId: brief.switch,
    seq: 5,
  },
  {
    id: "chg-seed-claude-2",
    kind: "project.switch_changed",
    at: CLAUDE_SEED_TIMES.brief.undo,
    actorId: GIULIA,
    projectId: "prj-mkx",
    object: mkx,
    before: "off",
    after: "on",
    params: { switch: "weeklyBrief" },
    via: "claude",
    claudeActionId: brief.undoSwitch,
    undoOf: "chg-seed-claude-1",
    seq: 8,
  },
  {
    id: "chg-seed-claude-3",
    kind: "project.switch_changed",
    at: at(1, "11:15"),
    actorId: "p-roberta",
    projectId: "prj-mkx",
    object: mkx,
    before: "on",
    after: "off",
    params: { switch: "weeklyBrief" },
  },
];

/**
 * Le notifiche di Marco: l'avviso di `task.assigned`, scritto dentro l'azione
 * e poi annullata, e quello di `planning.changed` dell'«Annulla», che è
 * passato da una scheda perché avvisava lui (I1).
 */
export const CLAUDE_NOTIFICATIONS: AppNotification[] = [
  {
    id: CLAUDE_SEED_IDS.notification,
    kind: "task.assigned",
    projectId: "prj-olv",
    objectCode: HANDOVER_TASK.code,
    departmentId: TASKS.find((t) => t.id === HANDOVER_TASK.id)?.departmentId ?? null,
    recipientIds: [MARCO],
    title: `You've been assigned ${HANDOVER_TASK.code}`,
    body: `${HANDOVER_TASK.code} · Refresh landing page hero copy: Giulia Ferri assigned it to you.`,
    createdAt: CLAUDE_SEED_TIMES.brief.run,
    read: false,
    archived: false,
    snoozedUntil: null,
    link: `#/p/OLV/tasks?task=${HANDOVER_TASK.code}`,
    actorId: GIULIA,
    viaClaude: { personId: GIULIA, actionId: brief.plan },
  },
  {
    id: CLAUDE_SEED_IDS.undoNotification,
    kind: "planning.changed",
    projectId: "prj-olv",
    objectCode: HANDOVER_TASK.code,
    departmentId: TASKS.find((t) => t.id === HANDOVER_TASK.id)?.departmentId ?? null,
    recipientIds: [MARCO],
    title: "Planning changed",
    body: `${HANDOVER_TASK.code} · Refresh landing page hero copy: Giulia Ferri planned it for ${HANDOVER_TASK.week}.`,
    createdAt: CLAUDE_SEED_TIMES.brief.undo,
    read: false,
    archived: false,
    snoozedUntil: null,
    link: `#/p/OLV/tasks?task=${HANDOVER_TASK.code}`,
    actorId: GIULIA,
    viaClaude: { personId: GIULIA, actionId: brief.undoPlan },
    plannedWeek: HANDOVER_TASK.week,
  },
];
