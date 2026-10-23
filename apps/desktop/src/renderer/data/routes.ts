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

export const PROJECT_SECTIONS_IDS = [
  "overview",
  "tasks",
  "planning",
  "requests",
  "docs",
  "drive",
  "chat",
  "releases",
  "support",
  "servers",
  "settings",
] as const;

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
