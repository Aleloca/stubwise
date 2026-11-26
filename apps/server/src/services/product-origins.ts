import { backlogItems, backlogJobs, docPageCodes, productPages, productRequestOrigins, projects, type Db } from "@stubwise/db";
import { anchorIdsOf, productBlockSchema, type ProductBlock, type ProductDocOrigin, type ProductOrigin } from "@stubwise/shared";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { docsModuleOn, projectPermissionsMap, readsDocs } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
import { ProductDocsError } from "./product-docs.js";

/**
 * Area 11, F6 — la pagina da cui nasce una richiesta (il prototipo:
 * `data/productDocs/backlog.ts`, shape product-claude-backlog §3.1–3.4).
 * Modulo snello (lo leggono richieste e task, senza giri d'import):
 * - l'origine si SALVA alla creazione (`product_request_origins`, una riga per
 *   lavoro d'intake): la pagina, la frase (null se non c'è più: l'origine
 *   resta sulla pagina) e la domanda di Claude se c'è;
 * - `productOrigin` di richieste e task si DERIVA a lettura: il titolo e il
 *   codice di adesso, null a chi non legge la pagina; la frase non esce mai
 *   (P38, R-G5);
 * - una frase già proposta (pagina e ancora, un intake non fallito) è 409
 *   `already_proposed`.
 * «From this page» e le candidate stanno in `product-request-origins.ts`.
 */

type Viewer = Pick<SessionUser, "id" | "instancePermissions">;

const readBlocks = (raw: unknown): ProductBlock[] =>
  (Array.isArray(raw) ? raw : []).flatMap((b) => {
    const parsed = productBlockSchema.safeParse(b);
    return parsed.success ? [parsed.data as ProductBlock] : [];
  });

export const pageCode = (projectCode: string, number: number | null) => (number === null ? projectCode : `${projectCode}-D${number}`);

/** Le frasi di una pagina già proposte: un intake che non è fallito (in coda, in corso o fatto). */
export async function proposedAnchors(db: Db, pageId: string): Promise<{ anchorId: string; itemId: string | null; itemProjectId: string | null; number: number | null; code: string | null }[]> {
  const rows = await db
    .select({ anchorId: productRequestOrigins.anchorId, itemId: backlogJobs.resultItemId, status: backlogJobs.status, number: backlogItems.number, projectId: backlogItems.projectId, code: projects.code })
    .from(productRequestOrigins)
    .innerJoin(backlogJobs, eq(backlogJobs.id, productRequestOrigins.intakeJobId))
    .leftJoin(backlogItems, eq(backlogItems.id, backlogJobs.resultItemId))
    .leftJoin(projects, eq(projects.id, backlogItems.projectId))
    .where(and(eq(productRequestOrigins.pageId, pageId), ne(backlogJobs.status, "failed")))
    .orderBy(asc(productRequestOrigins.createdAt));
  return rows.flatMap((r) => (r.anchorId === null ? [] : [{ anchorId: r.anchorId, itemId: r.itemId, itemProjectId: r.projectId, number: r.number, code: r.code }]));
}

/**
 * Il controllo di un'origine SENZA domanda (una voce proposta dalla pagina):
 * la frase già proposta è 409 `already_proposed`. La pagina (del progetto, e
 * chi chiede la legge) l'ha già controllata `checkProductDocOrigin`, sotto il
 * lock della pagina: due proposte insieme della stessa frase si mettono in fila.
 */
export async function checkPageProposal(tx: Db, pageId: string, anchorId: string): Promise<void> {
  if ((await proposedAnchors(tx, pageId)).some((p) => p.anchorId === anchorId)) throw new ProductDocsError(409, "already_proposed", "This sentence has already been proposed");
}

/** Salva l'origine della richiesta, nella transazione del suo lavoro d'intake. */
export async function recordProductOrigin(tx: Db, viewer: Viewer, origin: ProductDocOrigin, intakeJobId: string): Promise<void> {
  const [page] = await tx.select({ projectId: productPages.projectId, blocks: productPages.blocks }).from(productPages).where(eq(productPages.id, origin.pageId));
  if (!page) return;
  const present = readBlocks(page.blocks).some((b) => anchorIdsOf(b).includes(origin.anchorId));
  await tx.insert(productRequestOrigins).values({
    projectId: page.projectId,
    pageId: origin.pageId,
    anchorId: present ? origin.anchorId : null,
    questionId: origin.questionId ?? null,
    intakeJobId,
    createdBy: viewer.id,
  });
}

/** La pagina d'origine di ciascuna richiesta, per chi guarda: la prima nata; null (assente) a chi non legge la pagina. */
export async function productOriginsForItems(db: Db, viewer: Viewer, itemIds: readonly string[]): Promise<Map<string, ProductOrigin>> {
  if (itemIds.length === 0) return new Map();
  const rows = await db
    .select({ itemId: backlogJobs.resultItemId, pageId: productPages.id, title: productPages.title, projectId: productPages.projectId, projectCode: projects.code, number: docPageCodes.number })
    .from(productRequestOrigins)
    .innerJoin(backlogJobs, and(eq(backlogJobs.id, productRequestOrigins.intakeJobId), eq(backlogJobs.status, "done")))
    .innerJoin(productPages, eq(productPages.id, productRequestOrigins.pageId))
    .innerJoin(projects, eq(projects.id, productPages.projectId))
    .leftJoin(docPageCodes, eq(docPageCodes.productPageId, productPages.id))
    .where(inArray(backlogJobs.resultItemId, [...itemIds]))
    .orderBy(asc(productRequestOrigins.createdAt), asc(productRequestOrigins.id));
  if (rows.length === 0) return new Map();
  const perms = await projectPermissionsMap(db, viewer);
  const docsOn = await docsModuleOn(db, rows.map((r) => r.projectId));
  const out = new Map<string, ProductOrigin>();
  for (const r of rows) {
    if (!r.itemId || out.has(r.itemId)) continue;
    if (!(await readsDocs(db, r.projectId, perms[r.projectId], docsOn))) continue;
    out.set(r.itemId, { pageId: r.pageId, code: pageCode(r.projectCode, r.number), title: r.title });
  }
  return out;
}

