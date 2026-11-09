import { registerChangeTypes, type ChangeType } from "../changelog/index";

// I tipi di voce del registro dell'area 9a: persone, inviti, ruoli, reparti
// (d'istanza) e membri (di progetto). Il `readPermission` è il permesso che
// gestisce l'oggetto; per le voci di progetto è SOLO un permesso di
// gestione, mai uno di lavoro: Claude, che i permessi di lavoro li ha in ogni
// progetto, non deve leggerne nessuna (test in `admin.test.ts`). La frase sta
// in `changelog.kinds.<kind>`; il gruppo del filtro «Type» in
// `changelog.groups.<group>` (un test controlla le due lingue).

const instance = (kind: string, readPermission: string, group: string): ChangeType => ({
  kind,
  templateKey: `changelog.kinds.${kind}`,
  readPermission,
  scope: "instance",
  group,
});
const project = (kind: string): ChangeType => ({
  kind,
  templateKey: `changelog.kinds.${kind}`,
  readPermission: "project.members.manage",
  scope: "project",
  group: "members",
});

export const ADMIN_CHANGE_TYPES: readonly ChangeType[] = [
  instance("person.instance_role_changed", "users.manage", "people"),
  instance("person.password_reset_link_created", "users.manage", "security"),
  instance("person.second_factor_reset", "users.manage", "security"),
  instance("person.git_identity_linked", "users.manage", "people"),
  instance("person.git_identity_unlinked", "users.manage", "people"),
  instance("person.bitbucket_username_set", "users.manage", "people"),
  instance("person.deactivated", "users.manage", "people"),
  instance("person.reactivated", "users.manage", "people"),
  instance("invite.created", "users.invite", "invites"),
  instance("invite.revoked", "users.invite", "invites"),
  // L'ingresso (Task 5): chi accetta un invito, chi crea l'istanza al primo avvio.
  instance("invite.accepted", "users.invite", "invites"),
  instance("instance.first_admin_created", "users.manage", "people"),
  instance("role.created", "roles.manage", "roles"),
  instance("role.updated", "roles.manage", "roles"),
  instance("role.deleted", "roles.manage", "roles"),
  instance("department.created", "departments.manage", "departments"),
  instance("department.updated", "departments.manage", "departments"),
  instance("department.members_changed", "departments.manage", "departments"),
  instance("department.home_managers_changed", "departments.manage", "departments"),
  instance("department.permissions_changed", "departments.manage", "departments"),
  instance("department.deleted", "departments.manage", "departments"),
  project("member.added"),
  project("member.removed"),
  project("member.role_changed"),
  project("member.permission_granted"),
  project("member.permission_revoked"),
];

registerChangeTypes(ADMIN_CHANGE_TYPES);
