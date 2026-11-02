// Il registro delle modifiche (area 9a): i tipi di voce e le voci. Una voce
// è un FATTO, come il registro decisioni: la frase viene da un template i18n
// (`templateKey`), mai da prosa generata; non si modifica né si cancella; non
// contiene mai un segreto (si scrive «sostituito», non il valore).

import type { AdminSection, ProjectSettingsSection } from "../routes";
import type { SettingValue } from "./settingValues";

/**
 * Un tipo di voce. Lo registrano le aree che scrivono (9a, 9b, 9c) con
 * `registerChangeTypes`: una voce di un tipo non registrato non si scrive.
 */
export interface ChangeType {
  /** Es. `role.updated`, `member.permission_granted`. */
  kind: string;
  /** La chiave i18n della frase. */
  templateKey: string;
  /**
   * Chi legge la voce oltre a chi ha `changelog.view`: il permesso che
   * gestisce l'oggetto (`roles.manage` per i ruoli…). Per una voce di
   * progetto vale in quel progetto, e solo se il progetto è visibile; lì la
   * legge anche chi gestisce il progetto (`project.settings.manage` o
   * `project.members.manage`).
   */
  readPermission: string;
  scope: "instance" | "project";
  /**
   * Il gruppo del filtro «Type» del registro (`changelog.groups.<group>`):
   * 9a ha people, invites, roles, members, departments, security; 9b e 9c
   * aggiungono i loro.
   */
  group: string;
}

/** L'oggetto di cui parla una voce; `label` è il nome di allora (resta anche se l'oggetto sparisce). */
export interface ChangeObject {
  type: string;
  id: string;
  label: string;
}

/** Quello che una scrittura passa a `recordChange`. */
export interface ChangeInput {
  kind: string;
  actorId: string;
  /** `null` per le voci d'istanza. */
  projectId: string | null;
  object: ChangeObject;
  before?: string | null;
  after?: string | null;
  /** I valori della frase del template (nomi, permessi in chiave). */
  params?: Record<string, string>;
}

/** Una voce salvata (congelata). */
export interface ChangeEntry {
  id: string;
  kind: string;
  at: string;
  actorId: string;
  projectId: string | null;
  object: ChangeObject;
  before: string | null;
  after: string | null;
  params: Record<string, string>;
  /**
   * Area 10a: la voce l'ha scritta Claude per `actorId` (che resta la
   * persona). Un valore stabile: la frase «Claude on behalf of …» la
   * compone la pagina. Assente sulle voci a mano e su quelle nate prima.
   */
  via?: "claude";
  /** Area 10a: l'azione di Claude che l'ha scritta (resta nel livello dati). */
  claudeActionId?: string;
  /** Area 10a: dentro un «Annulla», la voce dell'azione annullata sullo stesso oggetto. */
  undoOf?: string;
  /**
   * Area 10a: `nextSeq()` alla scrittura. Il «com'era» di «Annulla» ordina
   * con questo, non con `at` (l'orologio è fermo, P4). Resta nel livello dati.
   */
  seq?: number;
}

/**
 * Dove porta l'oggetto di una voce, se esiste ancora e chi guarda può
 * aprirlo: la pagina della persona, del ruolo, dell'invito, il pannello del
 * reparto o del membro; dal 9b una voce dell'Amministrazione (con l'id
 * dell'oggetto dentro la voce, se ne ha uno) o un server; dal 9c la sezione
 * di Progetto → Settings in cui sta l'oggetto (con `repo`, la pagina del
 * repository) o, per un archiviato, la sua pagina (`/archived/<CODE>`).
 */
export type ChangeObjectLink =
  | { to: "person"; personId: string }
  | { to: "role"; roleId: string }
  | { to: "invite"; inviteId: string }
  | { to: "department"; departmentId: string }
  | { to: "member"; projectCode: string; personId: string }
  | { to: "admin"; section: AdminSection; id?: string }
  | { to: "server"; code: string }
  | { to: "projectSettings"; code: string; section: ProjectSettingsSection; repo?: string }
  | { to: "archived"; code: string };

/**
 * Il prima e dopo di una voce, già pronto da leggere ([AU 2]):
 * - `values`: due valori («Developer → Release manager»), uno dei due può
 *   mancare (un nome nato, un'identità tolta);
 * - `permissions`: permessi aggiunti e tolti (chiavi, le parole le mette la
 *   UI da `permissions.<k>.label`), più gli insiemi interi di prima e dopo
 *   quando la voce li ha (allora c'è «Show details»); `role` è il ruolo del
 *   membro quando la voce lo sa («Developer → Developer + …»);
 * - `people`: persone entrate e uscite, per nome; quelle che chi guarda non
 *   vede non ci sono, né per nome né contate (R-G5).
 */
export type ChangeDiff =
  | { kind: "values"; before: string | null; after: string | null }
  | {
      kind: "permissions";
      added: string[];
      removed: string[];
      role: string | null;
      before: string[] | null;
      after: string[] | null;
    }
  | { kind: "people"; added: string[]; removed: string[] }
  /**
   * Una voce d'impostazione del 9b (Ruling T3): i valori stabili salvati,
   * in forma di dato; le parole le mette la pagina (`settingValues.ts`).
   */
  | { kind: "setting"; before: SettingValue | null; after: SettingValue | null };

/**
 * Una voce come la legge il client: i campi calcolati dal livello dati.
 * `claudeActionId` e `seq` non escono (ruling del controller (pre-flight),
 * P16), e `undoOf` si calcola per chi guarda.
 */
export interface ChangeEntryView extends Omit<ChangeEntry, "undoOf" | "claudeActionId" | "seq"> {
  /**
   * La voce annullata da questa, solo se chi guarda legge anche quella;
   * altrimenti `null` (anche sulle voci che non annullano niente).
   */
  undoOf: string | null;
  templateKey: string;
  scope: "instance" | "project";
  group: string;
  actorName: string;
  /** Il codice del progetto (`ACQ`), `null` per le voci d'istanza. */
  projectCode: string | null;
  /** L'oggetto non c'è più (un ruolo o un reparto eliminato): il nome resta, «(deleted)». */
  objectDeleted: boolean;
  objectLink: ChangeObjectLink | null;
  /**
   * La chiave i18n del nome dell'oggetto, quando il nome è una parola di
   * Stubwise e non un nome dato da una persona (l'operazione di
   * `model.changed`): la pagina lo traduce invece di mostrare `label`.
   */
  objectLabelKey?: string | null;
  /** La seconda riga della voce, `null` se la voce non ne ha (mai su un segreto). */
  diff: ChangeDiff | null;
}

/**
 * Le scelte dei filtri del registro, per chi guarda (R-G5: solo persone e
 * progetti visibili; solo i gruppi di voci che legge). `everything` = ha
 * `changelog.view` (la riga in prosa dice altrimenti cosa vede).
 */
export interface ChangeFilterChoices {
  everything: boolean;
  people: { personId: string; name: string }[];
  /**
   * `archived`: un archiviato di cui chi guarda era membro (o è full admin)
   * e legge le voci; la pagina lo dice «(archived)» (ruling del controller
   * (pre-flight), P21). Assente sugli attivi.
   */
  projects: { projectId: string; code: string; name: string; archived?: boolean }[];
  groups: string[];
  /** Area 10a: chi guarda legge almeno una voce scritta da Claude (il filtro «By Claude»). */
  claude: boolean;
}

/** I filtri del registro: persona che ha agito, progetto, tipo, periodo (ISO, estremi compresi). */
export interface ChangeFilter {
  personId?: string;
  /** Un progetto; `null` = solo le voci d'istanza. */
  projectId?: string | null;
  kind?: string;
  /** Un gruppo di tipi (il filtro «Type» della pagina). */
  group?: string;
  /** Gli ultimi N giorni, contati dall'«adesso» del prototipo. */
  withinDays?: number;
  from?: string;
  to?: string;
  /** Area 10a: solo le voci scritte da Claude per qualcuno. */
  via?: "claude";
}
