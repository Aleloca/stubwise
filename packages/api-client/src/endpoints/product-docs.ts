import { productPageViewSchema, productRevisionViewSchema, productSpaceSchema } from "@stubwise/shared";
import type { ProductBlockOp, ProductPageView, ProductRevisionView, ProductSpaceView, Reader } from "@stubwise/shared";
import { z } from "zod";
import type { ApiRequest } from "../client.js";
import { seg } from "../query.js";

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
    revisions(pageId: string): Promise<Reader<ProductRevisionView>[]> {
      return request("GET", `/api/product-pages/${seg(pageId)}/revisions`, undefined, z.array(productRevisionViewSchema));
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
    /** L'immagine: 302 verso un URL firmato breve, coi permessi della pagina. */
    imagePath(pageId: string, imageId: string): string {
      return `/api/product-pages/${seg(pageId)}/images/${seg(imageId)}`;
    },
  };
}
