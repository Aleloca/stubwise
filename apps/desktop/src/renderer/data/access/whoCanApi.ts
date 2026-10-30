import { actionById, groupsFor, type AccessScope } from "../../domain/access/actions";
import { CLAUDE_ID, PEOPLE } from "../seed/people";
import { gate, state, visibleProjectIds } from "../store";
import { ALL_PROJECT_PERMISSIONS } from "./seed";
import { isMember, type PermissionSource } from "./effective";
import { INSTANCE_SET, accessState } from "./state";
import { visiblePeopleFor, whatCan as whatCanRaw, whoCan as whoCanRaw } from "./whoCan";

// «Chi può farlo?» come lo legge il client (`api.access`, area 9a, shape
// admin-audit.md). Le risposte sono quelle di `whoCan`/`whatCan` — cioè di
// `can()` — con i nomi già risolti: il ruolo, il reparto, chi ha dato il
// permesso (solo se chi guarda lo vede, R-G5: altrimenti «given by hand»).
// La pagina «Who can?» e il riquadro «Who?» accanto ai bottoni spenti leggono
// da qui, quindi rispondono come il bottone.

/** Il perché di una persona, in dati: la UI lo dice in parole. */
export type WhoCanReason =
  | { kind: "role"; roleName: string }
  | { kind: "grant"; byName: string | null; at: string }
  | { kind: "department"; departmentName: string }
  | { kind: "full_admin" };

export interface WhoCanPerson {
  personId: string;
  name: string;
  initials: string;
  reasons: WhoCanReason[];
}

export type WhoCanView =
  | { visible: false }
  | {
      visible: true;
      actionId: string;
      permission: string;
      scope: AccessScope;
      /** Il codice del progetto della domanda, `null` per un'azione d'istanza. */
      projectCode: string | null;
      people: WhoCanPerson[];
      /** Claude, sempre a parte: lavora, non decide (R-L9). */
      claude: { allowed: boolean };
    };

export interface WhatCanPermission {
  permission: string;
  held: boolean;
  /** Vuoto per Claude (è una regola, non una concessione) e per ciò che non ha. */
  reasons: WhoCanReason[];
}

export type WhatCanView =
  | { visible: false }
  | {
      visible: true;
      personId: string;
      name: string;
      isClaude: boolean;
      /** Il codice del progetto, `null` per l'istanza. */
      projectCode: string | null;
      /** Se la persona è membro del progetto (sempre vero per Claude, R-L9); `null` per l'istanza. */
      member: boolean | null;
      groups: { groupKey: string; permissions: WhatCanPermission[] }[];
    };

export interface WhoCanChoices {
  projects: { projectId: string; code: string; name: string }[];
  /** Le persone che chi guarda vede (Claude a parte, sempre in fondo). */
  people: { personId: string; name: string }[];
}

const personOf = (id: string) => PEOPLE.find((p) => p.id === id);

function reasonsOf(viewerId: string, sources: readonly PermissionSource[]): WhoCanReason[] {
  const visible = visiblePeopleFor(viewerId);
  return sources.map((s): WhoCanReason => {
    switch (s.kind) {
      case "role":
        return {
          kind: "role",
          roleName: accessState().roles.find((r) => r.id === s.roleId)?.name ?? s.roleId,
        };
      case "grant":
        return {
          kind: "grant",
          byName:
            s.grantedById && visible.has(s.grantedById)
              ? (personOf(s.grantedById)?.name ?? null)
              : null,
          at: s.at,
        };
      case "department":
        return {
          kind: "department",
          departmentName:
            state.departments.find((d) => d.id === s.departmentId)?.name ?? s.departmentId,
        };
      case "full_admin":
        return { kind: "full_admin" };
    }
  });
}

const codeOf = (projectId: string | null): string | null =>
  projectId ? (state.projectsById.get(projectId)?.code ?? null) : null;

/**
 * Chi può fare un'azione del catalogo in un progetto (`projectId: null` per
 * un'azione d'istanza). Un progetto invisibile o inesistente risponde
 * `{ visible: false }`, come una domanda senza risposta (R-G5).
 */
export async function whoCan(actionId: string, projectId: string | null): Promise<WhoCanView> {
  const me = await gate("access.whoCan");
  const action = actionById(actionId);
  if (!action) return { visible: false };
  const scoped = action.scope === "project" ? projectId : null;
  const raw = whoCanRaw(me, actionId, scoped);
  if (!raw.visible) return raw;
  return {
    visible: true,
    actionId,
    permission: action.permission,
    scope: action.scope,
    projectCode: codeOf(scoped),
    people: raw.people.map((p) => {
      const person = personOf(p.personId);
      return {
        personId: p.personId,
        name: person?.name ?? p.personId,
        initials: person?.initials ?? "",
        reasons: reasonsOf(me, p.sources),
      };
    }),
    claude: raw.claude,
  };
}

/**
 * Cosa può fare una persona (o Claude) in un progetto, o nell'istanza con
 * `projectId: null`: ogni permesso di quel livello, ce l'abbia o no (la
 * pagina mostra i mancanti solo a richiesta), raggruppati come la tabella
 * dei ruoli, con le fonti in parole. Persona o progetto invisibili →
 * `{ visible: false }`.
 */
export async function whatCan(personId: string, projectId: string | null): Promise<WhatCanView> {
  const me = await gate("access.whatCan");
  const raw = whatCanRaw(me, personId, projectId);
  if (!raw.visible) return raw;
  const isClaude = personId === CLAUDE_ID;
  const held = new Map(raw.groups.flatMap((g) => g.permissions).map((p) => [p.permission, p]));
  const scope: AccessScope = projectId === null ? "instance" : "project";
  const universe = new Set<string>(projectId === null ? [...INSTANCE_SET] : ALL_PROJECT_PERMISSIONS);
  const groups = groupsFor(scope)
    .map((g) => ({
      groupKey: g.key,
      permissions: g.permissions
        .filter((permission) => universe.has(permission))
        .map((permission): WhatCanPermission => {
          const h = held.get(permission);
          return {
            permission,
            held: !!h,
            reasons: h && !isClaude ? reasonsOf(me, h.sources) : [],
          };
        }),
    }))
    .filter((g) => g.permissions.length > 0);
  return {
    visible: true,
    personId,
    name: isClaude ? "Claude" : (personOf(personId)?.name ?? personId),
    isClaude,
    projectCode: codeOf(projectId),
    member: projectId === null ? null : isClaude || isMember(personId, projectId),
    groups,
  };
}

/** I due menu di «Who can?»: i progetti e le persone che chi guarda vede (R-G5). */
export async function whoCanChoices(): Promise<WhoCanChoices> {
  const me = await gate("access.whoCanChoices");
  const visible = visibleProjectIds(me);
  const people = me === CLAUDE_ID ? new Set<string>() : visiblePeopleFor(me);
  return {
    projects: state.projects
      .filter((p) => visible.has(p.id))
      .map((p) => ({ projectId: p.id, code: p.code, name: p.name }))
      .sort((a, b) => a.code.localeCompare(b.code)),
    people: [...people]
      .map((personId) => ({ personId, name: personOf(personId)?.name ?? personId }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

