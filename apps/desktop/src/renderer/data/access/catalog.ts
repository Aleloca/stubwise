import { INSTANCE_PERMISSIONS, PROJECT_PERMISSIONS } from "@stubwise/shared";
import type { LocalInstancePermission, LocalProjectPermission } from "../types";

// I cataloghi dei permessi d'istanza (puri, senza stato né seme): li leggono
// `can()` (`data/viewing.ts`) e lo stato degli accessi del prototipo
// (`state.ts`, che li ri-esporta). Stanno qui perché la build app ha `can()`
// ma non lo stato finto (integrazione area 2, fetta 1).

/** I permessi d'istanza del prototipo, nell'ordine in cui si mostrano. */
// `instance.status.view` è nel registro condiviso dalla F4 dell'area 9.
export const LOCAL_INSTANCE_PERMISSIONS: readonly LocalInstancePermission[] = [];

/** Ogni permesso d'istanza, del registro condiviso e del prototipo. */
export const INSTANCE_SET: ReadonlySet<string> = new Set<string>([
  ...INSTANCE_PERMISSIONS,
  ...LOCAL_INSTANCE_PERMISSIONS,
]);

/**
 * Permessi di progetto che vivono solo nel prototipo, per preset: entrano nel
 * registro di `@stubwise/shared` quando si costruisce il backend.
 * (`planning.others` è nel registro condiviso dall'integrazione area 2,
 * fetta 2: del Project Lead e implicito per il full admin.) I canali della Chat (area 4) sono nel registro condiviso dalla fetta 1
 * dell'integrazione, il Drive (area 5: `drive.upload`, `drive.manage`,
 * `drive.history`) dalla fetta 2, `automations.manage` di progetto (area 7,
 * del Project Lead) dalla fetta 1 dell'area 7, `support.manage` (Project Lead,
 * Developer e Legacy Member, area 8a) dalla fetta 3 dell'area 8: qui
 * resterebbero due volte nel ruolo. `servers.operate` (area 8, F4b) è nel
 * registro condiviso, in nessun preset: si dà persona per persona
 * (`SEED_PROJECT_GRANTS`).
 */
export const LOCAL_PROJECT_PERMISSIONS: Readonly<
  Record<string, readonly LocalProjectPermission[]>
> = {};

/** Ogni permesso di progetto, del registro condiviso e del prototipo (quelli che il full admin ha ovunque). */
// Un Set su TUTTO: un permesso del prototipo che entra nel registro condiviso
// non deve comparire due volte. `servers.operate` (area 8, F4b) è nel registro
// condiviso, in nessun preset (`PRESETLESS_PROJECT_PERMISSIONS`).
export const ALL_PROJECT_PERMISSIONS: readonly string[] = [
  ...new Set([...PROJECT_PERMISSIONS, ...Object.values(LOCAL_PROJECT_PERMISSIONS).flat()]),
];
