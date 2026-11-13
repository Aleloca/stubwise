// Spostato in `@stubwise/shared` (`automations/plans.ts`), perché il worker
// usi gli stessi piani della prova (area 7, F1, con 72). Qui resta il
// re-export: nessun import del renderer cambia.
export {
  personName,
  failed,
  asFailure,
  projectOfEffect,
  refuse,
  resolveAssignee,
  planTask,
  planMilestone,
  planRequest,
  planNotify,
  runLimitFailure,
  projectGone,
  unavailable,
  projectRefusal,
} from "@stubwise/shared";
export type {
  PlanPerson,
  PlanWorld,
  EffectOutcome,
  ActionEffect,
  Planned,
  AssigneePlan,
  TaskPlan,
  MilestonePlan,
  RequestPlan,
  NotifyPlan,
} from "@stubwise/shared";
