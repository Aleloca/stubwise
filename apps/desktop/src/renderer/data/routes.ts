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

/** `route` è nella grammatica: `#/<app>` oppure `#/p/<CODE>(/<sezione>)?`. */
export function isAppRoute(route: string): boolean {
  const m = /^#\/(.+)$/.exec(route);
  if (!m) return false;
  const path = m[1]!;
  if ((APP_ROUTES as readonly string[]).includes(path)) return true;
  const p = /^p\/([A-Z]{2,4})(?:\/([a-z]+))?$/.exec(path);
  if (!p) return false;
  return !p[2] || (PROJECT_SECTIONS_IDS as readonly string[]).includes(p[2]);
}
