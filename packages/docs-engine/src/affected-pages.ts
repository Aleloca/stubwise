/**
 * AFFECTED PAGES — mappa i file cambiati alle pagine di documentazione esistenti
 * (auto-aggiornamento Docs, Fase 2: rigenerazione MIRATA delle sole pagine toccate).
 *
 * Logica PURA e deterministica (niente fs/rete/db): il chiamante (worker) passa l'elenco
 * dei file cambiati nel range e l'elenco delle pagine esistenti (con il loro `sourcePath`);
 * questo modulo decide QUALI pagine rigenerare e quali file NON sono coperti da alcuna
 * pagina (aree "nuove", candidate a nuove pagine in un passo successivo).
 *
 * ── REGOLA "COPERTURA" ─────────────────────────────────────────────────────────────────
 * Una pagina con `sourcePath` S "copre" un file F quando S COPRE F nel senso di
 * `pathCovers` (vedi `recursive/dag.ts`): match PER SEGMENTO, non per prefisso di stringa
 * (`src/au` NON copre `src/auth/x.ts`). Le pagine con `sourcePath` null (overview/manuali)
 * non coprono nulla via path: entrano in `affected` SOLO come genitore-overview di una
 * pagina primaria impattata.
 *
 * ── COSA RIGENERARE ────────────────────────────────────────────────────────────────────
 * Per ogni file cambiato si sceglie la pagina PIÙ SPECIFICA che lo copre (il `sourcePath`
 * con più segmenti). L'insieme `affected` è l'unione, su tutti i file coperti, di
 * { pagina più specifica } ∪ { suo genitore via `parentId`, se presente tra le pagine }
 * (un solo livello, per tenere coerente l'overview). Un TETTO `maxPages` limita quante
 * pagine rigenerare, dando priorità ai match più profondi (le primarie prima dei genitori).
 */

import { pathCovers } from "./recursive/dag.js";

/** Riferimento minimale a una pagina di documentazione esistente. */
export interface PageRef {
  id: string;
  slug: string;
  title: string;
  /** Path del sorgente documentato (modulo/file); null per overview/manuali. */
  sourcePath: string | null;
  /** Id della pagina-genitore (overview), se annidata; null se radice. */
  parentId: string | null;
}

/** Esito del mapping file cambiati → pagine impattate. */
export interface AffectedPagesResult {
  /** Pagine da rigenerare (entro il tetto `maxPages`), priorità ai match più profondi. */
  affected: PageRef[];
  /** File cambiati non coperti da ALCUNA pagina (aree nuove). Dedup, ordine stabile. */
  newAreas: string[];
  /** Quante pagine impattate sono state scartate per rispettare il tetto. */
  truncated: number;
}

/** Numero di segmenti di un path normalizzato: misura la SPECIFICITÀ del `sourcePath`. */
function segmentCount(path: string): number {
  const trimmed = path.trim().replace(/^\/+|\/+$/g, "");
  if (trimmed === "") return 0;
  return trimmed.split("/").length;
}

/** Una pagina selezionata + la profondità del match che l'ha selezionata (per il tetto). */
interface Selected {
  page: PageRef;
  /** Profondità del match: # segmenti del `sourcePath` primario; 0 per i genitori-overview. */
  depth: number;
}

/**
 * Mappa i `changedFiles` alle `pages` esistenti. Funzione PURA: vedi il doc-header per la
 * regola di copertura (per segmento) e la scelta della pagina più specifica.
 *
 * - `affected`: pagine da rigenerare (più specifica per ogni file coperto + il suo genitore
 *   via `parentId`), dedup per `id`, ordinate per priorità (match più profondo/esatto prima)
 *   e tagliate a `maxPages`.
 * - `newAreas`: file non coperti da alcuna pagina (dedup, ordine stabile).
 * - `truncated`: pagine impattate scartate per il tetto.
 *
 * Se `maxPages <= 0` la rigenerazione è disabilitata: `affected = []`, `truncated = 0`
 * (ma `newAreas` resta calcolato, non è soggetto al tetto).
 */
export function mapAffectedPages(
  changedFiles: string[],
  pages: PageRef[],
  maxPages: number,
): AffectedPagesResult {
  // Solo le pagine con un sourcePath possono coprire un file via path.
  const coveringPages = pages.filter((p) => p.sourcePath !== null);
  const byId = new Map(pages.map((p) => [p.id, p]));

  // Per ogni id selezionato, teniamo la profondità di match MASSIMA vista (più è profondo,
  // più alta la priorità nel tetto). I genitori-overview hanno depth 0.
  const selected = new Map<string, Selected>();
  const newAreasSet = new Set<string>();

  const promote = (page: PageRef, depth: number): void => {
    const prev = selected.get(page.id);
    if (prev === undefined || depth > prev.depth) {
      selected.set(page.id, { page, depth });
    }
  };

  for (const rawFile of changedFiles) {
    const file = rawFile.trim().replace(/^\/+/, "");
    if (file === "") continue;

    // Pagina più specifica che copre il file = sourcePath con più segmenti.
    let best: PageRef | null = null;
    let bestDepth = -1;
    for (const page of coveringPages) {
      // sourcePath è non-null per costruzione (coveringPages).
      if (!pathCovers(page.sourcePath as string, file)) continue;
      const depth = segmentCount(page.sourcePath as string);
      if (depth > bestDepth) {
        best = page;
        bestDepth = depth;
      }
    }

    if (best === null) {
      // Nessuna pagina copre il file → area nuova.
      newAreasSet.add(file);
      continue;
    }

    // La pagina primaria impattata + (un solo livello) il suo genitore-overview.
    promote(best, bestDepth);
    if (best.parentId !== null) {
      const parent = byId.get(best.parentId);
      if (parent !== undefined) promote(parent, 0);
    }
  }

  const newAreas = [...newAreasSet].sort();

  // Tetto disabilitato/azzerato: nessuna rigenerazione (ma newAreas resta).
  if (maxPages <= 0) {
    return { affected: [], newAreas, truncated: 0 };
  }

  // Priorità: match più profondo prima (le primarie più specifiche prima dei genitori); a
  // parità di profondità, ordine stabile per slug (deterministico).
  const ordered = [...selected.values()].sort((a, b) => {
    if (b.depth !== a.depth) return b.depth - a.depth;
    return a.page.slug.localeCompare(b.page.slug);
  });

  const affected = ordered.slice(0, maxPages).map((s) => s.page);
  const truncated = Math.max(0, ordered.length - maxPages);

  return { affected, newAreas, truncated };
}
