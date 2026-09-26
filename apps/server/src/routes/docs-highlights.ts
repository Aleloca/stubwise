/**
 * Logica lato server delle "highlights" dei Docs: i dati che alimentano le home
 * orientanti (overview di repo e home di progetto), usati sia dalle route
 * per-repository ({@link ./docs.ts}) sia da quelle aggregate di progetto
 * ({@link ./project-docs.ts}).
 *
 * Gli SCHEMI delle risposte vivono in `@stubwise/shared` (`schemas/docs.ts`)
 * dal 25 set 2026: li legge anche l'app, e una copia scritta qui divergerebbe.
 * Qui resta solo ciò che serve a COSTRUIRE le risposte.
 */

import type { DocPageKind } from "@stubwise/shared";

/** Conteggi a zero per tutti i kind: base da riempire con il GROUP BY. */
export function emptyCountsByKind(): Record<DocPageKind, number> {
  return { technical: 0, functional: 0, product: 0, manual: 0, releases: 0 };
}

/** Quante voci al massimo per lista, per scope. */
export const HIGHLIGHT_LIMITS = {
  repoTopViewed: 6,
  repoRecentlyUpdated: 6,
  repoReleases: 5,
  projectTopViewed: 8,
  projectReleases: 10,
  projectDecisions: 5,
} as const;
