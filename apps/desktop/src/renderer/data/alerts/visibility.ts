import { isCatalogKind, resetAlertTypes } from "../../domain/alerts/catalog";
import { recipientsOf, type Perms, type Recipient } from "../../domain/alerts/recipients";
import { PEOPLE } from "../seed/people";
import { onStoreReset, state, visibleProjectIds } from "../store";
import type { AppNotification } from "../types";
import { can, viewerFor } from "../viewer";

// Chi riceve un avviso — l'unica regola, per le letture (`listNotifications`)
// e le scritture (`markNotification`, «Non avvisarmi più»). I kind del
// catalogo hanno i destinatari calcolati a lettura (`recipientsOf`); gli
// altri (sicurezza, decisioni, Chat, Automazioni…) quelli fissi della riga.
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

/** I destinatari di adesso di un avviso del catalogo. */
export function recipientsNow(n: AppNotification & { projectId: string }): Recipient[] {
  const projectId = n.projectId;
  return recipientsOf(n, {
    members: state.projectsById.get(projectId)?.memberIds ?? [],
    subs: state.alertSubscriptions.filter((s) => s.projectId === projectId && s.type === n.kind),
    permsOf: (personId) => permsIn(personId, projectId),
    seesProject: (personId) => canReceive(personId, projectId),
  });
}

/**
 * Se `personId` riceve `n` adesso, e perché: `null` se non lo riceve.
 * Fuori dal catalogo: destinatario fisso, nei progetti che vede (`fixed`).
 */
export function whyReceives(
  personId: string,
  n: AppNotification,
): Recipient["why"] | "fixed" | null {
  if (isComputed(n)) return recipientsNow(n).find((r) => r.personId === personId)?.why ?? null;
  if (!n.recipientIds.includes(personId)) return null;
  if (n.projectId && !visibleProjectIds(personId).has(n.projectId)) return null;
  return "fixed";
}

export const notificationById = (id: string): AppNotification | undefined =>
  state.notifications.find((n) => n.id === id);
