// Planning (spec §5): carico per persona e settimana, «To plan» e chi può
// spostare cosa. Le regole stanno in `@stubwise/shared` (integrazione area 2,
// fetta 2): il server le usa per decidere (`planBlock` sulla rotta `plan`), il
// renderer per mostrare. Qui si riesportano.
export {
  busiestCell,
  canMove,
  isToPlan,
  peopleLoad,
  planBlock,
  type PersonLoad,
  type PlanBlock,
  type PlanRights,
  type WeekLoad,
} from "@stubwise/shared";
