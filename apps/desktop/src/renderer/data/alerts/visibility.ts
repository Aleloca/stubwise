import { isCatalogKind, resetAlertTypes } from "../../domain/alerts/catalog";
import {
  whyFor,
  type Perms,
  type Recipient,
  type RecipientContext,
} from "../../domain/alerts/recipients";
import { PEOPLE } from "../seed/people";
import { onStoreReset, state, visibleProjectIds } from "../store";
import type { AppNotification } from "../types";
import { can, viewerFor } from "../viewer";

// Chi riceve un avviso — l'unica regola, per le letture (`listNotifications`)
// e le scritture (`markNotification`, «Non avvisarmi più»). I kind del
// catalogo hanno i destinatari calcolati a lettura (`whyFor`, la regola di
// `recipientsOf` per una persona sola); gli altri (sicurezza, decisioni,
// Chat, Automazioni…) quelli fissi della riga.
// Claude non riceve mai avvisi, obbligatori compresi (R-K5): è l'autore
// delle PR di Stubwise, non una persona da avvisare.

// `resetApi` rimette anche il catalogo: le righe registrate da un test non
// passano agli altri.
onStoreReset(resetAlertTypes);

const isClaude = (personId: string) => PEOPLE.some((p) => p.id === personId && p.isClaude);

/** Chi può ricevere un avviso del progetto adesso: una persona che lo vede. */
export const canReceive = (personId: string, projectId: string): boolean =>
  !isClaude(personId) && visibleProjectIds(personId).has(projectId);

export const permsIn =
  (personId: string, projectId: string): Perms =>
  (p) =>
    can(viewerFor(personId), p, projectId);

export const isMember = (personId: string, projectId: string): boolean =>
  state.projectsById.get(projectId)?.memberIds.includes(personId) ?? false;

/** Un avviso coi destinatari calcolati: un kind del catalogo, in un progetto. */
export const isComputed = (n: AppNotification): n is AppNotification & { projectId: string } =>
  n.projectId !== null && isCatalogKind(n.kind);

/** Il contesto di un avviso del catalogo: membri, iscrizioni, permessi e visibilità di adesso. */
const contextOf = (n: AppNotification & { projectId: string }): RecipientContext => ({
  members: state.projectsById.get(n.projectId)?.memberIds ?? [],
  subs: state.alertSubscriptions.filter((s) => s.projectId === n.projectId && s.type === n.kind),
  permsOf: (personId) => permsIn(personId, n.projectId),
  seesProject: (personId) => canReceive(personId, n.projectId),
});

/**
 * Se `personId` riceve `n` adesso, e perché: `null` se non lo riceve.
 * Fuori dal catalogo: destinatario fisso, nei progetti che vede (`fixed`).
 */
export function whyReceives(
  personId: string,
  n: AppNotification,
): Recipient["why"] | "fixed" | null {
  if (isComputed(n)) return whyFor(n, personId, contextOf(n));
  if (!n.recipientIds.includes(personId)) return null;
  if (n.projectId && !visibleProjectIds(personId).has(n.projectId)) return null;
  return "fixed";
}

export const notificationById = (id: string): AppNotification | undefined =>
  state.notifications.find((n) => n.id === id);
