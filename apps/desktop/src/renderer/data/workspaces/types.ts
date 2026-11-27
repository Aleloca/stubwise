import type { AdminRefusal, AdminResult, RoleChoice } from "../admin/types";

// Le forme delle workspace come le legge la UI (shape `workspaces.md`). Il
// prototipo le calcola in `index.ts`; la build app le leggerà dalle rotte
// `/api/workspaces` (design §2.2), finché non c'è restano «in arrivo».

export type { AdminRefusal, AdminResult, RoleChoice };

/** Una voce della colonna di All projects. */
export interface WorkspaceSummary {
  id: string;
  slug: string;
  name: string;
  /** I progetti aperti della workspace che chi guarda vede (R-G5, D5: mai «3 of 7»). */
  projectCount: number;
  /** Se chi guarda ne fa parte. */
  isMember: boolean;
}

export interface WorkspaceList {
  /** Le workspace che chi guarda vede, per nome. */
  workspaces: WorkspaceSummary[];
  /** I progetti aperti e visibili fuori da ogni workspace («No workspace»). */
  noWorkspaceCount: number;
  /** La workspace di ogni progetto visibile che ne ha una (aperti e archiviati). */
  workspaceOfProject: Record<string, string>;
  /** `workspaces.manage`: crea, rinomina, elimina, aggiunge progetti e persone. */
  canManage: boolean;
}

/** La workspace aperta nella pagina filtrata. */
export interface WorkspaceView {
  id: string;
  slug: string;
  name: string;
  /** I progetti (aperti e archiviati, D6) che chi guarda vede. */
  projectIds: string[];
  /** Quante persone ne fanno parte (attive e no). */
  peopleCount: number;
  canManage: boolean;
}

/** Un ruolo di una persona in un progetto della workspace, con la sua fonte. */
export interface WorkspaceSeatRole {
  roleName: string;
  source: "workspace" | "member";
}

/** Una riga del pannello: un progetto della workspace e i ruoli di chi guardo lì. */
export interface WorkspaceMemberProject {
  projectId: string;
  code: string;
  name: string;
  /** Prima il ruolo per progetto (se c'è), poi quello di workspace. */
  roles: WorkspaceSeatRole[];
}

export interface WorkspaceMemberRow {
  personId: string;
  name: string;
  email: string;
  avatar: string;
  status: "active" | "deactivated";
  roleId: string;
  roleName: string;
  /** I ruoli per progetto IN PIÙ (membro esplicito) nei progetti della workspace. */
  projectRoles: { projectId: string; code: string; roleName: string }[];
  /** Tutti i progetti della workspace che chi guarda vede, con i ruoli. */
  projects: WorkspaceMemberProject[];
}

export interface WorkspaceMembersView {
  workspaceId: string;
  members: WorkspaceMemberRow[];
  canManage: boolean;
  /** I ruoli di progetto, con ciò che a chi guarda manca in QUALCHE progetto della workspace. */
  roleChoices: (RoleChoice & { missingIn: string[] })[];
  /** Il ruolo di base di un invito (D3: Viewer). */
  defaultRoleId: string;
  /** Chi si può aggiungere: attivo, non full admin, non ancora membro. */
  addable: { personId: string; name: string }[];
  /** I full admin cercati: si leggono spenti, «already sees everything». */
  fullAdmins: { personId: string; name: string }[];
}

export interface PersonRef {
  personId: string;
  name: string;
}

/**
 * Un'operazione di cui si vuole l'effetto prima di salvarla (design §2.2,
 * `POST /api/workspaces/effect`, che non scrive). Lo spostamento è un
 * `addProject` su un progetto già in un'altra workspace.
 */
export type WorkspaceOperation =
  | { kind: "create"; projectIds: string[] }
  | { kind: "addProject"; workspaceId: string; projectId: string }
  /** «Add projects…»: più progetti insieme (ognuno si scrive poi con `setProjectWorkspace`). */
  | { kind: "addProjects"; workspaceId: string; projectIds: string[] }
  | { kind: "removeProject"; projectId: string }
  | { kind: "delete"; workspaceId: string }
  | { kind: "addMember"; workspaceId: string; personId: string; roleId: string }
  | { kind: "setMemberRole"; workspaceId: string; personId: string; roleId: string }
  | { kind: "removeMember"; workspaceId: string; personId: string; alsoFromProjects: boolean };

/** Chi comincia e chi smette di vedere ogni progetto toccato, e cosa lo bloccherebbe. */
export interface WorkspaceEffect {
  projects: {
    projectId: string;
    code: string;
    startSeeing: PersonRef[];
    stopSeeing: PersonRef[];
  }[];
  /** D18: i progetti che resterebbero senza chi ne gestisca i membri (codici). */
  lastManager: string[];
  /** Ciò che chi agisce non può dare, progetto per progetto (codici e permessi). */
  escalation: { code: string; missing: string[] }[];
  /** D4: i progetti di cui chi agisce non gestisce i membri (codici). */
  notManaged: string[];
}
