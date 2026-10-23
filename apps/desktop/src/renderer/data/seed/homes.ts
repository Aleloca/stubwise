import type { DayArrangement, DepartmentHome, HomeBlockRef, PersonalHome } from "../types";

// I due blocchi fissi aprono ogni Home: non si nascondono.
const FIXED: HomeBlockRef[] = [{ kind: "decide" }, { kind: "myWeek" }];

/** La Home predefinita di ogni reparto (la decide chi ha `department.home.manage`). */
export const DEPARTMENT_HOMES: DepartmentHome[] = [
  {
    departmentId: "dep-marketing",
    blocks: [
      ...FIXED,
      { kind: "myTasks" },
      { kind: "upcomingMilestones" },
      { kind: "filter", filterId: "flt-no-estimate" },
    ],
    updatedAt: "2026-10-12T09:00:00Z",
  },
  {
    departmentId: "dep-sales",
    blocks: [...FIXED, { kind: "myTasks" }, { kind: "newRequests" }],
    updatedAt: "2026-09-30T09:00:00Z",
  },
  {
    departmentId: "dep-support",
    blocks: [
      ...FIXED,
      { kind: "myTasks" },
      { kind: "newRequests" },
      { kind: "stalledInMyProjects" },
    ],
    updatedAt: "2026-10-02T09:00:00Z",
  },
  {
    departmentId: "dep-development",
    blocks: [
      ...FIXED,
      { kind: "claudeForMe" },
      { kind: "myTasks" },
      { kind: "stalledInMyProjects" },
      { kind: "filter", filterId: "flt-unassigned" },
    ],
    // Cambiata dopo che Marco ha personalizzato la sua: lui vede l'avviso.
    updatedAt: "2026-10-20T09:00:00Z",
  },
  {
    departmentId: "dep-administration",
    blocks: [...FIXED, { kind: "myTasks" }, { kind: "upcomingMilestones" }],
    updatedAt: "2026-09-15T09:00:00Z",
  },
];

/** Home personalizzate: solo Marco ne ha una. */
export const PERSONAL_HOMES: PersonalHome[] = [
  {
    personId: "p-marco",
    blocks: [
      ...FIXED,
      { kind: "claudeForMe" },
      { kind: "myTasks" },
      { kind: "filter", filterId: "flt-stalled" },
    ],
    seenDepartmentUpdates: { "dep-development": "2026-10-14T09:00:00Z" },
  },
];

/** Sistemazioni personali nei giorni della settimana corrente (solo dell'assegnatario). */
export const DAY_ARRANGEMENTS: DayArrangement[] = [
  { personId: "p-giulia", taskId: "t-stw-10", week: "2026-W43", day: 4 },
  { personId: "p-marco", taskId: "t-aud-3", week: "2026-W43", day: 1 },
  { personId: "p-marco", taskId: "t-stw-13", week: "2026-W43", day: 5 },
  { personId: "p-laura", taskId: "t-aud-2", week: "2026-W43", day: 3 },
  { personId: "p-sara", taskId: "t-stw-6", week: "2026-W43", day: null },
];
