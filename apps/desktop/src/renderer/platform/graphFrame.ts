import { isWebAppBuild } from "./vaultBridge";

/**
 * L'HTML interattivo di graphify per un repository (scelta del maintainer,
 * 28 nov 2026, inventario del ritiro §1.5): SOLO nella build web (`/app`),
 * dove il cookie di sessione viaggia da sé sulla stessa origine. Nel Mac il
 * renderer non ha il cookie (le richieste passano dal main col PAT), e resta il
 * grafo delle comunità; nel prototipo pure. `null` = niente iframe.
 *
 * La rotta (`GET /api/repositories/:id/graph/html`) manda la SUA CSP: `sandbox
 * allow-scripts` (origine opaca: niente cookie, storage né accesso alla
 * pagina), script inline e vis-network da unpkg con SRI, `frame-ancestors
 * 'self'`.
 */
export function graphHtmlUrl(repositoryId: string): string | null {
  return isWebAppBuild() ? `/api/repositories/${encodeURIComponent(repositoryId)}/graph/html` : null;
}
