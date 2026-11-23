import { actionById, groupPermissions } from "../../domain/access/actions";
import { orderHolders, peopleKnownTo, peopleVisibleTo } from "../../domain/access/whoCan";
import { CLAUDE_ID, PEOPLE } from "../seed/people";
import { canReadChannel, membersOf } from "../chat/visibility";
import { archivedProjectIdsFor, state, visibleProjectIds } from "../store";
import { can, viewerFor, type Permission } from "../viewer";
import { ALL_PROJECT_PERMISSIONS } from "./seed";
import { effectivePermissions, type PermissionSource } from "./effective";
import { INSTANCE_SET, accessState } from "./state";

// «Chi può farlo?» nei due versi (area 9a). Sta nel livello dati, non in
// `domain/`, perché chiede `can()` e i progetti visibili dello store: la
// risposta è `can()` stessa, persona per persona, e le fonti vengono da
// `effectivePermissions`. Non va ri-esportato da `./index`: lo store importa
// quel barile, e questo file importa lo store.

export type WhoCanResult =
  | { visible: false }
  | {
      visible: true;
      people: { personId: string; sources: PermissionSource[] }[];
      /**
       * Area 9 (decisione (a)): Claude non ha permessi suoi, agisce con quelli
       * di chi lo assegna o conferma la sua azione. Una risposta fissa, come
       * `agent` della rotta `who-can`.
       */
      agent: { actsFor: "confirmer" };
    };

export type WhatCanResult =
  | { visible: false }
  | {
      visible: true;
      groups: {
        groupKey: string;
        permissions: { permission: string; sources: PermissionSource[] }[];
      }[];
    };

const nameOf = (personId: string): string =>
  PEOPLE.find((p) => p.id === personId)?.name ?? personId;

/**
 * Le persone che chi guarda conosce (registro, A11 r.1414): la regola dei nomi
 * e degli id nelle viste, compresi disattivati ed ex membri dei progetti
 * visibili. Claude non c'è (non è una persona da nascondere).
 */
export function knownPeopleFor(viewerId: string): Set<string> {
  // Revisione del lotto 2 (I2, decisione di 46): un archiviato che chi guarda
  // può leggere conta come visibile.
  const known = peopleKnownTo({
    state: accessState(),
    viewerId,
    visibleProjectIds: new Set([...visibleProjectIds(viewerId), ...archivedProjectIdsFor(viewerId)]),
  });
  // Decisione del maintainer (23 nov 2026): «chi scrive in un canale che vedo
  // è conosciuto». Membri e autori dei canali che chi guarda può leggere,
  // anche senza un progetto in comune (i canali di tutta l'azienda).
  const readable = new Set<string>();
  for (const ch of state.channels) {
    if (!canReadChannel(viewerId, ch)) continue;
    readable.add(ch.id);
    for (const id of membersOf(ch)) known.add(id);
  }
  for (const m of state.chatMessages) {
    if (m.authorId !== null && readable.has(m.channelId)) known.add(m.authorId);
  }
  return known;
}

/**
 * Il nome di una persona per chi guarda: `null` se è una persona che non
 * conosce; Claude, o un attore che non è una persona, col suo nome di sempre.
 */
export function knownNameOf(viewerId: string, personId: string, known?: Set<string>): string | null {
  const person = PEOPLE.find((p) => p.id === personId);
  if (!person) return personId;
  if (personId === CLAUDE_ID) return person.name;
  return (known ?? knownPeopleFor(viewerId)).has(personId) ? person.name : null;
}

/** Le persone che chi guarda vede (R-G5), Claude escluso. */
export function visiblePeopleFor(viewerId: string): Set<string> {
  return peopleVisibleTo({
    state: accessState(),
    viewerId,
    visibleProjectIds: visibleProjectIds(viewerId),
  });
}

/**
 * Chi può fare un'azione del catalogo in un progetto (o nell'istanza, per
 * un'azione d'istanza: il progetto si ignora). Un progetto invisibile, uno
 * mancante per un'azione di progetto o un'azione sconosciuta rispondono
 * `{ visible: false }`, come un progetto che non esiste. Un archiviato ha
 * la risposta per i suoi ex membri e i full admin (`archivedProjectIdsFor`):
 * è il «Who?» di Reopen (ruling del controller (pre-flight), P10).
 */
export function whoCan(viewerId: string, actionId: string, projectId: string | null): WhoCanResult {
  const action = actionById(actionId);
  if (!action) return { visible: false };
  const scoped = action.scope === "project" ? (projectId ?? undefined) : undefined;
  if (
    action.scope === "project" &&
    (scoped === undefined ||
      (!visibleProjectIds(viewerId).has(scoped) && !archivedProjectIdsFor(viewerId).has(scoped)))
  )
    return { visible: false };
  const perm = action.permission as Permission;
  const people = [...visiblePeopleFor(viewerId)]
    .filter((id) => can(viewerFor(id), perm, scoped))
    .map((personId) => ({
      personId,
      sources: effectivePermissions(personId, scoped).get(perm) ?? [],
    }));
  return {
    visible: true,
    people: orderHolders(people, nameOf),
    agent: { actsFor: "confirmer" },
  };
}

/**
 * Cosa può fare una persona: in un progetto i permessi di progetto, con
 * `null` quelli d'istanza; raggruppati come la tabella dei ruoli, ognuno con
 * le sue fonti. Claude si vede sempre e non ha fonti: i suoi sono una regola
 * (R-L9), non una concessione.
 */
export function whatCan(
  viewerId: string,
  personId: string,
  projectId: string | null,
): WhatCanResult {
  if (projectId !== null && !visibleProjectIds(viewerId).has(projectId)) return { visible: false };
  // Area 9 (decisione (a)): Claude non ha permessi suoi, quindi non ha
  // risposta, come il 404 di `what-can` sul server.
  if (personId === CLAUDE_ID || !visiblePeopleFor(viewerId).has(personId))
    return { visible: false };
  const scoped = projectId ?? undefined;
  const universe = projectId === null ? [...INSTANCE_SET] : ALL_PROJECT_PERMISSIONS;
  const viewer = viewerFor(personId);
  const sources = effectivePermissions(personId, scoped);
  const held = universe
    .filter((p) => can(viewer, p as Permission, scoped))
    .map((permission) => ({ permission, sources: sources.get(permission) ?? [] }));
  return {
    visible: true,
    groups: groupPermissions(projectId === null ? "instance" : "project", held),
  };
}
