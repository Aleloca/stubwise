import { ApiError } from "@stubwise/api-client";
import type * as Fake from "../../api";
import { appClient } from "./client";

// Le bozze di schermata nella build app (area 11, F6; R11-6), sulle forme di
// 72 (a2e2bd051, rotte 7388dc0cf). Il disegno è asincrono: il blocco nasce
// subito e lo SVG (già ripulito dal server) arriva con la pagina riletta al
// frame `wireframe` dello stream. Gli errori sono nelle parole del prototipo
// (`data/productDocs/wireframes.ts`). Dietro `product-claude-actions`, acceso il 22 nov 2026.

type ProductDocs = typeof Fake.productDocs;

function mapWireframeError(error: unknown): never {
  if (error instanceof ApiError) {
    if (error.code === "ai_blocked") throw new Error("ai_blocked");
    if (error.status === 422 && error.code?.startsWith("invalid_"))
      throw new Error(`invalid: ${error.code.slice("invalid_".length)}`);
    if (error.status === 403) throw new Error("forbidden");
    if (error.status === 404) throw new Error("not_found");
  }
  throw error;
}

export const liveProductWireframes: Partial<ProductDocs> = {
  async drawWireframe(pageId, at) {
    try {
      const { blockId } = await appClient().productDocs.drawWireframe(pageId, at);
      return { blockId };
    } catch (error) {
      return mapWireframeError(error);
    }
  },

  async redrawWireframe(pageId, blockId, fromVariant) {
    try {
      return await appClient().productDocs.redrawWireframe(pageId, blockId, fromVariant);
    } catch (error) {
      return mapWireframeError(error);
    }
  },

  async keepWireframe(pageId, blockId) {
    try {
      return await appClient().productDocs.keepWireframe(pageId, blockId);
    } catch (error) {
      return mapWireframeError(error);
    }
  },

  async replaceWireframeWithImage(pageId, blockId, image) {
    try {
      return await appClient().productDocs.replaceWireframeWithImage(pageId, blockId, image);
    } catch (error) {
      return mapWireframeError(error);
    }
  },
};
