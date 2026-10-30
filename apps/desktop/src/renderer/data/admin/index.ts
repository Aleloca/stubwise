// L'Amministrazione (area 9a) come la espone `api.ts`: `api.admin.<funzione>`.
// People e inviti (`people.ts`, `invites.ts`), Roles (`roles.ts`),
// Departments (`departments.ts`) e i Members del progetto (`members.ts`).
// `changeTypes.ts` si importa per il suo effetto: registra i tipi di voce
// del registro prima della prima scrittura. `secrets.ts` NON si esporta: lo
// importano le scritture che creano un link (reset, invito).
import "./changeTypes";

export {
  createPasswordResetLink,
  deactivatePerson,
  getPerson,
  linkGitIdentity,
  listObservedAuthors,
  listPeople,
  listSecurityEvents,
  reactivatePerson,
  resetSecondFactor,
  setBitbucketUsername,
  setInstanceRole,
  unlinkGitIdentity,
} from "./people";
export { createInvite, listInvites, revokeInvite, type CreateInviteInput } from "./invites";
export { createRole, deleteRole, duplicateRole, listRoles, updateRole } from "./roles";
export {
  DEPARTMENT_COLORS,
  createDepartment,
  deleteDepartment,
  listDepartments,
  setDepartmentMembers,
  setDepartmentPermissions,
  setHomeManagers,
  updateDepartment,
} from "./departments";
export {
  addMember,
  grantMemberPermission,
  listProjectMembers,
  removeMember,
  revokeMemberPermission,
  setMemberRole,
} from "./members";
export type * from "./types";
