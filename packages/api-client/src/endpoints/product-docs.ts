import {
  productCommentViewSchema,
  productCommentsSchema,
  productExportPageSchema,
  productExportSpaceSchema,
  productMarkViewSchema,
  productMentionCandidatesSchema,
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
  ProductMarkView,
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
