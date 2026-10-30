import { accessState, roleIdOf, writeAccess } from "../access/index";
import { nameOf, roleById } from "../admin/common";
import { forgetSecret, inviteLinkOf, matchSecret, storeSecret } from "../admin/secrets";
import type { Invite } from "../admin/types";
import "../admin/changeTypes";
import { recordChange } from "../changelog/index";
import { EMAIL_RE, MIN_PASSWORD_LENGTH, personByEmail } from "../me/account";
import { logSecurity } from "../me/securityLog";
import { PEOPLE, initials } from "../seed/people";
import { gate, newId, now, state } from "../store";

// La registrazione su invito (area 9a, Ingresso). Il link dell'invito apre
// una pagina col nome di chi invita e i progetti offerti; si scelgono nome e
// password, e la persona nasce coi ruoli dell'invito. Come sul server la
// registrazione NON apre una sessione (`second-factor.md`: ogni porta che dà
// una sessione passa dal login): dopo, si entra dal login.
//
// Il link si cerca fra i segreti con `matchSecret`, senza mai leggerne il
// valore. Un invito accettato lo dimentica; uno revocato lo tiene, per dire
// «revocato» a chi lo apre.

export type InviteLookup =
  | {
      status: "valid";
      email: string;
      invitedByName: string;
      projects: { projectId: string; code: string; name: string; roleName: string }[];
      /** Il ruolo d'istanza, solo se non è User («On the whole instance: Auditor»). */
      instanceRoleName: string | null;
      expiresAt: string;
    }
  | { status: "expired"; invitedByName: string; invitedAt: string; expiresAt: string }
  | { status: "revoked"; invitedByName: string }
  /** Link sconosciuto o già usato. */
  | { status: "invalid" };

export type RegisterResult =
  | { ok: true; personId: string }
  | { ok: false; error: "expired" | "revoked" | "invalid" }
  | { ok: false; error: "invalid_input"; reason: "name" | "password" | "email_taken" };

function inviteOf(token: string): Invite | null {
  const match = matchSecret("invite_link", inviteLinkOf(token));
  if (!match) return null;
  return state.invites.find((i) => i.id === match.ownerId && i.secretId === match.id) ?? null;
}

function statusOf(invite: Invite | null): "valid" | "expired" | "revoked" | "invalid" {
  if (!invite || invite.acceptedAt) return "invalid";
  if (invite.revokedAt) return "revoked";
  if (Date.parse(invite.expiresAt) <= Date.parse(now())) return "expired";
  return "valid";
}

/** Cosa dice un link d'invito: valido (con chi invita e i progetti), scaduto, revocato, o niente. */
export async function getInvite(token: string): Promise<InviteLookup> {
  await gate("auth.getInvite");
  const invite = inviteOf(token);
  const status = statusOf(invite);
  if (status === "invalid") return { status };
  const invitedByName = nameOf(invite!.invitedById) ?? "";
  if (status === "revoked") return { status, invitedByName };
  if (status === "expired")
    return {
      status,
      invitedByName,
      invitedAt: invite!.createdAt,
      expiresAt: invite!.expiresAt,
    };
  const instanceRole = roleById(invite!.instanceRoleId);
  return {
    status,
    email: invite!.email,
    invitedByName,
    projects: invite!.projects.flatMap((p) => {
      const project = state.projectsById.get(p.projectId);
      const role = roleById(p.roleId);
      return project && role
        ? [{ projectId: project.id, code: project.code, name: project.name, roleName: role.name }]
        : [];
    }),
    instanceRoleName:
      instanceRole && instanceRole.id !== roleIdOf("user") ? instanceRole.name : null,
    expiresAt: invite!.expiresAt,
  };
}

/**
 * SOLO PROTOTIPO, «Try an invite» nel riquadro del login: nell'app non c'è
 * una barra degli indirizzi da cui aprire un link d'invito, quindi qui se ne
 * crea uno nuovo per il primo invito in sospeso (`pending`) o scaduto
 * (`expired`) e se ne restituisce il token, una volta, come fa
 * `createInvite`. Il link di prima dell'invito si dimentica. `null` se non
 * c'è un invito adatto (l'istanza vuota non ne ha).
 */
export async function simulateInviteLink(
  which: "pending" | "expired",
): Promise<{ token: string } | null> {
  await gate("auth.simulateInviteLink");
  const invite = state.invites.find((i) => {
    if (i.acceptedAt || i.revokedAt) return false;
    const expired = Date.parse(i.expiresAt) <= Date.parse(now());
    return which === "expired" ? expired : !expired;
  });
  if (!invite) return null;
  if (invite.secretId) forgetSecret(invite.secretId);
  const { id, value } = storeSecret("invite_link", invite.id);
  invite.secretId = id;
  return { token: value.split("invite=")[1]! };
}

/**
 * Una persona nuova, attiva, senza secondo fattore (lo attiva alla prima
 * azione delicata): in `PEOPLE` (nome, email) e negli accessi (ruolo
 * d'istanza, appartenenze). La usano la registrazione e il primo avvio.
 */
export function createPerson(input: {
  name: string;
  email: string;
  password: string;
  instanceRoleId: string;
  projects: { projectId: string; roleId: string }[];
}): string {
  const id = newId("p");
  PEOPLE.push({
    id,
    name: input.name,
    initials: initials(input.name),
    departmentIds: [],
    isClaude: false,
    presetRole: "",
    email: input.email,
  });
  state.passwords.set(id, input.password);
  writeAccess((s) => {
    s.people.push({
      personId: id,
      instanceRoleId: input.instanceRoleId,
      status: "active",
      deactivatedAt: null,
      secondFactor: null,
    });
    for (const p of input.projects) s.memberships.push({ personId: id, ...p });
  });
  return id;
}

/** I controlli comuni di nome, password ed email di una persona nuova. */
export function newPersonInputError(input: {
  name: string;
  email: string;
  password: string;
}): "name" | "email" | "password" | "email_taken" | null {
  if (!input.name.trim()) return "name";
  if (!EMAIL_RE.test(input.email.trim())) return "email";
  if (input.password.length < MIN_PASSWORD_LENGTH) return "password";
  if (personByEmail(input.email)) return "email_taken";
  return null;
}

/**
 * Accetta un invito valido: la persona nasce con l'email, il ruolo d'istanza
 * e i progetti (coi loro ruoli) dell'invito. Il link non vale più.
 */
export async function register(
  token: string,
  input: { name: string; password: string },
): Promise<RegisterResult> {
  await gate("auth.register");
  const invite = inviteOf(token);
  const status = statusOf(invite);
  if (status !== "valid") return { ok: false, error: status };
  const fields = { name: input.name, email: invite!.email, password: input.password };
  const error = newPersonInputError(fields);
  if (error === "email") return { ok: false, error: "invalid" };
  if (error) return { ok: false, error: "invalid_input", reason: error };
  const roles = new Set(accessState().roles.map((r) => r.id));
  const personId = createPerson({
    name: input.name.trim(),
    email: invite!.email,
    password: input.password,
    instanceRoleId: invite!.instanceRoleId,
    projects: invite!.projects.filter(
      (p) => state.projectsById.has(p.projectId) && roles.has(p.roleId),
    ),
  });
  invite!.acceptedAt = now();
  if (invite!.secretId) forgetSecret(invite!.secretId);
  invite!.secretId = null;
  logSecurity(personId, "registered", null);
  recordChange({
    kind: "invite.accepted",
    actorId: personId,
    projectId: null,
    object: { type: "invite", id: invite!.id, label: invite!.email },
    params: { projects: String(invite!.projects.length) },
  });
  return { ok: true, personId };
}
