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

/** La fetta 1. Una fetta nuova aggiunge qui le sue voci. */
const INTEGRATED: Record<IntegrationTarget["kind"], ReadonlySet<string>> = {
  destination: new Set(["projects"]),
  projectSection: new Set(["tasks"]),
  // Stati e soglie del progetto.
  projectSettings: new Set(["statuses"]),
  admin: new Set(["departments"]),
  taskView: new Set(["list", "board"]),
  feature: new Set(["notifications", "search", "task-detail", "new-task"]),
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
 * Il bersaglio di un indirizzo dell'app (la pagina nell'area di lavoro), con
 * la chiave del suo titolo; `null` per un indirizzo che si risolve da solo
 * (l'indice di un progetto o dell'amministrazione, che reindirizzano).
 */
export function integrationTargetOf(
  pathname: string,
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
  return { target: { kind: "destination", name: first }, titleKey: `nav.${first}` };
}
