import type { ProjectPermission } from "@stubwise/shared";

export type PermissionsOf = (projectId: string) => Promise<ReadonlySet<ProjectPermission>>;

/**
 * I permessi di chi guarda per progetto, letti UNA volta entro `ttlMs` (area 3,
 * fetta 3a, review): una per pagina nell'elenco delle sessioni (`ttlMs`
 * infinito, un memo per richiesta), una ogni 30 s nello stream (un memo per
 * stream: i permessi d'istanza si rileggono già a ogni giro con
 * `refreshViewer`, quelli di progetto qui al più con 30 s di ritardo). Le
 * letture concorrenti dello stesso progetto condividono la stessa promessa; una
 * lettura fallita non resta in cache.
 */
export function memoPermissions(
  load: (projectId: string) => Promise<ReadonlySet<ProjectPermission>>,
  ttlMs = Number.POSITIVE_INFINITY,
  now: () => number = Date.now,
): PermissionsOf {
  const cache = new Map<string, { at: number; value: Promise<ReadonlySet<ProjectPermission>> }>();
  return (projectId) => {
    const hit = cache.get(projectId);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const value = load(projectId);
    cache.set(projectId, { at: now(), value });
    value.catch(() => {
      if (cache.get(projectId)?.value === value) cache.delete(projectId);
    });
    return value;
  };
}
