import { accessState } from "../access/index";
import { recordChange } from "../changelog/index";
import { gate, newId, now, state, visibleProjectIds } from "../store";
import { writer } from "../writer";
import {
  canI,
  emailOf,
  missingIn,
  isHumanId,
  nameOf,
  reauthRefusal,
  refuse,
  roleById,
} from "./common";
import { pendingInvites } from "./people";
import { forgetSecret, storeSecret } from "./secrets";
import type { AdminResult, InviteView } from "./types";
import "./changeTypes";

// Gli inviti (area 9a). Nell'app c'è solo chi invita: si crea un invito con
// email, ruolo d'istanza e progetti iniziali, si copia il link («consegnalo
// tu»: Stubwise non manda email), si revoca. L'accettazione è la schermata di
// registrazione dell'Ingresso (Task 5). Il link è un segreto: esce una volta,
// dal risultato di `createInvite`, e nessuna lettura né voce lo contiene.

const INVITE_DAYS = 7;
const USERS_INVITE = "users.invite";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const isExpired = (expiresAt: string) => Date.parse(expiresAt) < Date.parse(now());
const normalized = (email: string) => email.trim().toLowerCase();

/** Gli inviti in sospeso e scaduti (`users.invite`), coi soli progetti che chi guarda vede. */
export async function listInvites(): Promise<InviteView[]> {
  const me = await gate("admin.listInvites");
  if (!canI(me, USERS_INVITE)) throw new Error("forbidden");
  const visible = visibleProjectIds(me);
  return pendingInvites()
    .map((inv) => ({
      id: inv.id,
      email: inv.email,
      instanceRole: roleById(inv.instanceRoleId)
        ? { id: inv.instanceRoleId, name: roleById(inv.instanceRoleId)!.name }
        : null,
      projects: inv.projects
        .filter((p) => visible.has(p.projectId))
        .map((p) => ({
          projectId: p.projectId,
          code: state.projectsById.get(p.projectId)?.code ?? "",
          roleId: p.roleId,
          roleName: roleById(p.roleId)?.name ?? "",
        })),
      invitedById: inv.invitedById,
      invitedByName: nameOf(inv.invitedById) ?? "",
      createdAt: inv.createdAt,
      expiresAt: inv.expiresAt,
      expired: isExpired(inv.expiresAt),
    }))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export interface CreateInviteInput {
  email: string;
  instanceRoleId: string;
  projects: { projectId: string; roleId: string }[];
}

/**
 * Crea un invito (`users.invite`, +R): `{ link }` una volta. I progetti
 * ammessi sono quelli dove chi invita gestisce i membri; i ruoli (d'istanza e
 * di progetto) passano dall'anti-escalation.
 */
export async function createInvite(
  input: CreateInviteInput,
): Promise<AdminResult<{ inviteId: string; link: string; expiresAt: string }>> {
  const me = await writer("admin.createInvite");
  if (!canI(me, USERS_INVITE)) return refuse.forbidden();
  const visible = visibleProjectIds(me);
  for (const p of input.projects) {
    if (!visible.has(p.projectId)) return refuse.notFound();
    if (!canI(me, "project.members.manage", p.projectId)) return refuse.forbidden();
  }
  const email = normalized(input.email);
  if (!EMAIL.test(email)) return refuse.invalid("email");
  const taken = accessState().people.some(
    (p) => isHumanId(p.personId) && emailOf(p.personId).toLowerCase() === email,
  );
  if (taken) return refuse.invalid("email_taken");
  if (pendingInvites().some((i) => i.email === email && !isExpired(i.expiresAt)))
    return refuse.invalid("invite_exists");
  const instanceRole = roleById(input.instanceRoleId);
  if (!instanceRole || instanceRole.scope !== "instance") return refuse.invalid("role");
  const projectIds = input.projects.map((p) => p.projectId);
  if (new Set(projectIds).size !== projectIds.length) return refuse.invalid("project");
  for (const p of input.projects) {
    const role = roleById(p.roleId);
    if (!role || role.scope !== "project") return refuse.invalid("role");
  }
  // Si dà il ruolo d'istanza (coi soli permessi d'istanza) e, in ogni progetto, il suo ruolo.
  const missing = new Set<string>();
  for (const check of [
    missingIn(me, "instance", instanceRole.permissions),
    ...input.projects.map((p) => missingIn(me, [p.projectId], roleById(p.roleId)!.permissions)),
  ])
    for (const m of check) missing.add(m);
  if (missing.size > 0) return { ok: false, error: "escalation", missing: [...missing] };
  const reauth = reauthRefusal(me, "admin.createInvite");
  if (reauth) return reauth;
  const id = newId("inv");
  const { id: secretId, value } = storeSecret("invite_link", id);
  const expiresAt = new Date(Date.parse(now()) + INVITE_DAYS * 86_400_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
  state.invites.push({
    id,
    email,
    instanceRoleId: instanceRole.id,
    projects: input.projects.map((p) => ({ ...p })),
    invitedById: me,
    createdAt: now(),
    expiresAt,
    revokedAt: null,
    acceptedAt: null,
    secretId,
  });
  recordChange({
    kind: "invite.created",
    actorId: me,
    projectId: null,
    object: { type: "invite", id, label: email },
    after: instanceRole.name,
    params: { projects: String(input.projects.length) },
  });
  return { ok: true, inviteId: id, link: value, expiresAt };
}

/** Revoca un invito (`users.invite`): il link smette di valere. */
export async function revokeInvite(id: string): Promise<AdminResult> {
  const me = await writer("admin.revokeInvite");
  if (!canI(me, USERS_INVITE)) return refuse.forbidden();
  const invite = pendingInvites().find((i) => i.id === id);
  if (!invite) return refuse.notFound();
  invite.revokedAt = now();
  if (invite.secretId) forgetSecret(invite.secretId);
  invite.secretId = null;
  recordChange({
    kind: "invite.revoked",
    actorId: me,
    projectId: null,
    object: { type: "invite", id, label: invite.email },
  });
  return { ok: true };
}
