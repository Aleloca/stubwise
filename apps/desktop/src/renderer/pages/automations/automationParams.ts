// L'indirizzo della destinazione Automations (shape automations.md §6,
// automation-sources.md): la grammatica delle route la riusa senza
// duplicarla, come i predicati di Drive, Posta e Calendario.
//
// - `#/automations` — l'elenco; `?view=runs` le esecuzioni, `?view=attention`
//   «Needs attention»; filtri `project` (codice; esiste già), `general=1`,
//   `status`, `owner`, `automation` (codice), `mine=1`.
// - `#/automations/<CODE>` — un'automazione.
// - `#/automations/<CODE>/runs/<n>` — un'esecuzione; `?entry=<percorso>`
//   porta a una riga del registro (il percorso R-J5 non si mostra mai).
// - `#/automations/sources` — le sorgenti; `?src=<id>` apre il pannello.

/** Le chiavi proprie delle Automations (le altre — `view`, `project` — sono comuni). */
export const AUTOMATION_SEARCH_KEYS = [
  "general",
  "status",
  "owner",
  "automation",
  "mine",
  "entry",
  "src",
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

const PATH_RE = /^automations(?:\/([^/]+)(?:\/runs\/(\d+))?)?$/;

/** `automations`, `automations/<CODE>`, `automations/<CODE>/runs/<n>` o `automations/sources`. */
export function isAutomationsPath(path: string): boolean {
  const m = PATH_RE.exec(path);
  if (!m) return false;
  if (m[1] === undefined) return true;
  if (m[1] === "sources") return m[2] === undefined;
  return AUTOMATION_CODE_RE.test(m[1]);
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
    case "src":
      return /^[\w-]+$/.test(value);
    default:
      return false;
  }
}

/** La chiave vale su questo percorso: i filtri sull'elenco, `entry` su un'esecuzione, `src` sulle sorgenti. */
export function isAutomationSearchParam(path: string, key: string, value: string): boolean {
  if (!isAutomationSearchValue(key, value)) return false;
  if (key === "entry") return isRunPath(path);
  if (key === "src") return path === "automations/sources";
  return path === "automations";
}
