import { registerChangeTypes, type ChangeType } from "../changelog/index";

// I tipi di voce del registro dell'area 9a: persone, inviti, ruoli, reparti
// (d'istanza) e membri (di progetto). Il `readPermission` è il permesso che
// gestisce l'oggetto; per le voci di progetto è SOLO un permesso di
// gestione, mai uno di lavoro: Claude, che i permessi di lavoro li ha in ogni
// progetto, non deve leggerne nessuna (test in `admin.test.ts`). La frase sta
// in `changelog.kinds.<kind>` (i testi li aggiunge la UI del registro).

const instance = (kind: string, readPermission: string): ChangeType => ({
  kind,
  templateKey: `changelog.kinds.${kind}`,
  readPermission,
  scope: "instance",
});
const project = (kind: string): ChangeType => ({
  kind,
  templateKey: `changelog.kinds.${kind}`,
  readPermission: "project.members.manage",
  scope: "project",
});

export const ADMIN_CHANGE_TYPES: readonly ChangeType[] = [
  instance("person.instance_role_changed", "users.manage"),
  instance("person.password_reset_link_created", "users.manage"),
  instance("person.second_factor_reset", "users.manage"),
  instance("person.git_identity_linked", "users.manage"),
  instance("person.git_identity_unlinked", "users.manage"),
  instance("person.bitbucket_username_set", "users.manage"),
  instance("person.deactivated", "users.manage"),
  instance("person.reactivated", "users.manage"),
  instance("invite.created", "users.invite"),
  instance("invite.revoked", "users.invite"),
  // L'ingresso (Task 5): chi accetta un invito, chi crea l'istanza al primo avvio.
  instance("invite.accepted", "users.invite"),
  instance("instance.first_admin_created", "users.manage"),
  instance("role.created", "roles.manage"),
  instance("role.updated", "roles.manage"),
  instance("role.deleted", "roles.manage"),
  instance("department.created", "departments.manage"),
  instance("department.updated", "departments.manage"),
  instance("department.members_changed", "departments.manage"),
  instance("department.home_managers_changed", "departments.manage"),
  instance("department.permissions_changed", "departments.manage"),
  instance("department.deleted", "departments.manage"),
  project("member.added"),
  project("member.removed"),
  project("member.role_changed"),
  project("member.permission_granted"),
  project("member.permission_revoked"),
];

registerChangeTypes(ADMIN_CHANGE_TYPES);
