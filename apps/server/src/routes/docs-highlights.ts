/**
 * Schemi condivisi delle "highlights" dei Docs: i dati che alimentano le home
 * orientanti (overview di repo e home di progetto). Vivono a parte perché sono
 * usati sia dalle route per-repository ({@link ./docs.ts}) sia da quelle
 * aggregate di progetto ({@link ./project-docs.ts}), con lo stesso contratto.
 */

import { docPageKindSchema, type DocPageKind } from "@stubwise/shared";
import { z } from "zod";

/** Riferimento leggero a una pagina in una lista di highlights. */
export const highlightRefSchema = z.object({
  slug: z.string(),
  title: z.string(),
  kind: docPageKindSchema,
  viewCount: z.number().int(),
});

/**
 * Riferimento a una release nel changelog: `createdAt` è la data della entry
 * (le release sono pagine persistenti create al push), `significant` la
 * significatività calcolata dal worker (null per le release pre-migrazione).
 * `commitSha` è quello della generazione di appartenenza: per le release, che
 * sono persistenti (generationId null), è sempre null — il commit si legge
 * dallo slug `release-YYYYMMDD-HHmm-<sha>`.
 */
export const releaseRefSchema = z.object({
  slug: z.string(),
  title: z.string(),
  createdAt: z.string(),
  significant: z.boolean().nullable(),
  commitSha: z.string().nullable(),
});

/** Tutti i kind, con conteggio: chiavi sempre presenti (0 se nessuna pagina). */
export const countsByKindSchema = z.object({
  technical: z.number().int(),
  functional: z.number().int(),
  product: z.number().int(),
  manual: z.number().int(),
  releases: z.number().int(),
});

/** Conteggi a zero per tutti i kind: base da riempire con il GROUP BY. */
export function emptyCountsByKind(): Record<DocPageKind, number> {
  return { technical: 0, functional: 0, product: 0, manual: 0, releases: 0 };
}

/** Highlights di un singolo repository (overview di repo). */
export const repoHighlightsSchema = z.object({
  countsByKind: countsByKindSchema,
  topViewed: z.array(highlightRefSchema),
  recentlyUpdated: z.array(highlightRefSchema),
  latestReleases: z.array(releaseRefSchema),
});

/** Come {@link highlightRefSchema}, arricchito col repository d'origine. */
export const projectHighlightRefSchema = highlightRefSchema.extend({
  repositoryId: z.uuid(),
  repositorySlug: z.string(),
  repositoryName: z.string(),
});

/** Come {@link releaseRefSchema}, arricchito col repository d'origine. */
export const projectReleaseRefSchema = releaseRefSchema.extend({
  repositoryId: z.uuid(),
  repositorySlug: z.string(),
  repositoryName: z.string(),
});

/** Highlights aggregate di progetto (changelog cross-repo + pagine top). */
export const projectHighlightsSchema = z.object({
  countsByKind: countsByKindSchema,
  topViewed: z.array(projectHighlightRefSchema),
  latestReleases: z.array(projectReleaseRefSchema),
});

/** Quante voci al massimo per lista, per scope. */
export const HIGHLIGHT_LIMITS = {
  repoTopViewed: 6,
  repoRecentlyUpdated: 6,
  repoReleases: 5,
  projectTopViewed: 8,
  projectReleases: 10,
} as const;
