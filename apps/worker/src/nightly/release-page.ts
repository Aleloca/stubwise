import { docPages, type Db } from "@stubwise/db";
import type { ExistingPage } from "@stubwise/docs-engine";
import { and, eq, isNull } from "drizzle-orm";

/**
 * Pezzi della pagina `releases` condivisi fra l'auto-update (finché esiste, lo
 * rimuove il Task B11) e la nota di rilascio del giro notturno (Task B6).
 * Spostati IMMUTATI da `docs/auto-update.ts`, più {@link appendRelatedLinks}
 * che completa i link «related» a fine fase 4 (Task B7).
 */

/** Sha breve (7 char) per lo slug della release; tollera sha più corti. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** Timestamp `YYYYMMDD-HHmm` (UTC) per lo slug della release. */
export function timestampForSlug(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return (
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `-${p(now.getUTCHours())}${p(now.getUTCMinutes())}`
  );
}

/**
 * Costruisce uno slug univoco per la release: `release-<YYYYMMDD-HHmm>-<shortSha>`. Se
 * collide con una pagina release già esistente (stesso minuto + stesso sha breve) appende
 * un suffisso numerico. Lo slug è univoco tra le pagine PERSISTENTI (generation_id null)
 * del repository (vincolo parziale doc_pages_manual_slug_unique).
 */
export async function uniqueReleaseSlug(
  db: Db,
  repositoryId: string,
  toSha: string,
  now: Date,
): Promise<string> {
  const base = `release-${timestampForSlug(now)}-${shortSha(toSha)}`;
  let slug = base;
  let suffix = 1;
  // Loop limitato: in pratica al massimo una/due iterazioni (collisione = doppio push
  // nello stesso minuto sullo stesso sha breve, raro).
  for (let i = 0; i < 100; i++) {
    const [existing] = await db
      .select({ id: docPages.id })
      .from(docPages)
      .where(
        and(
          eq(docPages.repositoryId, repositoryId),
          eq(docPages.slug, slug),
          isNull(docPages.generationId),
        ),
      );
    if (!existing) return slug;
    slug = `${base}-${suffix}`;
    suffix += 1;
  }
  // Fallback estremo: aggiungi un componente casuale (non dovrebbe mai servire).
  return `${base}-${Math.random().toString(36).slice(2, 8)}`;
}

export type RelatedLink = { type: "related"; slug: string; title: string };

/**
 * Risolve gli `affectedSlugs` dell'agente in cross-link "related": tiene solo gli slug
 * che ESISTONO tra le pagine esistenti (scarta quelli inventati), risolve il titolo e
 * deduplica. Formato del campo `links` (jsonb): array `{ type, slug, title }`.
 */
export function buildRelatedLinks(
  affectedSlugs: string[],
  existingPages: ExistingPage[],
): RelatedLink[] {
  const bySlug = new Map(existingPages.map((p) => [p.slug, p.title]));
  const seen = new Set<string>();
  const links: RelatedLink[] = [];
  for (const slug of affectedSlugs) {
    const title = bySlug.get(slug);
    if (title === undefined || seen.has(slug)) continue;
    seen.add(slug);
    links.push({ type: "related", slug, title });
  }
  return links;
}

/**
 * Completa i link «related» di una pagina `releases` con le pagine aggiornate o
 * create dalla fase 4 (la nota notturna si scrive PRIMA delle pagine, quindi al
 * suo inserimento conosce solo gli `affectedSlugs` dell'agente). Unione
 * deduplicata per slug, nell'ordine: link già presenti, poi i nuovi. Un UPDATE
 * solo, e nessuna scrittura se non c'è niente di nuovo o la pagina è sparita.
 * Restituisce quanti link ha aggiunto.
 */
export async function appendRelatedLinks(
  db: Db,
  pageId: string,
  pages: { slug: string; title: string }[],
): Promise<number> {
  const [page] = await db
    .select({ links: docPages.links })
    .from(docPages)
    .where(and(eq(docPages.id, pageId), eq(docPages.kind, "releases")));
  if (!page) return 0;
  const current = Array.isArray(page.links) ? (page.links as RelatedLink[]) : [];
  const seen = new Set(current.map((l) => l.slug));
  const added: RelatedLink[] = [];
  for (const p of pages) {
    if (seen.has(p.slug)) continue;
    seen.add(p.slug);
    added.push({ type: "related", slug: p.slug, title: p.title });
  }
  if (added.length === 0) return 0;
  await db
    .update(docPages)
    .set({ links: [...current, ...added] })
    .where(eq(docPages.id, pageId));
  return added.length;
}

/** Sezione markdown DETERMINISTICA appesa alla entry quando ci sono aree nuove/troncate. */
export function newAreasSection(newAreas: string[], truncated: number): string {
  if (newAreas.length === 0 && truncated === 0) return "";
  const lines: string[] = ["", "## Aree nuove non documentate"];
  if (newAreas.length > 0) {
    lines.push("");
    for (const area of newAreas) lines.push(`- ${area}`);
  }
  if (truncated > 0) {
    lines.push(
      "",
      `_${truncated} pagina/e impattata/e oltre il tetto non sono state rigenerate in questo ciclo._`,
    );
  }
  if (newAreas.length > 0) {
    lines.push("", "_Valuta una rigenerazione completa per coprirle._");
  }
  return lines.join("\n");
}
