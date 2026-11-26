// Spostato in `@stubwise/shared` (`automations/runRules.ts`), perché il worker
// usi gli stessi piani della prova (area 7, F1, con 72). Qui resta il
// re-export: nessun import del renderer cambia.
export {
  checkEdited,
  hideProject,
  leavesOf,
  passesStartFilter,
  startFilterChecks,
  NO_APPROVER_WHY,
  NO_APPROVER_REASON,
  approvalProjectOf,
} from "@stubwise/shared";
