import { plainTextOf } from "../../domain/productDocs/blocks";
import { fold, searchWords } from "../../pages/chat/search";
import { passageIn } from "../docs/reads";
import { gate, state } from "../store";
import type { ProductSearchHit } from "../types";
import { productPageRef, readableProductPages } from "./reads";

/**
 * Cerca nelle pagine di prodotto che chi guarda legge, come `searchDocs`:
 * parole piegate, tutte, in qualunque ordine, nel codice, nel titolo e nel
 * testo (`plainTextOf`: le frasi senza segni, le didascalie, le celle; gli
 * indirizzi dei link non sono testo). Con `projectId` solo in quello spazio
 * (⌘K dentro il Prodotto). Una pagina che chi guarda non legge non c'è: il
 * risultato è lo stesso di una ricerca senza corrispondenze (R-G5).
 */
export async function searchProductPages(
  q: string,
  { projectId }: { projectId?: string } = {},
): Promise<ProductSearchHit[]> {
  const me = await gate("productDocs.searchProductPages");
  const words = searchWords(q);
  if (words.length === 0) return [];
  return readableProductPages(me)
    .filter((p) => projectId === undefined || p.projectId === projectId)
    .map((page) => ({ page, text: plainTextOf(page.blocks) }))
    .filter(({ page, text }) => {
      const fields = [page.code, page.title, text].map(fold);
      return words.every((w) => fields.some((f) => f.includes(w)));
    })
    .map(({ page, text }) => {
      const ref = productPageRef(page);
      return {
        page: ref,
        projectCode: state.projectsById.get(page.projectId)!.code,
        passage: passageIn(text.split("\n"), words, ref.excerpt),
      };
    });
}
