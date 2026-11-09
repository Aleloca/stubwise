import type { Project, ProjectPulse } from "../../data/types";

/** I filtri del portafoglio (shape overview.md §3b): valgono per le tre schede. */
export interface PortfolioFilters {
  kind: "all" | "internal" | "client";
  /** Progetti con almeno una task aperta di questo reparto. */
  departmentId: string | null;
  clientName: string | null;
  pinnedOnly: boolean;
  text: string;
}

export const NO_FILTERS: PortfolioFilters = {
  kind: "all",
  departmentId: null,
  clientName: null,
  pinnedOnly: false,
  text: "",
};

export function hasFilters(f: PortfolioFilters): boolean {
  return (
    f.kind !== "all" || !!f.departmentId || !!f.clientName || f.pinnedOnly || f.text.trim() !== ""
  );
}

/**
 * I progetti che passano i filtri. `departmentProjectIds` sono i progetti
 * con task aperte del reparto scelto (`null` finché non si sa: nessuno passa).
 */
export function filterProjects(
  projects: Project[],
  f: PortfolioFilters,
  pinnedIds: ReadonlySet<string>,
  departmentProjectIds: ReadonlySet<string> | null,
): Project[] {
  const q = f.text.trim().toLowerCase();
  return projects.filter(
    (p) =>
      (f.kind === "all" || p.kind === f.kind) &&
      (!f.clientName || p.clientName === f.clientName) &&
      (!f.pinnedOnly || pinnedIds.has(p.id)) &&
      (!f.departmentId || !!departmentProjectIds?.has(p.id)) &&
      (!q || [p.code, p.name, p.clientName ?? ""].some((x) => x.toLowerCase().includes(q))),
  );
}

/**
 * L'ordine del portafoglio (la decisione del 28 set 2026 sul web): prima i
 * progetti che aspettano chi guarda, poi tutti gli altri; dentro ogni gruppo
 * per nome. La posizione dice solo «aspetta te sì o no»: il resto lo dice la
 * riga di polso.
 */
export function groupPortfolio(
  projects: Project[],
  pulses: ReadonlyMap<string, ProjectPulse>,
  language: string,
): { waiting: Project[]; rest: Project[] } {
  const byName = (a: Project, b: Project) =>
    a.name.localeCompare(b.name, language, { sensitivity: "base" }) ||
    a.code.localeCompare(b.code);
  const sorted = [...projects].sort(byName);
  return {
    waiting: sorted.filter((p) => pulses.get(p.id)?.waitingOnMe),
    rest: sorted.filter((p) => !pulses.get(p.id)?.waitingOnMe),
  };
}
