import { gate } from "../store";
import { writer } from "../writer";

// Le immagini dei blocchi (area 11, F1; R11-1). Il prototipo tiene il file
// nel blocco come `data:` URL, già letto e controllato dall'editor
// (`editor/images.ts`): salvarlo non cambia niente. Nella build app la stessa
// coppia carica il file sul server e il blocco porta `product-image:<id>`
// (`backend/real/productDocs.ts`).

/** Il `src` da mettere nel blocco: nel prototipo, lo stesso `data:` URL letto dall'editor. */
export async function storeProductImage(pageId: string, file: File, src: string): Promise<string> {
  await writer("productDocs.storeProductImage");
  void [pageId, file];
  return src;
}

/** Da dove si mostra l'immagine di un blocco: solo `data:image/…`, nient'altro si carica (§9). */
export async function productImageSrc(pageId: string, src: string): Promise<string | null> {
  await gate("productDocs.productImageSrc");
  void pageId;
  return src.startsWith("data:image/") ? src : null;
}
