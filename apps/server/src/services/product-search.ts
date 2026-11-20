import { docPageCodes, productPageChunks, productPages, projects, type Db } from "@stubwise/db";
import type { EmbeddingClient } from "@stubwise/embeddings";
import {
  excerptOfBlocks,
  plainTextOf,
  productBlockSchema,
  productPassage,
  productSearchWords,
  type ProductBlock,
  type ProductSearchHit,
} from "@stubwise/shared";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { inProjectsStrict, projectIdsWithPermission, type ProjectScope } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";

/**
 * Area 11, F3 — la ricerca nelle pagine di prodotto («In Product» in ⌘K e
 * l'ambito della ricerca globale). La regola è quella del prototipo
 * (`data/productDocs/search.ts`): le pagine che chi cerca LEGGE (`docs.view`),
 * le parole piegate, tutte, in qualunque ordine, nel codice, nel titolo e nel
 * testo (le frasi, le celle, le didascalie: mai un `href`). Una pagina che chi
 * cerca non legge non c'è, e il risultato è quello di una ricerca senza
 * corrispondenze (R-G5).
 *
 * - Il filtro di progetto sta nella WHERE di OGNI gamba, prima del limite
 *   (`permissions.md`): mai a valle sulle righe già tagliate.
 * - Ibrida: per significato (i chunk di `product-embed.ts`) e per testo
 *   (`product_pages.search_text`, piegato in TypeScript alla scrittura: una
 *   pagina appena scritta, senza chunk, si trova).
 *   L'embedder giù lascia la sola gamba per testo, e lo dice il log.
 * - La frase è il testo semplice (`plainTextOf`), una riga (`productPassage`).
 */

type Viewer = Pick<SessionUser, "id" | "instancePermissions">;
type Log = { warn: (obj: unknown, msg?: string) => void };

export const PRODUCT_SEARCH_LIMIT = 20;

const readBlocks = (raw: unknown): ProductBlock[] =>
  (Array.isArray(raw) ? raw : []).flatMap((b) => {
    const parsed = productBlockSchema.safeParse(b);
    return parsed.success ? [parsed.data as ProductBlock] : [];
  });

export interface ProductSearchResult {
  items: ProductSearchHit[];
  /** C'è almeno un risultato oltre il limite (fra le pagine che chi cerca legge). */
  hasMore: boolean;
}

/**
 * Cerca. `projectId` stringe a uno spazio (⌘K dentro il Prodotto); `semantic:
 * false` lascia la sola gamba per testo (la ricerca globale, che è la corsia
 * veloce e non chiama l'embedder a ogni tasto).
 */
export async function searchProductPages(
  db: Db,
  embeddingClient: EmbeddingClient,
  viewer: Viewer,
  q: string,
  opts: { projectId?: string; limit?: number; semantic?: boolean; log?: Log } = {},
): Promise<ProductSearchResult> {
  const words = productSearchWords(q);
  if (words.length === 0) return { items: [], hasMore: false };
  const limit = opts.limit ?? PRODUCT_SEARCH_LIMIT;
  const readable: ProjectScope = await projectIdsWithPermission(db, viewer, "docs.view");
  const scopeOf = (column: typeof productPages.projectId | typeof productPageChunks.projectId) =>
    and(inProjectsStrict(column, readable), opts.projectId ? eq(column, opts.projectId) : undefined);
  const code = sql`${projects.code} || '-D' || ${docPageCodes.number}`;

  // --- Per significato: i chunk più vicini, una pagina per volta (il chunk migliore). ---
  const ordered: string[] = [];
  if (opts.semantic !== false) {
    try {
      const [vector] = await embeddingClient.embed([q]);
      if (!vector) throw new Error("nessun vettore per la query");
      const literal = `[${vector.join(",")}]`;
      const rows = await db
        .select({ pageId: productPageChunks.pageId })
        .from(productPageChunks)
        .where(and(scopeOf(productPageChunks.projectId), sql`${productPageChunks.embedding} IS NOT NULL`))
        .orderBy(sql`${productPageChunks.embedding} <=> ${literal}::vector`)
        .limit(Math.max((limit + 1) * 3, 40));
      for (const r of rows) if (!ordered.includes(r.pageId)) ordered.push(r.pageId);
    } catch (error) {
      opts.log?.warn({ err: error }, "ricerca nelle pagine di prodotto: il significato non è disponibile, resta il testo");
    }
  }
  const semanticIds = ordered.slice(0, limit + 1);

  // --- Per testo: tutte le parole nel codice, nel titolo o nel testo dei blocchi. ---
  const textRows = await db
    .select({ id: productPages.id })
    .from(productPages)
    .innerJoin(projects, eq(projects.id, productPages.projectId))
    .innerJoin(docPageCodes, eq(docPageCodes.productPageId, productPages.id))
    .where(
      and(
        scopeOf(productPages.projectId),
        // Ogni parola nel testo già piegato (`search_text`, mai un `href`) o nel codice (ASCII).
        ...words.map((w) => {
          const like = `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
          return sql`(${productPages.searchText} like ${like} or lower(${code}) like ${like})`;
        }),
      ),
    )
    .orderBy(desc(productPages.updatedAt))
    .limit(limit + 1);
  const ids = [...semanticIds, ...textRows.map((r) => r.id).filter((id) => !semanticIds.includes(id))];
  const hasMore = ids.length > limit;
  const wanted = ids.slice(0, limit);
  if (wanted.length === 0) return { items: [], hasMore: false };

  const pages = await db
    .select({
      id: productPages.id,
      projectId: productPages.projectId,
      parentId: productPages.parentId,
      order: productPages.order,
      title: productPages.title,
      blocks: productPages.blocks,
      updatedAt: productPages.updatedAt,
      updatedBy: productPages.updatedBy,
      number: docPageCodes.number,
      projectCode: projects.code,
    })
    .from(productPages)
    .innerJoin(projects, eq(projects.id, productPages.projectId))
    .innerJoin(docPageCodes, eq(docPageCodes.productPageId, productPages.id))
    // Di nuovo nella WHERE: una pagina spostata o un permesso tolto fra le due letture non esce.
    .where(and(inArray(productPages.id, wanted), scopeOf(productPages.projectId)));
  const byId = new Map(pages.map((p) => [p.id, p]));
  const items = wanted.flatMap((id): ProductSearchHit[] => {
    const p = byId.get(id);
    if (!p) return [];
    const blocks = readBlocks(p.blocks);
    const excerpt = excerptOfBlocks(blocks);
    return [
      {
        page: {
          id: p.id,
          code: `${p.projectCode}-D${p.number}`,
          projectId: p.projectId,
          parentId: p.parentId,
          order: p.order,
          title: p.title,
          excerpt,
          updatedAt: p.updatedAt.toISOString(),
          updatedById: p.updatedBy,
        },
        projectCode: p.projectCode,
        passage: productPassage(plainTextOf(blocks).split("\n"), words, excerpt),
      },
    ];
  });
  return { items, hasMore };
}
