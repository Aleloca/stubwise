import { isAppBuild } from "./build";

/**
 * Cosa è integrato col server vero in questa build (integrazione area 2,
 * fetta 1: `docs/plans/2026-11-09-integrazione-area2-task-design.md`, «Le
 * aree non ancora integrate»). Nel prototipo tutto; nella build app solo
 * l'ossatura e le Tasks. Il resto resta nella navigazione con lo stato
 * neutro «in arrivo», senza dati: nessuna sua lettura parte.
 */
export type IntegrationTarget =
  | { kind: "destination"; name: string }
  | { kind: "projectSection"; name: string }
  | { kind: "projectSettings"; name: string }
  | { kind: "admin"; name: string }
  | { kind: "taskView"; name: string }
  | { kind: "feature"; name: string };

/**
 * Le fette integrate. Una fetta nuova aggiunge qui le sue voci. Fetta 2
 * (`docs/plans/2026-11-09-integrazione-area2-fetta2-design.md`): il Planning
 * (trasversale e di progetto), La mia settimana (`/home?view=week`, la
 * funzione `my-week`: la Home a blocchi resta «in arrivo»), la Timeline e la
 * settimana pianificata (`planning-week`).
 */
const INTEGRATED: Record<IntegrationTarget["kind"], ReadonlySet<string>> = {
  destination: new Set(["projects", "planning"]),
  projectSection: new Set(["tasks", "planning"]),
  // Stati e soglie del progetto.
  projectSettings: new Set(["statuses"]),
  admin: new Set(["departments"]),
  taskView: new Set(["list", "board", "timeline"]),
  feature: new Set(["notifications", "search", "task-detail", "new-task", "planning-week", "my-week"]),
};

export function isIntegrated(target: IntegrationTarget): boolean {
  if (!isAppBuild()) return true;
  return INTEGRATED[target.kind].has(target.name);
}

/** Scorciatoia per una funzione trasversale (`feature`). */
export function featureIntegrated(name: string): boolean {
  return isIntegrated({ kind: "feature", name });
}

/**
 * Dove si atterra entrando (login, primo avvio, invito, indirizzo vuoto): la
 * Home, o La mia settimana dove la Home a blocchi non è ancora integrata.
 */
export function landingSearch(): { view?: "week" } {
  return isIntegrated({ kind: "destination", name: "home" }) ? {} : { view: "week" };
}

/**
 * Il bersaglio di un indirizzo dell'app (la pagina nell'area di lavoro), con
 * la chiave del suo titolo; `null` per un indirizzo che si risolve da solo
 * (l'indice di un progetto o dell'amministrazione, che reindirizzano). La
 * query conta per `/home`: `?view=week` è La mia settimana, non la Home.
 */
export function integrationTargetOf(
  pathname: string,
  search: { view?: unknown } = {},
): { target: IntegrationTarget; titleKey: string } | null {
  const parts = pathname.split("/").filter(Boolean);
  const [first, second, third] = parts;
  if (!first) return null;
  if (first === "p") {
    if (!third) return null;
    if (third === "settings") {
      const name = parts[3];
      if (!name) return null;
      return { target: { kind: "projectSettings", name }, titleKey: `settings.sections.${name}` };
    }
    return { target: { kind: "projectSection", name: third }, titleKey: `project.sections.${third}` };
  }
  if (first === "admin") {
    if (!second) return null;
    return { target: { kind: "admin", name: second }, titleKey: `admin.sections.${second}` };
  }
  // La pagina di un archiviato vive con All projects, ma è dell'archivio (area 9c).
  if (first === "archived") return { target: { kind: "feature", name: "archive" }, titleKey: "nav.projects" };
  if (first === "projects") {
    // «Tutti i progetti» (il portafoglio) è della fetta 4; la colonna resta.
    return { target: { kind: "feature", name: "portfolio" }, titleKey: "nav.projects" };
  }
  if (first === "home" && search.view === "week") {
    return { target: { kind: "feature", name: "my-week" }, titleKey: "column.subviews.home.week" };
  }
  return { target: { kind: "destination", name: first }, titleKey: `nav.${first}` };
}
