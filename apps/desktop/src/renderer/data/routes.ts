import type { ProjectModule } from "./types";

/** Grammatica delle route hash dell'app: un'unica fonte, riusata dal router. */
export const APP_ROUTES = [
  "home",
  "chat",
  "mail",
  "calendar",
  "claude",
  "automations",
  "projects",
  "filters",
  "planning",
  "preferences",
  "admin",
] as const;

/** Le sezioni di un progetto, nell'ordine della colonna; `module` = serve quel modulo attivo. */
export const PROJECT_SECTIONS = [
  { id: "overview" },
  { id: "tasks" },
  { id: "planning" },
  { id: "requests" },
  { id: "docs", module: "docs" },
  { id: "drive" },
  { id: "chat" },
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
 * li montano i dialoghi; `request` solo sulle richieste di un progetto, `view`
 * solo sulla Home. Fonte unica: la usa anche il router per validare.
 */
export function isValidSearchParam(path: string, key: string, value: string): boolean {
  switch (key) {
    case "task":
      return TASK_CODE_RE.test(value);
    case "newTask":
      return value === "1";
    case "project":
      return /^[A-Z]{2,4}$/.test(value);
    case "newRequest":
      return value === "1" || /^[A-Z]{2,4}$/.test(value);
    case "request":
      return /^p\/[A-Z]{2,4}\/requests$/.test(path) && /^[\w-]+$/.test(value);
    case "view":
      return path === "home" && value === "week";
    default:
      return false;
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
  const p = /^p\/([A-Z]{2,4})(?:\/([a-z]+))?$/.exec(path);
  if (!p) return false;
  return !p[2] || (PROJECT_SECTIONS_IDS as readonly string[]).includes(p[2]);
}
