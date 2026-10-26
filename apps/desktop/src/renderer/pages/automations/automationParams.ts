// L'indirizzo della destinazione Automations (shape automations.md §6,
// automation-sources.md): la grammatica delle route la riusa senza
// duplicarla, come i predicati di Drive, Posta e Calendario.
//
// - `#/automations` — l'elenco; `?view=runs` le esecuzioni, `?view=attention`
//   «Needs attention»; filtri `project` (codice; esiste già), `general=1`,
//   `status`, `owner`, `automation` (codice), `mine=1`.
// - `#/automations/<CODE>` — un'automazione; `?problems=1` porta alla
//   sezione Problems; `/edit` e `/test` il costruttore e la prova.
// - `#/automations/<CODE>/edit?step=<percorso | id>` — il costruttore col
//   passo (o `trigger`, l'inizio) selezionato: «Fix», «Step 27»; `from=list`
//   quando ci si arriva dall'elenco («← Automations»).
// - `#/automations/<CODE>/runs/<n>` — un'esecuzione; `?entry=<percorso>`
//   porta a una riga del registro (il percorso R-J5 non si mostra mai).
// - `#/automations/sources` — le sorgenti; `?source=<id>` apre il pannello
//   (la chiave è la stessa del Drive: vale qui con un id di sorgente).

/** Le chiavi proprie delle Automations (le altre — `view`, `project` — sono comuni). */
export const AUTOMATION_SEARCH_KEYS = [
  "general",
  "status",
  "owner",
  "automation",
  "mine",
  "entry",
  "problems",
  "step",
  "from",
] as const;

export type AutomationSearchKey = (typeof AUTOMATION_SEARCH_KEYS)[number];

/** Le viste dell'elenco (`?view=`): senza parametro, tutte le automazioni. */
export const AUTOMATION_VIEWS = ["runs", "attention"] as const;

/** I filtri di stato: dell'automazione nell'elenco, dell'esecuzione nella vista esecuzioni. */
export const AUTOMATION_STATUS_FILTERS = ["active", "paused", "draft", "problems"] as const;
export const RUN_STATUS_FILTERS = [
  "running",
  "waiting",
  "suspended",
  "failed",
  "finished",
] as const;

export const AUTOMATION_CODE_RE = /^(?:[A-Z]{2,4}-A\d+|AUT-\d+)$/;

const PATH_RE = /^automations(?:\/([^/]+)(\/runs\/\d+|\/edit|\/test)?)?$/;

/**
 * `automations`, `automations/<CODE>` (con `/runs/<n>`, `/edit`, `/test`) o
 * `automations/sources`.
 */
export function isAutomationsPath(path: string): boolean {
  const m = PATH_RE.exec(path);
  if (!m) return false;
  if (m[1] === undefined) return true;
  if (m[1] === "sources") return m[2] === undefined;
  return AUTOMATION_CODE_RE.test(m[1]);
}

const isAutomationDetailPath = (path: string) =>
  /^automations\/[^/]+$/.test(path) && path !== "automations/sources";

/** `?source=<id>` sulla pagina delle sorgenti (la chiave `source` è anche del Drive). */
export function isAutomationSourceParam(path: string, value: string): boolean {
  return path === "automations/sources" && /^[\w-]+$/.test(value);
}

const isRunPath = (path: string) => /^automations\/[^/]+\/runs\/\d+$/.test(path);

/** Il valore di una chiave delle Automations, a prescindere dal percorso (forma). */
export function isAutomationSearchValue(key: string, value: string): boolean {
  switch (key) {
    case "general":
    case "mine":
      return value === "1";
    case "status":
      return (
        (AUTOMATION_STATUS_FILTERS as readonly string[]).includes(value) ||
        (RUN_STATUS_FILTERS as readonly string[]).includes(value)
      );
    case "owner":
      return /^p-[\w-]+$/.test(value);
    case "automation":
      return AUTOMATION_CODE_RE.test(value);
    case "entry":
      return value.length > 0 && value.length <= 400;
    case "problems":
      return value === "1";
    case "step":
      // Il percorso (R-J5) o l'id del passo (da «Fix»).
      return (
        value === "trigger" ||
        /^\d+(\/[^/]{1,80})*$/.test(value) ||
        /^[A-Za-z][\w-]{0,80}$/.test(value)
      );
    case "from":
      return value === "list";
    default:
      return false;
  }
}

/** La chiave vale su questo percorso: i filtri sull'elenco, `entry` su un'esecuzione, `problems` su un'automazione. */
export function isAutomationSearchParam(path: string, key: string, value: string): boolean {
  if (!isAutomationSearchValue(key, value)) return false;
  if (key === "entry") return isRunPath(path);
  if (key === "problems") return isAutomationDetailPath(path);
  if (key === "step" || key === "from") return /^automations\/[^/]+\/edit$/.test(path);
  return path === "automations";
}
