import {
  productCommentViewSchema,
  productCommentsSchema,
  productExportPageSchema,
  productExportSpaceSchema,
  productMarkViewSchema,
  productMentionCandidatesSchema,
  productBacklogCandidatesSchema,
  productFirstVersionSourcesSchema,
  productFirstVersionViewSchema,
  productLinkedRequestSchema,
  productOpenQuestionSchema,
  productPageViewSchema,
  productPresenceBeatResultSchema,
  productRevisionViewSchema,
  productSearchResultsSchema,
  productSpaceSchema,
} from "@stubwise/shared";
import type {
  AddProductCommentInput,
  ProductBlockOp,
  ProductCommentView,
  ProductCommentsView,
  ProductExportPage,
  ProductExportSpace,
  DrawWireframeInput,
  ProductAnswerChoice,
  ProductBacklogCandidates,
  ProductFirstVersionSources,
  ProductFirstVersionView,
  ProductLinkedRequest,
  ProductMarkView,
  ProductOpenQuestion,
  StartFirstVersionInput,
  ProductPageView,
  ProductPresenceBeat,
  ProductPresenceBeatResult,
  ProductRevisionView,
  ProductSearchResults,
  ProductSpaceView,
  Reader,
} from "@stubwise/shared";
import { z } from "zod";
import type { ApiRequest } from "../client.js";
import { seg, toQuery } from "../query.js";

const createdSchema = z.object({ id: z.uuid(), code: z.string() });
const savedSchema = z.object({ seq: z.number().int(), revisionId: z.uuid().nullable() });
const answerSchema = z.object({ revisionId: z.uuid().nullable(), seq: z.number().int().nullable() });
const imageSchema = z.object({ id: z.uuid(), ref: z.string() });

/**
 * La documentazione di prodotto (area 11, F1): lo spazio Product di un
 * progetto, le pagine, la scrittura a operazioni, la cronologia, Segui, le
 * immagini. Lo spazio dà le pagine IN FILA: l'albero lo costruisce chi legge
 * (`buildProductTree` di `@stubwise/shared`); i blocchi arrivano come record,
 * da leggere con `productBlockSchema`. Un salvataggio su una versione superata
 * da un altro risponde 409 `stale` con le revisioni mancanti (`ApiError.body`).
 */
export function createProductDocsEndpoints(request: ApiRequest) {
  return {
    space(projectId: string): Promise<Reader<ProductSpaceView>> {
      return request("GET", `/api/projects/${seg(projectId)}/product`, undefined, productSpaceSchema);
    },
    page(code: string): Promise<Reader<ProductPageView>> {
      return request("GET", `/api/product-pages/by-code/${seg(code)}`, undefined, productPageViewSchema);
    },
    create(projectId: string, input: { title: string; parentId?: string | null; index?: number }) {
      return request("POST", `/api/projects/${seg(projectId)}/product/pages`, input, createdSchema);
    },
    update(pageId: string, input: { title?: string; move?: { parentId: string | null; index: number } }): Promise<void> {
      return request("PATCH", `/api/product-pages/${seg(pageId)}`, input);
    },
    remove(pageId: string): Promise<void> {
      return request("DELETE", `/api/product-pages/${seg(pageId)}`);
    },
    save(pageId: string, input: { sessionId: string; baseSeq: number; ops: ProductBlockOp[]; undoOf?: string }) {
      return request("POST", `/api/product-pages/${seg(pageId)}/ops`, input, savedSchema);
    },
    /** Le revisioni dalla più recente, a pagine di 100; `before` = il `lastSeq` più vecchio già letto. */
    revisions(pageId: string, before?: number): Promise<Reader<ProductRevisionView>[]> {
      return request("GET", `/api/product-pages/${seg(pageId)}/revisions${toQuery({ before: before === undefined ? undefined : String(before) })}`, undefined, z.array(productRevisionViewSchema));
    },
    follow(pageId: string, on: boolean): Promise<void> {
      return request(on ? "PUT" : "DELETE", `/api/product-pages/${seg(pageId)}/follow`);
    },
    /** Un'immagine (multipart, campo `file`, al più 5 MB; PNG, JPEG, GIF, WebP): il riferimento per il blocco. */
    uploadImage(pageId: string, file: Blob, filename: string) {
      const form = new FormData();
      form.append("file", file, filename);
      return request("POST", `/api/product-pages/${seg(pageId)}/images`, form, imageSchema);
    },
    // --- F2: i commenti ---
    /** I fili della pagina, aperti e risolti; `anchorGone` = «Frase eliminata» (derivato). */
    comments(pageId: string): Promise<Reader<ProductCommentsView>> {
      return request("GET", `/api/product-pages/${seg(pageId)}/comments`, undefined, productCommentsSchema);
    },
    /** Un commento (`docs.edit`); con `replyToId` una risposta, che prende ancora e frase della radice. Le menzioni le trova il server (`@Nome`). */
    addComment(pageId: string, input: AddProductCommentInput): Promise<Reader<ProductCommentView>> {
      return request("POST", `/api/product-pages/${seg(pageId)}/comments`, input, productCommentViewSchema);
    },
    resolveComment(commentId: string): Promise<void> {
      return request("POST", `/api/product-comments/${seg(commentId)}/resolve`);
    },
    reopenComment(commentId: string): Promise<void> {
      return request("POST", `/api/product-comments/${seg(commentId)}/reopen`);
    },
    /** Chi si può menzionare nel progetto: chi ne legge i Docs e chi guarda vede, mai Claude né sé stessi. */
    mentionCandidates(projectId: string, q = ""): Promise<Reader<{ id: string; name: string }>[]> {
      return request("GET", `/api/projects/${seg(projectId)}/product/mention-candidates${toQuery({ q: q || undefined })}`, undefined, productMentionCandidatesSchema);
    },
    // --- F5: i segni di Claude ---
    /** I segni APERTI di una pagina, uno per ancora, con la fonte vista e lo stato di «Undo». */
    marks(pageId: string): Promise<Reader<ProductMarkView>[]> {
      return request("GET", `/api/product-pages/${seg(pageId)}/marks`, undefined, z.array(productMarkViewSchema));
    },
    /** «Looks good»: il segno si toglie (409 `already_undone` su uno annullato). */
    acceptMark(markId: string): Promise<void> {
      return request("POST", `/api/product-marks/${seg(markId)}/looks-good`);
    },
    /**
     * «Undo» di un segno: l'ancora torna com'era prima di Claude. 409 col motivo
     * in `ApiError.body`: `changed_after` (`byId`, `byName`), `already_undone`,
     * `section_busy` (`sectionId`, `by`).
     */
    undoMark(markId: string): Promise<{ seq: number; revisionId: string | null }> {
      return request("POST", `/api/product-marks/${seg(markId)}/undo`, undefined, savedSchema);
    },
    /** «Undo all» di una revisione di Claude: tutto o niente, gli stessi 409 di `undoMark`. */
    undoRevision(revisionId: string): Promise<{ seq: number; revisionId: string | null }> {
      return request("POST", `/api/product-revisions/${seg(revisionId)}/undo-all`, undefined, savedSchema);
    },
    // --- F5: le domande di Claude ---
    /**
     * La risposta a una domanda di Claude (`docs.edit`, una sola): `apply`
     * scrive la frase (`revisionId`), `keep` chiude. «Open a request» non passa
     * da qui: è `requests.create` con `origin` (`kind: "product_doc"`, il
     * `questionId`), che chiude la domanda col job d'intake. 409 in
     * `ApiError.body`: `already_answered` e `changed_after` (`byId`,
     * `byName`), `section_busy` (`sectionId`, `by`); 422 `option_unavailable`
     * e `request_via_create_request`.
     */
    answerQuestion(commentId: string, option: Exclude<ProductAnswerChoice, "request">): Promise<{ revisionId: string | null; seq: number | null }> {
      return request("POST", `/api/product-comments/${seg(commentId)}/answer`, { option }, answerSchema);
    },
    /** Le domande aperte a cui chi guarda può rispondere (Home «Decide»; `pageId` = il riquadro di una pagina). */
    openQuestions(pageId?: string): Promise<Reader<ProductOpenQuestion>[]> {
      return request("GET", `/api/me/product-questions${toQuery({ pageId })}`, undefined, z.array(productOpenQuestionSchema));
    },
    // --- F6: la prima versione ---
    /** Le fonti fra cui chi chiede sceglie: solo ciò che vede nel progetto. */
    firstVersionSources(projectId: string): Promise<Reader<ProductFirstVersionSources>> {
      return request("GET", `/api/projects/${seg(projectId)}/product/first-version/sources`, undefined, productFirstVersionSourcesSchema);
    },
    /** L'ultima prima versione dello spazio, o null. Mentre `status` è `writing` si rilegge (ogni 2 s). */
    firstVersion(projectId: string): Promise<Reader<ProductFirstVersionView> | null> {
      return request("GET", `/api/projects/${seg(projectId)}/product/first-version`, undefined, productFirstVersionViewSchema.nullable());
    },
    /**
     * «Write the first version» (`docs.edit`): parte e risponde 202 col gruppo.
     * Errori: 404, 403, 422 `invalid_source` / `no_sources`, 409
     * `space_not_empty` (una pagina c'è già, o una prima versione scrive),
     * 409 `ai_blocked` (il budget del mese).
     */
    startFirstVersion(projectId: string, sources: StartFirstVersionInput["sources"]): Promise<{ groupId: string }> {
      return request("POST", `/api/projects/${seg(projectId)}/product/first-version`, { sources }, z.object({ groupId: z.uuid() }));
    },
    /**
     * «Undo the first version»: toglie le sue pagine. 409 in `ApiError.body`:
     * `changed_after` (`byId`, `byName`, `pageId`, `pageTitle`, `touch`) o
     * `already_undone`.
     */
    undoFirstVersion(projectId: string): Promise<void> {
      return request("POST", `/api/projects/${seg(projectId)}/product/first-version/undo`);
    },
    /** «Stop»: si ferma dopo la pagina in corso (`interrupted`). Idempotente. */
    stopFirstVersion(projectId: string): Promise<void> {
      return request("POST", `/api/projects/${seg(projectId)}/product/first-version/stop`);
    },
    /** «Accept this page»: la riga in cima sparisce per tutti. 422 `invalid_page` se non è di una prima versione viva. */
    acceptFirstVersionPage(pageId: string): Promise<void> {
      return request("POST", `/api/product-pages/${seg(pageId)}/first-version/accept`);
    },
    // --- F6: le bozze di schermata ---
    /**
     * «Draw this screen» (dopo un blocco; `afterId: null` = in cima) o «/» →
     * «Screen sketch» (`replaceId`: un paragrafo vuoto). Il blocco nasce
     * subito (`drawing`); il disegno arriva col frame `wireframe` dello stream.
     * Errori: 404, 403, 422 `invalid_replace`, 409 `ai_blocked`.
     */
    drawWireframe(pageId: string, at: DrawWireframeInput): Promise<{ blockId: string; wireframeId: string }> {
      return request("POST", `/api/product-pages/${seg(pageId)}/wireframes`, at, z.object({ blockId: z.string(), wireframeId: z.uuid() }));
    },
    /** «Redraw»: una variante nuova, in arrivo come il disegno. `fromVariant`: la variante che si vedeva (il doppio clic non ne chiede due). */
    redrawWireframe(pageId: string, blockId: string, fromVariant?: number): Promise<{ blockId: string }> {
      return request("POST", `/api/product-pages/${seg(pageId)}/wireframes/${seg(blockId)}/redraw`, fromVariant === undefined ? {} : { fromVariant }, z.object({ blockId: z.string() }));
    },
    /** Una variante già disegnata (una revisione di chi sceglie). */
    pickWireframe(pageId: string, blockId: string, variant: number): Promise<{ revisionId: string | null }> {
      return request("POST", `/api/product-pages/${seg(pageId)}/wireframes/${seg(blockId)}/pick`, { variant }, z.object({ revisionId: z.uuid().nullable() }));
    },
    /** «Keep»: toglie l'etichetta «Claude's sketch». Già tenuta: `revisionId: null`. */
    keepWireframe(pageId: string, blockId: string): Promise<{ revisionId: string | null }> {
      return request("POST", `/api/product-pages/${seg(pageId)}/wireframes/${seg(blockId)}/keep`, undefined, z.object({ revisionId: z.uuid().nullable() }));
    },
    /** «Replace with an image»: un'immagine già caricata nella pagina (`product-image:<id>`) al posto della bozza, stesso id. */
    replaceWireframeWithImage(pageId: string, blockId: string, image: { src: string; alt?: string }): Promise<{ revisionId: string | null }> {
      return request("POST", `/api/product-pages/${seg(pageId)}/wireframes/${seg(blockId)}/replace-image`, image, z.object({ revisionId: z.uuid().nullable() }));
    },
    // --- F6: dalla doc al backlog ---
    /**
     * Le voci da proporre dalla pagina (o dalla sezione di un titolo): la
     * scheda B la compone il client, una `requests.create` per voce con
     * `origin` (pagina e ancora). 422 `invalid_anchor` se `fromAnchorId` non
     * è un titolo della pagina; 403 senza `docs.edit`.
     */
    backlogCandidates(pageId: string, fromAnchorId?: string): Promise<Reader<ProductBacklogCandidates>> {
      return request("GET", `/api/product-pages/${seg(pageId)}/backlog-candidates${toQuery({ fromAnchorId })}`, undefined, productBacklogCandidatesSchema);
    },
    /** «From this page»: le richieste nate dalla pagina che chi guarda vede. */
    linkedRequests(pageId: string): Promise<Reader<ProductLinkedRequest>[]> {
      return request("GET", `/api/product-pages/${seg(pageId)}/requests`, undefined, z.array(productLinkedRequestSchema));
    },
    // --- F4: la scrittura dal vivo ---
    /**
     * Il battito della presenza (ogni 5 s, scade a 15 s). Con `sectionId` serve
     * `docs.edit` e prende o rinnova la sezione: `hold` se è tua, `busy` se la
     * tiene un altro. `sectionId: null` lascia le tue prese. Lo stream
     * (`productLiveStreamPath`, `parseProductLiveFrame` di shared) lo apre il
     * renderer: `EventSource` sul web, il main del desktop.
     */
    beat(pageId: string, input: ProductPresenceBeat): Promise<Reader<ProductPresenceBeatResult>> {
      return request("POST", `/api/product-pages/${seg(pageId)}/live/presence`, input, productPresenceBeatResultSchema);
    },
    // --- F3: la ricerca e l'esportazione ---
    /** «In Product» in uno spazio: ibrida, al più 20, e se ce ne sono altre. La ricerca globale ha il gruppo `product`. */
    search(projectId: string, q: string): Promise<Reader<ProductSearchResults>> {
      return request("GET", `/api/projects/${seg(projectId)}/product/search${toQuery({ q })}`, undefined, productSearchResultsSchema);
    },
    /** Una pagina da esportare: blocchi senza commenti, decisioni e file del Drive come li vede chi esporta. */
    exportPage(pageId: string): Promise<Reader<ProductExportPage>> {
      return request("GET", `/api/product-pages/${seg(pageId)}/export`, undefined, productExportPageSchema);
    },
    /** Lo spazio intero in ordine d'albero; oltre 200 pagine 413 `too_many_pages` con `count` e `max` (`ApiError.body`). */
    exportSpace(projectId: string): Promise<Reader<ProductExportSpace>> {
      return request("GET", `/api/projects/${seg(projectId)}/product/export`, undefined, productExportSpaceSchema);
    },
    /** L'immagine coi permessi della pagina: la rotta risponde coi byte (nessun redirect verso lo storage). */
    imagePath(pageId: string, imageId: string): string {
      return `/api/product-pages/${seg(pageId)}/images/${seg(imageId)}`;
    },
  };
}
