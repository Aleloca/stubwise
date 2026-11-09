// Gli accessi come stato del livello dati (area 9a): vedi `state.ts`.
export * from "./state";
export * from "./effective";
export {
  ALL_PROJECT_PERMISSIONS,
  DEPARTMENT_ROLES,
  LOCAL_PROJECT_PERMISSIONS,
  SEED_INSTANCE_GRANTS,
  SEED_PROJECT_GRANTS,
  roleIdOf,
  seedAccessState,
} from "./seed";
