// Il registro delle modifiche (area 9a): i tipi di voce e le voci. Una voce
// è un FATTO, come il registro decisioni: la frase viene da un template i18n
// (`templateKey`), mai da prosa generata; non si modifica né si cancella; non
// contiene mai un segreto (si scrive «sostituito», non il valore).

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
   * gestisce l'oggetto (`roles.manage` per i ruoli…). Vale per le voci
   * d'istanza; quelle di progetto le legge chi gestisce il progetto
   * (`project.settings.manage` o `project.members.manage`).
   */
  readPermission: string;
  scope: "instance" | "project";
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
}

/** Una voce come la legge il client: i campi calcolati dal livello dati. */
export interface ChangeEntryView extends ChangeEntry {
  templateKey: string;
  scope: "instance" | "project";
  actorName: string;
  /** Il codice del progetto (`ACQ`), `null` per le voci d'istanza. */
  projectCode: string | null;
}

/** I filtri del registro: persona che ha agito, progetto, tipo, periodo (ISO, estremi compresi). */
export interface ChangeFilter {
  personId?: string;
  /** Un progetto; `null` = solo le voci d'istanza. */
  projectId?: string | null;
  kind?: string;
  from?: string;
  to?: string;
}
