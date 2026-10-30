import { parseCriteria } from "../domain/filters";
import { isSearchParamValue } from "../pages/chat/search";
import { FILE_CODE_RE, isDrivePath, isDriveSearchValue } from "../pages/drive/driveFilters";
// I predicati dell'indirizzo di Posta e Calendario stanno con le loro pagine,
// come quelli di Chat e Drive (precedente dell'area 5): la grammatica delle
// route li riusa senza duplicarli. Eccezione dichiarata alla regola «il
// livello dati non importa le pagine».
import { isMailPath, isMailSearchValue } from "../pages/mail/mailFilters";
import { isCalendarSearchValue } from "../pages/calendar/calendarParams";
import {
  AUTOMATION_SEARCH_KEYS,
  AUTOMATION_VIEWS,
  isAutomationSearchParam,
  isAutomationSourceParam,
  isAutomationsPath,
} from "../pages/automations/automationParams";
import type { GroupBy, ProjectModule, TaskView } from "./types";

/** Grammatica delle route hash dell'app: un'unica fonte, riusata dal router. */
export const APP_ROUTES = [
  "home",
  "chat",
  "mail",
  "calendar",
  "drive",
  "claude",
  "automations",
  "projects",
  "filters",
  "planning",
  "preferences",
  "admin",
] as const;

/**
 * Le sezioni delle Preferenze, nell'ordine della colonna (area 8a: Notifiche;
 * area 9a: le Preferenze personali). `#/preferences/<sezione>`.
 */
export const PREFERENCE_SECTIONS = [
  "notifications",
  "account",
  "security",
  "tokens",
  "claude-code",
  "look",
] as const;

export type PreferenceSection = (typeof PREFERENCE_SECTIONS)[number];

export const isPreferenceSection = (value: string): value is PreferenceSection =>
  (PREFERENCE_SECTIONS as readonly string[]).includes(value);

/** Le sezioni di un progetto, nell'ordine della colonna; `module` = serve quel modulo attivo. */
export const PROJECT_SECTIONS = [
  { id: "overview" },
  { id: "tasks" },
  { id: "planning" },
  { id: "requests" },
  { id: "docs", module: "docs" },
  { id: "drive" },
  { id: "chat" },
  // Le automazioni (area 7): la voce c'è solo se c'è qualcosa o chi guarda può crearne [A 22].
  { id: "automations" },
  { id: "releases", module: "releases" },
  { id: "support", module: "support" },
  { id: "servers", module: "servers" },
  { id: "settings" },
] as const satisfies readonly { id: string; module?: ProjectModule }[];

export type ProjectSection = (typeof PROJECT_SECTIONS)[number]["id"];

export const PROJECT_SECTIONS_IDS: readonly ProjectSection[] = PROJECT_SECTIONS.map((s) => s.id);

export function isProjectSection(value: string): value is ProjectSection {
  return (PROJECT_SECTIONS_IDS as readonly string[]).includes(value);
}

/** Il codice di una task: `<CODE>-<n>`. */
export const TASK_CODE_RE = /^[A-Z]{2,4}-\d+$/;

/**
 * La ricerca (`?…`) valida per route. `task` apre il pannello di dettaglio e
 * vale OVUNQUE; `newTask`/`project`/`newRequest` li scrive la palette (⌘K) e
 * li montano i dialoghi; `request` solo sulle richieste di un progetto; `view`
 * sulla Home (`week`) e, con `group` e `filters` (criteri in JSON), sulle
 * pagine di task (Tasks di progetto, filtro salvato); su All projects `view`
 * (`person`), `date` e `dept` sono la rassegna per persona. Fonte unica: la usa
 * anche il router per validare.
 */
export function isValidSearchParam(path: string, key: string, value: string): boolean {
  // Le Automations: filtri dell'elenco, la riga del registro, la sorgente aperta.
  if ((AUTOMATION_SEARCH_KEYS as readonly string[]).includes(key)) {
    return isAutomationSearchParam(path, key, value);
  }
  switch (key) {
    case "task":
      return TASK_CODE_RE.test(value);
    // Il dettaglio di un file del Drive: vale ovunque, come `task`.
    case "file":
      return FILE_CODE_RE.test(value);
    // Il Drive: ordinamento e filtri; il progetto (`prj`) solo nella destinazione.
    case "source":
      // Il Drive (filtro per provenienza) e le sorgenti delle Automations (il pannello).
      return (
        (isDrivePath(path) && isDriveSearchValue(key, value)) ||
        isAutomationSourceParam(path, value)
      );
    case "sort":
    case "type":
    case "addedBy":
    case "hidden":
      return isDrivePath(path) && isDriveSearchValue(key, value);
    case "prj":
      return path === "drive" && isDriveSearchValue(key, value);
    case "newTask":
      return value === "1";
    // Il codice di un progetto (palette, filtro della Posta); `none` solo nella Posta.
    case "project":
      return /^[A-Z]{2,4}$/.test(value) || (isMailPath(path) && isMailSearchValue(key, value));
    // La Posta: la casella e l'importanza (`project` e `q` sopra e sotto).
    case "mailbox":
    case "importance":
      return isMailPath(path) && isMailSearchValue(key, value);
    // La nuova email nel pannello di lettura (shape mail-compose [A 2]): solo su `#/mail`.
    case "compose":
      return path === "mail" && isMailSearchValue(key, value);
    case "newRequest":
      return value === "1" || /^[A-Z]{2,4}$/.test(value);
    // I dialoghi della Chat (nuovo messaggio diretto, nuovo canale) e le impostazioni di un canale.
    case "newMessage":
      return value === "1";
    case "newChannel":
      return value === "1" || value === "company" || /^[A-Z]{2,4}$/.test(value);
    case "settings":
      return isChannelPath(path) && value === "1";
    case "thread":
    case "message":
      return isChannelPath(path) && /^[\w-]+$/.test(value);
    // La ricerca del Drive (`#/drive?q=…`, `#/p/AUD/drive?q=…`): solo la query.
    case "q":
      if (isDrivePath(path)) return value.length > 0 && value.length <= 200;
      if (isMailPath(path)) return isMailSearchValue(key, value);
      return path === "chat" && isSearchParamValue(key, value);
    // La ricerca della Chat (`#/chat?view=search&q=…`): la query e i filtri.
    case "in":
    case "by":
    case "when":
    case "since":
    case "until":
    case "att":
    case "cit":
    case "ppl":
      return path === "chat" && isSearchParamValue(key, value);
    case "request":
      return /^p\/[A-Z]{2,4}\/requests$/.test(path) && /^[\w-]+$/.test(value);
    case "refine":
      return /^p\/[A-Z]{2,4}\/requests$/.test(path) && value === "1";
    case "brief":
      return /^p\/[A-Z]{2,4}\/overview$/.test(path) && /^[\w-]+$/.test(value);
    // Releases (area 8a): il pannello di una PR aperta.
    case "pr":
      return isReleasesPath(path) && /^[\w-]+$/.test(value);
    // Support (area 8a): il pannello di un widget (l'id, o `new`).
    case "widget":
      return isSupportPath(path) && /^[\w-]+$/.test(value);
    // Il dettaglio di un server (area 8b): intervallo, controllo, parte in vista.
    case "range":
      return isServerPath(path) && /^(1h|24h|7d)$/.test(value);
    case "check":
      return isServerPath(path) && /^[\w-]+$/.test(value);
    case "section":
      return isServerPath(path) && (SERVER_PARTS as readonly string[]).includes(value);
    // Il Calendario: l'evento e la serie aperti nel pannello (shape calendar.md §7).
    case "event":
    case "series":
    // ⌘K «New meeting»: il dialogo si apre all'arrivo sul Calendario.
    case "newMeeting":
      return path === "calendar" && isCalendarSearchValue(key, value);
    case "view":
      if (path === "home") return value === "week";
      if (path === "calendar") return isCalendarSearchValue(key, value);
      // `pinned`: All projects coi soli fissati (Preferenze → Account, «Followed projects»).
      if (path === "projects") return value === "person" || value === "pinned";
      if (path === "chat") return (CHAT_VIEWS as readonly string[]).includes(value);
      if (path === "automations") return (AUTOMATION_VIEWS as readonly string[]).includes(value);
      if (isReleasesPath(path)) return (RELEASES_VIEWS as readonly string[]).includes(value);
      if (isSupportPath(path)) return value === "widgets";
      return isTasksPath(path) && (TASK_VIEWS as readonly string[]).includes(value);
    case "date":
      if (path === "calendar") return isCalendarSearchValue(key, value);
      return path === "projects" && /^\d{4}-\d{2}-\d{2}$/.test(value);
    case "dept":
      return path === "projects" && /^[\w-]+$/.test(value);
    case "group":
      return isTasksPath(path) && (GROUP_BYS as readonly string[]).includes(value);
    case "filters":
      return isTasksPath(path) && parseCriteria(parseJson(value)) !== null;
    case "scope":
      return path === "claude" && (CLAUDE_SCOPES as readonly string[]).includes(value);
    case "ask":
      return path === "claude" && value.trim().length > 0;
    default:
      return false;
  }
}

/** Gli elenchi interi della sezione Releases (`?view=`, shape releases.md [R 3]). */
export const RELEASES_VIEWS = ["prs", "releases", "environments"] as const;

/** La sezione Support di un progetto. */
function isSupportPath(path: string): boolean {
  return /^p\/[A-Z]{2,4}\/support$/.test(path);
}

/** Le parti del dettaglio di un server, per `?section=` (shape servers.md §3). */
export const SERVER_PARTS = [
  "charts",
  "services",
  "disks",
  "checks",
  "access",
  "thresholds",
  "settings",
] as const;

/** Il dettaglio di un server. */
function isServerPath(path: string): boolean {
  return /^p\/[A-Z]{2,4}\/servers\/SRV-\d+$/.test(path);
}

/** La sezione Releases di un progetto. */
function isReleasesPath(path: string): boolean {
  return /^p\/[A-Z]{2,4}\/releases$/.test(path);
}

/** Le viste della colonna della Chat (`#/chat?view=`). */
export const CHAT_VIEWS = ["threads", "mentions", "browse", "search"] as const;

/** Un canale della Chat, nella Chat o nella sezione del progetto. */
function isChannelPath(path: string): boolean {
  return /^chat\/[\w-]+$/.test(path) || /^p\/[A-Z]{2,4}\/chat\/[\w-]+$/.test(path);
}

/** Gli elenchi della destinazione «Claude» (`#/claude?scope=`). */
export const CLAUDE_SCOPES = ["live", "mine", "public", "finished"] as const;
export type ClaudeScope = (typeof CLAUDE_SCOPES)[number];

/** Le viste di un insieme di task (Tasks di progetto e filtri salvati). */
export const TASK_VIEWS = ["list", "board", "timeline"] as const satisfies readonly TaskView[];
export const GROUP_BYS = [
  "none",
  "status",
  "assignee",
  "department",
  "milestone",
  "week",
  // Solo fuori da un progetto (filtri salvati su più progetti).
  "project",
] as const satisfies readonly GroupBy[];

/** Le pagine che mostrano un insieme di task: accettano `view`, `group`, `filters`. */
function isTasksPath(path: string): boolean {
  return /^p\/[A-Z]{2,4}\/tasks$/.test(path) || /^filters\/[\w-]+$/.test(path);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** `route` è nella grammatica: `#/<app>`, `#/filters/<id>` oppure `#/p/<CODE>(/<sezione>)?`, con la ricerca valida. */
export function isAppRoute(route: string): boolean {
  const m = /^#\/([^?]+)(?:\?(.*))?$/.exec(route);
  if (!m) return false;
  const path = m[1]!;
  const query = m[2];
  if (query !== undefined) {
    const params = [...new URLSearchParams(query)];
    if (params.length === 0) return false;
    if (!params.every(([k, v]) => isValidSearchParam(path, k, v))) return false;
  }
  if ((APP_ROUTES as readonly string[]).includes(path)) return true;
  if (/^filters\/[\w-]+$/.test(path)) return true;
  if (/^claude\/[\w-]+$/.test(path)) return true;
  if (/^mail\/[\w-]+$/.test(path)) return true;
  // Le sezioni delle Preferenze (aree 8a e 9a).
  const pref = /^preferences\/([a-z-]+)$/.exec(path);
  if (pref) return isPreferenceSection(pref[1]!);
  if (isChannelPath(path)) return true;
  if (isAutomationsPath(path)) return true;
  // Il dettaglio di un rilascio (area 8a): `#/p/AUD/releases/AUD-V3`.
  if (/^p\/[A-Z]{2,4}\/releases\/[A-Z]{2,4}-V\d+$/.test(path)) return true;
  // Una conversazione di Support (area 8a): `#/p/ACQ/support/ACQ-S2`.
  if (/^p\/[A-Z]{2,4}\/support\/[A-Z]{2,4}-S\d+$/.test(path)) return true;
  // Il dettaglio di un server (area 8b): `#/p/STW/servers/SRV-2` (codice d'istanza).
  if (/^p\/[A-Z]{2,4}\/servers\/SRV-\d+$/.test(path)) return true;
  const p = /^p\/([A-Z]{2,4})(?:\/([a-z]+))?$/.exec(path);
  if (!p) return false;
  return !p[2] || (PROJECT_SECTIONS_IDS as readonly string[]).includes(p[2]);
}

/** L'indirizzo di un'automazione (notifiche, ⌘K): `#/automations/AUD-A1`. */
export const automationHref = (code: string) => `#/automations/${code}`;

/**
 * L'indirizzo di un'esecuzione, «AUD-A1 #2» → `#/automations/AUD-A1/runs/2`;
 * con `entry` (un percorso R-J5) porta alla riga del registro.
 */
export const runHref = (code: string, n: number, entry?: string) =>
  `#/automations/${code}/runs/${n}${entry ? `?entry=${encodeURIComponent(entry)}` : ""}`;
