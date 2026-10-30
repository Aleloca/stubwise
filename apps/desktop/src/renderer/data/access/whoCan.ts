import { actionById, groupPermissions } from "../../domain/access/actions";
import { orderHolders, peopleVisibleTo } from "../../domain/access/whoCan";
import { CLAUDE_ID, PEOPLE } from "../seed/people";
import { visibleProjectIds } from "../store";
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
      claude: { allowed: boolean };
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
 * `{ visible: false }`, come un progetto che non esiste.
 */
export function whoCan(viewerId: string, actionId: string, projectId: string | null): WhoCanResult {
  const action = actionById(actionId);
  if (!action) return { visible: false };
  const scoped = action.scope === "project" ? (projectId ?? undefined) : undefined;
  if (
    action.scope === "project" &&
    (scoped === undefined || !visibleProjectIds(viewerId).has(scoped))
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
    claude: { allowed: can(viewerFor(CLAUDE_ID), perm, scoped) },
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
  if (personId !== CLAUDE_ID && !visiblePeopleFor(viewerId).has(personId))
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
