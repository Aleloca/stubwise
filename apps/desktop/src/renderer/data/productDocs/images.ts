import { gate } from "../store";
import { invalid, writer } from "../writer";

// Le immagini dei blocchi (area 11, F1; R11-1). Il prototipo tiene il file
// nel blocco come `data:` URL (nessun `fetch`, nessun `file://`): lo legge
// qui, dopo il controllo di tipo e misura dell'editor (`editor/images.ts`).
// Nella build app la stessa funzione carica il file sul server e il blocco
// porta `product-image:<id>` (`backend/real/productDocs.ts`): lì il file non
// si legge come data URL (M4 della revisione).

/** Il `src` da mettere nel blocco: nel prototipo, il file letto come `data:` URL. */
export async function storeProductImage(pageId: string, file: File): Promise<string> {
  await writer("productDocs.storeProductImage");
  void pageId;
  const src = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(invalid("invalid_image"));
    reader.readAsDataURL(file);
  });
  // Un risultato che non è un'immagine `data:` di quel tipo non entra in un blocco.
  if (!src.startsWith(`data:${file.type}`) || !file.type.startsWith("image/"))
    throw invalid("invalid_image");
  return src;
}

/** Da dove si mostra l'immagine di un blocco: solo `data:image/…`, nient'altro si carica (§9). */
export async function productImageSrc(pageId: string, src: string): Promise<string | null> {
  await gate("productDocs.productImageSrc");
  void pageId;
  return src.startsWith("data:image/") ? src : null;
}
