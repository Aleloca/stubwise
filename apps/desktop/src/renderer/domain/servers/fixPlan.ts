import type { ServerPlan } from "@stubwise/shared";

// Il piano di correzione di un server (area 8, F4b). Il piano lo propone
// Claude: è contenuto del modello, NON fidato. Diventa una proposta solo se
// passa `validateServerPlan` di `@stubwise/shared`, la regola del server che
// il prototipo USA (mai una copia): lo schema CHIUSO (1–10 passi, solo
// azioni che cambiano dell'insieme `SERVER_ACTIONS`, parametri stretti,
// ognuno col perché) e ogni container visto sul server, legato a un ambiente
// del progetto attribuito (i suoi `containers`, R0-D, o il nome
// dell'ambiente) e a nessun altro progetto. Il testo libero non diventa mai
// un comando. «Libera spazio» (`docker.prune`) si propone su OGNI server
// (F4b-8 = c): su un server condiviso la scheda del piano lo dice PRIMA
// dell'approvazione, coi progetti che lo usano.

/** Il piano libera spazio: tocca tutto il server, non un container. */
export const prunes = (plan: ServerPlan): boolean =>
  plan.steps.some((s) => s.action === "docker.prune");

/** La chiave dell'etichetta di un'azione (`container.restart` → `container_restart`). */
export const actionKey = (action: string): string => action.replace(".", "_");
