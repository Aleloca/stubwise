import { readerSchema, type Reader } from "../reader.js";
import {
  productLiveCursorSchema,
  productLiveGoneSchema,
  productLiveHoldSchema,
  productLivePresenceSchema,
  productLiveReleaseSchema,
  productLiveRevisionSchema,
  productLiveStateSchema,
  productLiveWireframeSchema,
} from "../schemas/product-docs.js";
import type { z } from "zod";

/**
 * Lo stream dal vivo di una pagina di prodotto (area 11, F4, `GET
 * /api/product-pages/:id/live`), nella parte PURA che serve al renderer web e
 * al main di Electron: leggere un frame, il percorso e la sua allowlist. Il
 * formato è quello della Chat: righe `data: {json}` separate da una riga
 * vuota, `: ping` ogni 25 s (si scarta). Ogni frame si valida da solo coi
 * `readerSchema`: uno malformato, o di un tipo che il client non conosce, si
 * scarta senza costare gli altri.
 */

export type ProductLiveFrame =
  | Reader<z.infer<typeof productLiveStateSchema>>
  | Reader<z.infer<typeof productLiveRevisionSchema>>
  | Reader<z.infer<typeof productLivePresenceSchema>>
  | Reader<z.infer<typeof productLiveCursorSchema>>
  | Reader<z.infer<typeof productLiveHoldSchema>>
  | Reader<z.infer<typeof productLiveReleaseSchema>>
  | Reader<z.infer<typeof productLiveGoneSchema>>
  | Reader<z.infer<typeof productLiveWireframeSchema>>;

const READERS: Record<string, { safeParse: (v: unknown) => { success: boolean; data?: unknown } }> = {
  state: readerSchema(productLiveStateSchema),
  revision: readerSchema(productLiveRevisionSchema),
  presence: readerSchema(productLivePresenceSchema),
  cursor: readerSchema(productLiveCursorSchema),
  hold: readerSchema(productLiveHoldSchema),
  release: readerSchema(productLiveReleaseSchema),
  gone: readerSchema(productLiveGoneSchema),
  wireframe: readerSchema(productLiveWireframeSchema),
};

/** I frame riconosciuti in un pezzo dello stream, nell'ordine; il resto si scarta. */
export function parseProductLiveFrame(raw: string): ProductLiveFrame[] {
  const out: ProductLiveFrame[] = [];
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue;
    let value: unknown;
    try {
      value = JSON.parse(line.slice("data:".length).trim());
    } catch {
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    const type = (value as { type?: unknown }).type;
    const reader = typeof type === "string" ? READERS[type] : undefined;
    if (!reader) continue;
    const parsed = reader.safeParse(value);
    if (parsed.success) out.push(parsed.data as ProductLiveFrame);
  }
  return out;
}

/** Il percorso dello stream di una pagina. */
export function productLiveStreamPath(pageId: string): string {
  return `/api/product-pages/${encodeURIComponent(pageId)}/live`;
}

const PRODUCT_LIVE_PATH_RE = /^\/api\/product-pages\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/live$/;

/**
 * L'allowlist dello stream di una pagina: SOLO lo stream di una pagina (uuid),
 * senza parametri. La usa il main di Electron prima di aprire una connessione
 * col token dell'utente, accanto a quelle delle sessioni e della Chat.
 */
export function isAllowedProductLiveStreamPath(path: string): boolean {
  return PRODUCT_LIVE_PATH_RE.test(path);
}
