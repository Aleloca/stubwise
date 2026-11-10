import { INSTANCE_PERMISSIONS, PROJECT_PERMISSIONS } from "@stubwise/shared";
import type { LocalInstancePermission, LocalProjectPermission } from "../types";

// I cataloghi dei permessi d'istanza (puri, senza stato né seme): li leggono
// `can()` (`data/viewing.ts`) e lo stato degli accessi del prototipo
// (`state.ts`, che li ri-esporta). Stanno qui perché la build app ha `can()`
// ma non lo stato finto (integrazione area 2, fetta 1).

/** I permessi d'istanza del prototipo, nell'ordine in cui si mostrano. */
export const LOCAL_INSTANCE_PERMISSIONS: readonly LocalInstancePermission[] = [
  "claude.public.view",
  "chat.general.create",
  "chat.general.manage",
  "automations.manage",
  "servers.ssh.manage",
  "instance.status.view",
  "changelog.view",
];

/** Ogni permesso d'istanza, del registro condiviso e del prototipo. */
export const INSTANCE_SET: ReadonlySet<string> = new Set<string>([
  ...INSTANCE_PERMISSIONS,
  ...LOCAL_INSTANCE_PERMISSIONS,
]);

/**
 * Permessi che esistono con lo stesso nome a due livelli (area 7: le
 * automazioni di progetto e quelle generali). Con un progetto vale quello di
 * progetto, senza quello d'istanza.
 */
export const BOTH_LEVELS: ReadonlySet<string> = new Set<string>(["automations.manage"]);

/**
 * Permessi di progetto che vivono solo nel prototipo, per preset: entrano nel
 * registro di `@stubwise/shared` quando si costruisce il backend.
 * (`planning.others` è nel registro condiviso dall'integrazione area 2,
 * fetta 2: del Project Lead e implicito per il full admin.) I canali della Chat (area 4) li crea il Project Lead o il Developer e li
 * gestisce il Project Lead. Il Drive (area 5): carica chiunque lavori nel
 * progetto (anche il Legacy Member, shape drive.md [A 14]), non il Viewer;
 * gestire e vedere lo storico delle aperture è del Project Lead. Le
 * automazioni del progetto (area 7) le gestisce il Project Lead. Ai clienti di
 * Support (area 8a) risponde chi lavora al progetto: Project Lead, Developer e
 * Legacy Member, non il Contributor né il Viewer. `servers.operate` (area 8b)
 * non è di nessun preset: si dà persona per persona (`SEED_PROJECT_GRANTS`).
 */
export const LOCAL_PROJECT_PERMISSIONS: Readonly<
  Record<string, readonly LocalProjectPermission[]>
> = {
  project_lead: [
    "chat.channels.create",
    "chat.channels.manage",
    "drive.upload",
    "drive.manage",
    "drive.history",
    "automations.manage",
    "support.reply",
  ],
  developer: ["chat.channels.create", "drive.upload", "support.reply"],
  contributor: ["drive.upload"],
  legacy_member: ["drive.upload", "support.reply"],
};

/** Ogni permesso di progetto, del registro condiviso e del prototipo (quelli che il full admin ha ovunque). */
export const ALL_PROJECT_PERMISSIONS: readonly string[] = [
  ...PROJECT_PERMISSIONS,
  ...new Set([...Object.values(LOCAL_PROJECT_PERMISSIONS).flat(), "servers.operate"]),
];
