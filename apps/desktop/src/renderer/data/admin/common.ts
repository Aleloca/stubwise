import { membersManagersOf } from "../../domain/access/guards";
import { checkEscalation, type PermissionMap } from "../../domain/access/escalation";
import {
  accessState,
  effectivePermissions,
  isFullAdminIn,
  type AccessState,
  type PermissionSource,
} from "../access/index";
import { requireReauth } from "../auth/reauth";
import { person as addressOf } from "../seed/mail/helpers";
import { CLAUDE_ID, PEOPLE } from "../seed/people";
import { state, type ApiFnName } from "../store";
import { can, viewerFor, type Permission } from "../viewer";
import type { AdminRefusal, SourceView } from "./types";

// Ciò che le scritture d'amministrazione (area 9a) condividono: i rifiuti,
// la riconferma, l'anti-escalation sul DARE, i blocchi «resta sempre un full
// admin» e «resta sempre chi gestisce i membri», i nomi.
//
// L'ordine dei controlli di ogni scrittura: `not_found` (R-G5) → `forbidden`
// → l'input (`invalid`) → `escalation` → i blocchi → `reauth_required` →
// la scrittura e la sua voce del registro. La riconferma viene DOPO le regole
// apposta: non si chiede il codice per un'azione che sarebbe rifiutata.

export const refuse = {
  notFound: (): AdminRefusal => ({ ok: false, error: "not_found" }),
  forbidden: (): AdminRefusal => ({ ok: false, error: "forbidden" }),
  reauth: (): AdminRefusal => ({ ok: false, error: "reauth_required" }),
  invalid: (
    reason: string,
    usedBy?: Extract<AdminRefusal, { error: "invalid" }>["usedBy"],
  ): AdminRefusal =>
    usedBy
      ? { ok: false, error: "invalid", reason, usedBy }
      : { ok: false, error: "invalid", reason },
};

/** `reauth_required` se la funzione è dichiarata e manca una riconferma recente. */
export function reauthRefusal(me: string, fn: ApiFnName): AdminRefusal | null {
  return requireReauth(me, fn) ? refuse.reauth() : null;
}

export const canI = (me: string, perm: string, projectId?: string): boolean =>
  can(viewerFor(me), perm as Permission, projectId);

export const nameOf = (personId: string | null): string | null =>
  personId === null ? null : (PEOPLE.find((p) => p.id === personId)?.name ?? personId);

/** Le persone umane dell'istanza (Claude non è una persona dell'Amministrazione). */
export const isHumanId = (personId: string): boolean =>
  personId !== CLAUDE_ID && accessState().people.some((p) => p.personId === personId);

export const statusOf = (personId: string): "active" | "deactivated" | null =>
  accessState().people.find((p) => p.personId === personId)?.status ?? null;

export const isActive = (personId: string): boolean => statusOf(personId) === "active";

/** L'email di una persona del team (quella del suo account Google, o `nome.cognome@example.com`). */
export const emailOf = (personId: string): string => addressOf(personId).email;

export const avatarOf = (personId: string): string =>
  PEOPLE.find((p) => p.id === personId)?.initials ?? "";

export const roleById = (id: string) => accessState().roles.find((r) => r.id === id);

export const departmentName = (id: string): string =>
  state.departments.find((d) => d.id === id)?.name ?? id;

/**
 * I permessi che chi agisce ha DA QUALCHE PARTE: quelli d'istanza più quelli
 * di progetto di ogni progetto di cui è membro (la stessa domanda di `can()`
 * senza progetto). È il confronto per ciò che non vive in un progetto: il
 * contenuto di un ruolo, i permessi di un reparto, il ruolo d'istanza.
 */
export function holdingsAnywhere(me: string): PermissionMap {
  const map = new Map<string, PermissionSource[]>(effectivePermissions(me));
  for (const m of accessState().memberships) {
    if (m.personId !== me) continue;
    for (const [perm, sources] of effectivePermissions(me, m.projectId))
      if (!map.has(perm)) map.set(perm, sources);
  }
  return map;
}

/** `escalation` sul DARE, coi permessi effettivi di chi agisce (in un progetto o ovunque). */
export function escalationRefusal(
  actor: PermissionMap,
  wanted: readonly string[],
): AdminRefusal | null {
  const check = checkEscalation(actor, wanted);
  return check.ok ? null : { ok: false, error: "escalation", missing: check.missing };
}

/** Ciò che manca per dare `wanted` (vuoto = si può): i campi `missing` delle letture. */
export const missingFor = (actor: PermissionMap, wanted: readonly string[]): string[] => {
  const check = checkEscalation(actor, wanted);
  return check.ok ? [] : check.missing;
};

const activeFullAdmins = (s: AccessState): string[] =>
  s.people
    .filter((p) => p.status === "active" && isFullAdminIn(s, p.personId))
    .map((p) => p.personId);

/**
 * I blocchi del Task 2 su una modifica: la si prova su una copia dello stato
 * con la STESSA funzione che poi scrive (`writeAccess(mutate)`), così prova e
 * scrittura non possono divergere. Rifiuta se la modifica lascerebbe
 * l'istanza senza un full admin attivo, o un progetto senza chi ne gestisce i
 * membri (`membersManagersOf`: i membri attivi con `project.members.manage` da
 * qualunque fonte, più ogni full admin attivo, membro implicito).
 */
export function invariantRefusal(mutate: (s: AccessState) => void): AdminRefusal | null {
  const before = accessState();
  const after = structuredClone(before);
  mutate(after);
  if (activeFullAdmins(before).length > 0 && activeFullAdmins(after).length === 0)
    return refuse.invalid("last_full_admin");
  for (const project of state.projects) {
    if (
      membersManagersOf(before, project.id).length > 0 &&
      membersManagersOf(after, project.id).length === 0
    )
      return refuse.invalid("last_members_manager");
  }
  return null;
}

/** Una fonte di un permesso come la legge il client. */
export function sourceView(source: PermissionSource): SourceView {
  switch (source.kind) {
    case "role":
      return { kind: "role", roleId: source.roleId, roleName: roleById(source.roleId)?.name ?? "" };
    case "grant":
      return {
        kind: "grant",
        grantedById: source.grantedById,
        grantedByName: nameOf(source.grantedById),
        at: source.at,
        origin: source.grantedById === null ? "seed" : "given",
      };
    case "department":
      return {
        kind: "department",
        departmentId: source.departmentId,
        departmentName: departmentName(source.departmentId),
      };
    case "full_admin":
      return { kind: "full_admin" };
  }
}
