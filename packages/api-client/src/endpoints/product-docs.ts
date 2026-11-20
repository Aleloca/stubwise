import { productCommentViewSchema, productCommentsSchema, productMentionCandidatesSchema, productPageViewSchema, productRevisionViewSchema, productSpaceSchema } from "@stubwise/shared";
import type { AddProductCommentInput, ProductBlockOp, ProductCommentView, ProductCommentsView, ProductPageView, ProductRevisionView, ProductSpaceView, Reader } from "@stubwise/shared";
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
    /** L'immagine coi permessi della pagina: la rotta risponde coi byte (nessun redirect verso lo storage). */
    imagePath(pageId: string, imageId: string): string {
      return `/api/product-pages/${seg(pageId)}/images/${seg(imageId)}`;
    },
  };
}
