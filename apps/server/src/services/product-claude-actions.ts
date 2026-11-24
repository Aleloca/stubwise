import {
  docPageCodes,
  emailMessages,
  emailProposals,
  meetingNotes,
  productDocJobs,
  productPageRevisions,
  productPageUpdates,
  productPages,
  projects,
  type Db,
} from "@stubwise/db";
import { aiBudgetState } from "@stubwise/notifications";
import type { ProductChange, ProductChanges, ProductPageUpdateSource } from "@stubwise/shared";
import { and, desc, eq, gte, inArray, isNull, ne, notExists, sql } from "drizzle-orm";
import { inProjects, isAllProjects, projectIdsWithPermission, projectPermissionsFor, scopeIncludes } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
import { namesFor, productSourceViews } from "./product-claude.js";
import { ProductDocsError } from "./product-docs.js";

/**
 * Area 11, F6, Task 4 — ciò che le voci e le letture di Claude sulla doc
 * aggiungono ai gesti della pagina:
 * - «aggiorna <pagina> da questa email» (`updateProductPage`): un lavoro della
 *   coda della doc su UNA fonte e UNA pagina, chiesto da chi conferma. La
 *   fonte deve essere sua da aprire (`canOpen`: la casella di chi chiede,
 *   `mailbox_owner`), e del progetto della pagina; col budget del mese finito
 *   non parte. Il modello lo fa partire il worker: la scrittura arriva dopo,
 *   con la revisione di Claude e il suo «Undo»;
 * - i cambi recenti (`read_product_changes`): le revisioni delle pagine dei
 *   progetti in cui chi chiede legge i Docs, filtrate nella WHERE, con la
 *   fonte come la vede lui e i nomi solo se li vede (R-G5). Col token di una
 *   chat (`forChat`) l'oggetto e il thread di un'email o di una riunione non
 *   escono MAI, nemmeno al titolare (review di F6, I1): la risposta può stare
 *   in una conversazione pubblica o in un canale con ospiti, e la posta non va
 *   mai in un posto condiviso (`mail-calendar.md`). Restano tipo, titolare e
 *   `canOpen`. La rotta letta dal desktop resta com'è.
 * Questo modulo non nomina niente che scriva nel registro decisioni.
 */

type Viewer = Pick<SessionUser, "id" | "instancePermissions">;

const notFound = () => new ProductDocsError(404, "not_found", "Not found");

/** Al più tanti cambi per lettura (`more` dice se ce ne sono altri). */
export const PRODUCT_CHANGES_MAX = 100;

export async function requestProductPageUpdate(
  db: Db,
  viewer: Viewer,
  pageId: string,
  source: ProductPageUpdateSource,
  budget: { monthlyCostUsdFn?: (db: Db) => Promise<number> } = {},
): Promise<{ updateId: string }> {
  const [page] = await db.select({ id: productPages.id, projectId: productPages.projectId }).from(productPages).where(eq(productPages.id, pageId));
  const perms = page ? await projectPermissionsFor(db, viewer, page.projectId) : null;
  if (!page || !perms?.has("docs.view")) throw notFound();
  if (!perms.has("docs.edit")) throw new ProductDocsError(403, "forbidden", "Forbidden");
  // Una fonte che chi chiede non può aprire si legge come una che non c'è (R-G5 del prototipo).
  const view = (await productSourceViews(db, viewer, [source])).get(`${source.kind}:${source.id}`);
  if (!view || view.gone || !view.canOpen) throw notFound();
  // La fonte deve alimentare QUESTO progetto, come per il lavoro automatico (`readProductSource` del worker).
  const ofProject =
    source.kind === "email"
      ? (
          await db
            .select({ id: emailMessages.id })
            .from(emailMessages)
            .innerJoin(emailProposals, and(eq(emailProposals.emailMessageId, emailMessages.id), eq(emailProposals.projectId, page.projectId), ne(emailProposals.status, "ignored")))
            .where(and(eq(emailMessages.id, source.id), eq(emailMessages.admitted, true)))
            .limit(1)
        ).length > 0
      : (await db.select({ id: meetingNotes.id }).from(meetingNotes).where(and(eq(meetingNotes.id, source.id), eq(meetingNotes.projectId, page.projectId), eq(meetingNotes.docStatus, "ready")))).length > 0;
  if (!ofProject) throw new ProductDocsError(422, "invalid_source", "The source is not part of this project");
  // D-7.1 (review del lotto 4, I-1): chi ha `plans.approve` scavalca il budget, e il lavoro lo porta.
  const budgetBypass = perms?.has("plans.approve") ?? false;
  if (!budgetBypass && (await aiBudgetState(db, budget.monthlyCostUsdFn)).exhausted) throw new ProductDocsError(409, "budget_exhausted", "The monthly AI budget is used up");
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    // Una richiesta il cui lavoro non è più vivo (finito con un errore inatteso) non tiene il posto.
    await tx
      .update(productPageUpdates)
      .set({ finishedAt: new Date() })
      .where(
        and(
          eq(productPageUpdates.pageId, pageId),
          eq(productPageUpdates.sourceKind, source.kind),
          eq(productPageUpdates.sourceId, source.id),
          isNull(productPageUpdates.finishedAt),
          notExists(
            tx
              .select({ id: productDocJobs.id })
              .from(productDocJobs)
              .where(and(eq(productDocJobs.sourceKind, "page_update"), eq(productDocJobs.sourceId, productPageUpdates.id), inArray(productDocJobs.status, ["queued", "running", "held"]))),
          ),
        ),
      );
    const [row] = await tx
      .insert(productPageUpdates)
      .values({ projectId: page.projectId, pageId, sourceKind: source.kind, sourceId: source.id, requestedBy: viewer.id })
      .onConflictDoNothing()
      .returning({ id: productPageUpdates.id });
    if (!row) {
      // Review del lotto 5 (M-3, 46): chi scavalca il budget e trova la richiesta
      // viva FERMA (in coda o in attesa, non mentre gira) la riprende: lo
      // scavalco sul lavoro, di nuovo in coda, e la richiesta passa a lui
      // (il worker rilegge permesso e fonte di chi l'ha chiesta, che qui sono
      // già stati controllati). Per gli altri resta `already_updating`.
      if (budgetBypass) {
        const [live] = await tx
          .select({ id: productPageUpdates.id })
          .from(productPageUpdates)
          .where(and(eq(productPageUpdates.pageId, pageId), eq(productPageUpdates.sourceKind, source.kind), eq(productPageUpdates.sourceId, source.id), isNull(productPageUpdates.finishedAt)));
        const resumed = live
          ? await tx
              .update(productDocJobs)
              // Revisione dei lotti 6–7 (I-2): torna in coda SOLO un lavoro fermo
              // per il budget; uno fermo per altro (limite, sezione occupata,
              // pausa) resta fermo col suo motivo, e `notBefore` (il backoff)
              // non si tocca mai. Lo scavalco lo porta comunque.
              .set({
                budgetBypass: true,
                status: sql`case when ${productDocJobs.status} = 'held' and ${productDocJobs.heldReason} = 'budget' then 'queued' else ${productDocJobs.status} end`,
                heldReason: sql`case when ${productDocJobs.heldReason} = 'budget' then null else ${productDocJobs.heldReason} end`,
              })
              .where(and(eq(productDocJobs.sourceKind, "page_update"), eq(productDocJobs.sourceId, live.id), inArray(productDocJobs.status, ["queued", "held"])))
              .returning({ id: productDocJobs.id })
          : [];
        if (live && resumed.length > 0) {
          await tx.update(productPageUpdates).set({ requestedBy: viewer.id }).where(eq(productPageUpdates.id, live.id));
          return { updateId: live.id };
        }
      }
      throw new ProductDocsError(409, "already_updating", "Claude is already updating this page from this source");
    }
    await tx.insert(productDocJobs).values({ projectId: page.projectId, sourceKind: "page_update", sourceId: row.id, budgetBypass });
    return { updateId: row.id };
  });
}

/**
 * `GET /api/product-changes`: i cambi dal più recente, da `since`, dei
 * progetti in cui chi chiede ha `docs.view` (o del solo `projectId`, 404 se
 * non lo legge).
 */
export async function listProductChanges(db: Db, viewer: Viewer, input: { projectId?: string; since: Date; forChat?: boolean }): Promise<ProductChanges> {
  const scope = await projectIdsWithPermission(db, viewer, "docs.view");
  // Un progetto archiviato o che non c'è è 404, anche per un full admin (review di F6, M2).
  if (input.projectId !== undefined) {
    if (!scopeIncludes(scope, input.projectId)) throw notFound();
    if ((await db.select({ id: projects.id }).from(projects).where(eq(projects.id, input.projectId))).length === 0) throw notFound();
  }
  if (!isAllProjects(scope) && scope.length === 0) return { items: [], more: false };
  const projectFilter = input.projectId !== undefined ? eq(productPages.projectId, input.projectId) : inProjects(productPages.projectId, scope);
  const rows = await db
    .select({
      revisionId: productPageRevisions.id,
      pageId: productPages.id,
      pageTitle: productPages.title,
      projectId: productPages.projectId,
      projectCode: projects.code,
      number: docPageCodes.number,
      kind: productPageRevisions.kind,
      via: productPageRevisions.via,
      actorId: productPageRevisions.actorId,
      onBehalfOf: productPageRevisions.onBehalfOf,
      sourceKind: productPageRevisions.sourceKind,
      sourceId: productPageRevisions.sourceId,
      at: productPageRevisions.createdAt,
    })
    .from(productPageRevisions)
    .innerJoin(productPages, eq(productPages.id, productPageRevisions.pageId))
    .innerJoin(projects, eq(projects.id, productPages.projectId))
    .leftJoin(docPageCodes, eq(docPageCodes.productPageId, productPages.id))
    .where(and(gte(productPageRevisions.createdAt, input.since), projectFilter))
    .orderBy(desc(productPageRevisions.createdAt), desc(productPageRevisions.id))
    .limit(PRODUCT_CHANGES_MAX + 1);
  const page = rows.slice(0, PRODUCT_CHANGES_MAX);
  const nameOf = await namesFor(db, viewer, page.flatMap((r) => [r.actorId, r.onBehalfOf]));
  const sources = await productSourceViews(
    db,
    viewer,
    page.flatMap((r) => (r.sourceKind && r.sourceId ? [{ kind: r.sourceKind, id: r.sourceId }] : [])),
  );
  const sourceOf = (r: (typeof page)[number]): ProductChange["source"] => {
    if (!r.sourceKind || !r.sourceId) return null;
    const view = sources.get(`${r.sourceKind}:${r.sourceId}`) ?? null;
    return view && input.forChat === true && (view.kind === "email" || view.kind === "meeting") ? { ...view, title: null, thread: null } : view;
  };
  const items: ProductChange[] = page.map((r) => ({
    revisionId: r.revisionId,
    pageId: r.pageId,
    pageCode: r.number === null ? r.projectCode : `${r.projectCode}-D${r.number}`,
    pageTitle: r.pageTitle,
    projectId: r.projectId,
    kind: r.kind as ProductChange["kind"],
    via: r.via,
    actorName: nameOf(r.actorId),
    onBehalfOfName: nameOf(r.onBehalfOf),
    source: sourceOf(r),
    at: r.at.toISOString(),
  }));
  return { items, more: rows.length > PRODUCT_CHANGES_MAX };
}
