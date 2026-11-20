import { docPageCodes, productPageChunks, productPages, projects, type Db } from "@stubwise/db";
import type { EmbeddingClient } from "@stubwise/embeddings";
import { plainTextOf, productBlockSchema, type ProductBlock } from "@stubwise/shared";
import { and, asc, eq, inArray } from "drizzle-orm";
import { inProjectsStrict, projectIdsWithPermission } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
import { searchProductPages } from "./product-search.js";

/**
 * Area 11, F3 — le pagine di prodotto nella chat dei Docs del progetto. Le
 * trova la ricerca «In Product» (`searchProductPages`: stessa visibilità,
 * `docs.view` nella WHERE, ibrida, fail-open sull'embedder), e per ognuna il
 * contesto per il modello: il primo passaggio della pagina (il chunk 0, o il
 * testo semplice se i chunk non ci sono ancora), al più `PRODUCT_CONTEXT_CHARS`.
 *
 * Il testo di una pagina di prodotto lo scrive chiunque abbia `docs.edit`:
 * per il modello è contenuto NON fidato (`appendProductContext`).
 */

type Viewer = Pick<SessionUser, "id" | "instancePermissions">;

export const PRODUCT_CONTEXT_PAGES = 4;
export const PRODUCT_CONTEXT_CHARS = 1500;

export interface ProductContextPage {
  pageId: string;
  code: string;
  title: string;
  snippet: string;
}

const readBlocks = (raw: unknown): ProductBlock[] =>
  (Array.isArray(raw) ? raw : []).flatMap((b) => {
    const parsed = productBlockSchema.safeParse(b);
    return parsed.success ? [parsed.data as ProductBlock] : [];
  });

export async function retrieveProductContext(
  db: Db,
  embeddingClient: EmbeddingClient,
  viewer: Viewer,
  projectId: string,
  question: string,
  opts: { log?: { warn: (obj: unknown, msg?: string) => void }; limit?: number } = {},
): Promise<ProductContextPage[]> {
  const { items } = await searchProductPages(db, embeddingClient, viewer, question, { projectId, limit: opts.limit ?? PRODUCT_CONTEXT_PAGES, ...(opts.log ? { log: opts.log } : {}) });
  if (items.length === 0) return [];
  const ids = items.map((h) => h.page.id);
  const chunks = await db
    .select({ pageId: productPageChunks.pageId, content: productPageChunks.content })
    .from(productPageChunks)
    .where(and(inArray(productPageChunks.pageId, ids), eq(productPageChunks.position, 0)))
    .orderBy(asc(productPageChunks.pageId));
  const first = new Map(chunks.map((c) => [c.pageId, c.content]));
  const missing = ids.filter((id) => !first.has(id));
  const pages = missing.length > 0 ? await db.select({ id: productPages.id, blocks: productPages.blocks }).from(productPages).where(inArray(productPages.id, missing)) : [];
  for (const p of pages) first.set(p.id, plainTextOf(readBlocks(p.blocks)));
  return items.map((h) => ({ pageId: h.page.id, code: h.page.code, title: h.page.title, snippet: (first.get(h.page.id) ?? "").slice(0, PRODUCT_CONTEXT_CHARS) }));
}

/**
 * Le fonti di prodotto salvate con una risposta (solo gli id), come le vede chi
 * riapre la sessione ADESSO (46): titolo e codice di oggi, e solo le pagine che
 * ci sono ancora in un progetto in cui ha `docs.view`. Le altre non escono, né
 * titolo né codice.
 */
export async function productSourcesNow(db: Db, viewer: Viewer, pageIds: readonly string[]): Promise<Map<string, { pageId: string; code: string; title: string }>> {
  const ids = [...new Set(pageIds.filter((id) => /^[0-9a-f-]{36}$/i.test(id)))];
  if (ids.length === 0) return new Map();
  const readable = await projectIdsWithPermission(db, viewer, "docs.view");
  const rows = await db
    .select({ id: productPages.id, title: productPages.title, number: docPageCodes.number, projectCode: projects.code })
    .from(productPages)
    .innerJoin(projects, eq(projects.id, productPages.projectId))
    .innerJoin(docPageCodes, eq(docPageCodes.productPageId, productPages.id))
    .where(and(inArray(productPages.id, ids), inProjectsStrict(productPages.projectId, readable)));
  return new Map(rows.map((r) => [r.id, { pageId: r.id, code: `${r.projectCode}-D${r.number}`, title: r.title }]));
}
