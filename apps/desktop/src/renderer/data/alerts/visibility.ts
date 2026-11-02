import {
  alertTypeOf,
  isCatalogKind,
  resetAlertTypes,
  type AlertType,
} from "../../domain/alerts/catalog";
import {
  defaultApplies,
  recipientsOf,
  whyFor,
  type Perms,
  type Recipient,
  type RecipientContext,
} from "../../domain/alerts/recipients";
import { visiblePeopleFor } from "../access/whoCan";
import { PEOPLE } from "../seed/people";
import { now, onStoreReset, state, visibleProjectIds } from "../store";
import type { AppNotification, MandatoryReason } from "../types";
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

/** I full admin di adesso (mai Claude). */
export const fullAdminIds = (): string[] =>
  PEOPLE.filter(
    (p) => !p.isClaude && viewerFor(p.id).instancePermissions.includes("instance.full_admin"),
  ).map((p) => p.id);

/** Se il default di un tipo vale per la persona nel progetto (R-L10: anche full admin, per i tipi che lo dicono). */
export const defaultAppliesTo = (personId: string, projectId: string, def: AlertType): boolean =>
  defaultApplies(def, personId, {
    members: state.projectsById.get(projectId)?.memberIds ?? [],
    fullAdmins: def.defaultForFullAdmins ? fullAdminIds() : [],
  });

/** Un avviso coi destinatari calcolati: un kind del catalogo, in un progetto. */
export const isComputed = (n: AppNotification): n is AppNotification & { projectId: string } =>
  n.projectId !== null && isCatalogKind(n.kind);

/** Il contesto di un avviso del catalogo: membri, iscrizioni, permessi e visibilità di adesso. */
const contextOf = (n: AppNotification & { projectId: string }): RecipientContext => ({
  members: state.projectsById.get(n.projectId)?.memberIds ?? [],
  subs: state.alertSubscriptions.filter((s) => s.projectId === n.projectId && s.type === n.kind),
  permsOf: (personId) => permsIn(personId, n.projectId),
  seesProject: (personId) => canReceive(personId, n.projectId),
  fullAdmins: alertTypeOf(n.kind)?.defaultForFullAdmins ? fullAdminIds() : [],
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
  // R-K5 anche fuori dal catalogo: con R-L9 Claude vede ogni progetto, quindi
  // la visibilità non lo filtra più.
  if (isClaude(personId) || !n.recipientIds.includes(personId)) return null;
  if (n.projectId && !visibleProjectIds(personId).has(n.projectId)) return null;
  return "fixed";
}

export const notificationById = (id: string): AppNotification | undefined =>
  state.notifications.find((n) => n.id === id);

/**
 * Divide chi verrebbe avvisato fra chi `me` vede (per nome) e gli altri
 * (R-G5: mai nominati né contati, solo `more`). Chi chiede e Claude non
 * ci sono: non si avvisa sé stessi, e Claude non riceve avvisi (R-K5).
 */
export function splitByVisibility(
  me: string,
  personIds: readonly string[],
): { personIds: string[]; more: boolean } {
  const seen = visiblePeopleFor(me);
  const others = [...new Set(personIds)].filter((id) => id !== me && !isClaude(id));
  return {
    personIds: others.filter((id) => seen.has(id)).sort(),
    more: others.some((id) => !seen.has(id)),
  };
}

/**
 * Chi riceverebbe ADESSO un avviso del catalogo che `me` sta per far
 * pubblicare (area 10a: la classe calcolata di Claude). La stessa regola
 * delle letture (`recipientsOf` coi permessi, le iscrizioni e la
 * visibilità di adesso), su un avviso che non esiste ancora: viene dopo
 * ogni voce già scritta delle iscrizioni. Le notifiche dirette (`publish`
 * di `api-mutations.ts`) non passano da qui: le calcola chi le scrive.
 */
export function wouldNotify(
  me: string,
  alert: {
    kind: string;
    projectId: string;
    mandatory?: { personId: string; reason: MandatoryReason }[];
  },
): { personIds: string[]; more: boolean } {
  const n: AppNotification & { projectId: string } = {
    id: "n-would-notify",
    kind: alert.kind,
    projectId: alert.projectId,
    objectCode: "",
    departmentId: null,
    recipientIds: [],
    title: "",
    body: "",
    createdAt: now(),
    seq: Number.POSITIVE_INFINITY,
    read: false,
    archived: false,
    snoozedUntil: null,
    link: "",
    ...(alert.mandatory?.length ? { mandatory: alert.mandatory.map((m) => ({ ...m })) } : {}),
  };
  if (!isComputed(n)) return { personIds: [], more: false };
  return splitByVisibility(
    me,
    recipientsOf(n, contextOf(n)).map((r) => r.personId),
  );
}
