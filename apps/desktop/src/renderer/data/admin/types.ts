import type { PermissionSource } from "../access/effective";
import type { RoleDef } from "../access/state";

// I tipi dell'Amministrazione (area 9a, Task 4): ciò che sta nello stato
// (`Invite`, `SecurityEvent`) e ciò che le letture restituiscono, con i campi
// calcolati dal livello dati che il client legge senza dedurli.

/** Un invito. Il link non sta qui: è un segreto (`secrets.ts`), visto una volta. */
export interface Invite {
  id: string;
  email: string;
  instanceRoleId: string;
  projects: { projectId: string; roleId: string }[];
  invitedById: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  acceptedAt: string | null;
  /** Il segreto del link (`invite_link`); `null` per gli inviti del seme, il cui link nessuno ha più. */
  secretId: string | null;
}

export type SecurityEventKind =
  | "signed_in"
  | "password_changed"
  | "second_factor_enabled"
  | "second_factor_reset"
  | "password_reset_link_created"
  | "deactivated"
  | "reactivated"
  // Preferenze e ingresso (area 9a, Task 5)
  | "signed_out"
  | "session_ended"
  | "authenticator_changed"
  | "passkey_added"
  | "passkey_removed"
  | "backup_codes_regenerated"
  | "backup_code_used"
  | "second_factor_locked"
  | "token_created"
  | "token_revoked"
  | "registered";

/** Un evento del registro della sicurezza di una persona. `byId` è chi l'ha fatto, se non lei. */
export interface SecurityEvent {
  id: string;
  personId: string;
  kind: SecurityEventKind;
  at: string;
  byId: string | null;
}

// --- risultati delle scritture ----------------------------------------------

/**
 * I rifiuti di una scrittura d'amministrazione, tutti in forma di dato (la UI
 * li dice in parole, stato invariato). `not_found` per ciò che chi agisce non
 * vede (R-G5), `forbidden` senza il permesso di gestione, `reauth_required`
 * senza una riconferma recente, `escalation` per ciò che si darebbe senza
 * averlo, `invalid` con il motivo (`self`, `last_full_admin`,
 * `last_members_manager`, `preset`, `in_use`…). Un guasto simulato
 * (`failNext`) invece lancia, come nel resto del prototipo.
 */
export type AdminRefusal =
  | { ok: false; error: "not_found" }
  | { ok: false; error: "forbidden" }
  | { ok: false; error: "reauth_required" }
  | { ok: false; error: "escalation"; missing: string[] }
  | {
      ok: false;
      error: "invalid";
      reason: string;
      /** Solo `in_use`: chi ha il ruolo, fra le persone e i progetti che chi guarda vede. */
      usedBy?: { personId: string; projectId: string | null }[];
    };

export type AdminResult<T extends object = object> = ({ ok: true } & T) | AdminRefusal;

// --- viste ------------------------------------------------------------------

/** Una fonte di un permesso come la legge il client, con i nomi già risolti. */
export type SourceView =
  | { kind: "role"; roleId: string; roleName: string }
  | {
      kind: "grant";
      grantedById: string | null;
      grantedByName: string | null;
      at: string;
      /** `given`: «given by Roberta on Oct 29»; `seed`: «from the seed» (nessun autore). */
      origin: "given" | "seed";
    }
  | { kind: "department"; departmentId: string; departmentName: string }
  | { kind: "full_admin" };

/** Un permesso in più del ruolo (concessione o reparto), con le sue fonti. */
export interface ExtraPermission {
  permission: string;
  sources: SourceView[];
  /** Vero se fra le fonti c'è una concessione personale: è la sola che Members toglie. */
  granted: boolean;
}

/** Un ruolo da scegliere, con ciò che a chi guarda manca per darlo (vuoto = si può). */
export interface RoleChoice {
  roleId: string;
  name: string;
  permissionCount: number;
  missing: string[];
}

export interface MemberRow {
  personId: string;
  name: string;
  email: string;
  avatar: string;
  status: "active" | "deactivated";
  role: RoleDef;
  extra: ExtraPermission[];
}

export interface ProjectMembersView {
  projectId: string;
  members: MemberRow[];
  /** La riga sotto l'elenco: i full admin non sono elencati perché possono tutto. */
  fullAdminNote: true;
  /** Chi guarda gestisce i membri del progetto. */
  canManage: boolean;
  /** I ruoli di progetto, con ciò che manca a chi guarda per darli in questo progetto. */
  roleChoices: RoleChoice[];
  /** Ogni permesso di progetto, con `allowed` se chi guarda lo può dare qui (gestisce i membri e lo ha). */
  grantable: { permission: string; allowed: boolean }[];
  /** Chi si può aggiungere: persone attive, non membri, né Claude né full admin. */
  addable: string[];
  /**
   * Per chi si può aggiungere, i permessi dei suoi reparti che chi guarda non
   * ha qui (vuoto = si può): entrando li riceverebbe, quindi si danno.
   */
  addableMissing: Record<string, string[]>;
}

export interface PersonRow {
  personId: string;
  name: string;
  email: string;
  avatar: string;
  instanceRole: { id: string; name: string } | null;
  departments: { id: string; name: string; colorToken: string }[];
  /** Solo i progetti che chi guarda vede (R-G5). */
  projects: { code: string; role: string }[];
  status: "active" | "invited" | "deactivated";
  /** Solo per `deactivated`. */
  deactivatedAt: string | null;
  /** Solo per le righe d'invito. */
  invite: { id: string; expiresAt: string; expired: boolean; invitedByName: string } | null;
}

export interface PeopleFilter {
  /** Nome o email, senza distinzione di maiuscole. */
  q?: string;
  departmentIds?: string[];
  instanceRoleIds?: string[];
  statuses?: PersonRow["status"][];
}

export interface PersonProjectView {
  projectId: string;
  code: string;
  name: string;
  role: { id: string; name: string };
  extra: ExtraPermission[];
  /** Chi guarda gestisce i membri di quel progetto. */
  canManage: boolean;
}

/** `null` = si può; altrimenti il motivo per cui la scelta è spenta. */
export type ActionBlock = null | string;

export interface PersonDetail {
  personId: string;
  name: string;
  email: string;
  avatar: string;
  status: "active" | "deactivated";
  deactivatedAt: string | null;
  isSelf: boolean;
  isFullAdmin: boolean;
  hasSecondFactor: boolean;
  /** Chi guarda e la persona sono entrambi full admin: il reset del secondo fattore lo dice. */
  peer: boolean;
  instanceRole: { id: string; name: string } | null;
  projects: PersonProjectView[];
  /** La persona è anche in progetti che chi guarda non vede («Also in projects you can't see.»). */
  alsoInHiddenProjects: boolean;
  departments: { id: string; name: string; colorToken: string; managesHome: boolean }[];
  identities: { gitEmails: string[]; bitbucketUsername: string | null };
  /** Le azioni della pagina: `null` se si possono fare, altrimenti il motivo. */
  actions: {
    setInstanceRole: ActionBlock;
    resetPassword: ActionBlock;
    resetSecondFactor: ActionBlock;
    deactivate: ActionBlock;
    reactivate: ActionBlock;
    identities: ActionBlock;
  };
  /** I ruoli d'istanza con ciò che manca a chi guarda (solo con `users.manage`, altrimenti vuoto). */
  instanceRoleChoices: RoleChoice[];
  /** Le task aperte assegnate, nei progetti visibili: il dialogo di disattivazione. */
  openTasks: {
    taskId: string;
    code: string;
    title: string;
    projectId: string;
    reassignTo: string[];
  }[];
}

export interface InviteView {
  id: string;
  email: string;
  instanceRole: { id: string; name: string } | null;
  /** Solo i progetti che chi guarda vede. */
  projects: { projectId: string; code: string; roleId: string; roleName: string }[];
  invitedById: string;
  invitedByName: string;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
}

/** Le scelte del dialogo «Invite someone», con ciò che manca a chi invita per darle. */
export interface InviteChoices {
  instanceRoles: RoleChoice[];
  /** «User», scelto di base. */
  defaultInstanceRoleId: string;
  /** Solo i progetti dove chi invita gestisce i membri. */
  projects: { projectId: string; code: string; name: string; roles: RoleChoice[] }[];
}

export interface RoleView extends RoleDef {
  /** Persone (ruolo d'istanza) o appartenenze (ruolo di progetto) visibili a chi guarda. */
  peopleCount: number;
  holders: { personId: string; projectId: string | null }[];
  /**
   * Ciò che manca a chi guarda per scrivere questo contenuto dove il ruolo
   * vale (vuoto = si può): l'istanza, o i progetti dove è assegnato o
   * promesso; per un ruolo di progetto non assegnato, almeno un progetto.
   * Il ruolo dato a una persona in un progetto si legge da `roleChoices` di
   * Members.
   */
  missing: string[];
  /**
   * Dove arriva ciò che si aggiunge al ruolo (ruling R-M2): `instance` per un
   * ruolo d'istanza; `projects` per uno di progetto assegnato o promesso (i
   * progetti dove vale); `anywhere` per uno di progetto non assegnato (basta
   * averlo in un progetto). La pagina lo dice in parole, senza nominare
   * progetti che chi guarda non vede.
   */
  reach: GiveReach;
  /** I permessi del livello del ruolo che chi guarda non può AGGIUNGERE, dove il ruolo vale. */
  notGivable: string[];
  /**
   * Ciò che manca a chi guarda per farne una copia («Start from», Duplicate):
   * il ruolo nuovo non vale ancora da nessuna parte, quindi il confronto è
   * quello di `createRole` (l'istanza, o almeno un progetto).
   */
  copyMissing: string[];
  /** Perché non si elimina: `preset`, `in_use` (anche in progetti che chi guarda non vede), o `null`. */
  deleteBlock: null | "preset" | "in_use";
  /** R-E2: il ruolo dà anche «vedere l'attività delle persone» (solo Project Lead). */
  givesActivityView: boolean;
  /** Chi guarda ha questo ruolo (d'istanza, o in almeno un progetto): togliere vale anche per lui. */
  viewerHolds: boolean;
}

/** Dove arriva un permesso dato: vedi `RoleView.reach` e `DepartmentView.reach`. */
export type GiveReach = "instance" | "projects" | "anywhere";

export interface DepartmentView {
  id: string;
  name: string;
  colorToken: string;
  memberIds: string[];
  homeManagerIds: string[];
  projectPermissions: string[];
  /** Le task che hanno il reparto come reparto di pertinenza (l'eliminazione chiede dove spostarle). */
  taskCount: number;
  /**
   * Per ogni persona attiva non ancora nel reparto, i permessi del reparto
   * che chi guarda non ha nei progetti di lei (vuoto = la si può aggiungere).
   */
  missingToAdd: Record<string, string[]>;
  /**
   * Dove arriva un permesso messo nel reparto: `projects` (i progetti dei suoi
   * membri) o `anywhere` (nessun membro in un progetto: basta averlo in uno).
   */
  reach: Exclude<GiveReach, "instance">;
  /** I permessi di progetto che chi guarda non può aggiungere al reparto, dove arriverebbero. */
  notGivable: string[];
}

/** Un autore git osservato nei commit e non ancora collegato (come l'Activity, area 3). */
export interface ObservedAuthor {
  name: string;
  commits: number;
  projectCodes: string[];
  lastAt: string;
}

export type { PermissionSource };
