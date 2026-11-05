import { useQuery } from "@tanstack/react-query";
import * as api from "../api";
import { PROJECT_AREAS, useSessionPersonId, useWrite } from "../queries";
import type { ProductBlockOp } from "../types";

// Gli hook dello spazio Prodotto (area 11a); `data/queries` li ri-esporta.
// Le letture stanno nell'area «productDocs». Una scrittura di prodotto
// ricarica anche citazioni, codici e «#» (una pagina tolta, rinominata o
// cambiata deve cambiare anche lì, R-G5) e i Docs (la pagina iniziale conta
// le pagine di prodotto). L'import circolare con `../queries` è innocuo: gli
// helper si usano solo dentro le funzioni (per questo le aree che nominano
// `PROJECT_AREAS` sono funzioni, non costanti di modulo).

const PRODUCT_AREAS: readonly string[] = [
  "productDocs",
  "docs",
  "citations",
  "codeCitations",
  "mentions",
];
/** Seguire cambia solo la pagina e chi la segue. */
const FOLLOW_AREAS: readonly string[] = ["productDocs"];
/** Il modulo Docs cambia la colonna del progetto, le impostazioni e il registro (ruling P35). */
const docsModuleAreas = (): readonly string[] => [
  ...PRODUCT_AREAS,
  ...PROJECT_AREAS,
  "projectSettings",
  "changelog",
  "search",
];

/** Lo spazio Prodotto di un progetto; `null` dove non esiste per chi guarda. */
export function useProductSpace(projectId: string) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: ["as", me, "productDocs", "space", projectId] as const,
    queryFn: () => api.productDocs.getProductSpace(projectId),
  });
}

/** Una pagina di prodotto per codice; `null` se non c'è per chi guarda. */
export function useProductPage(code: string) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: ["as", me, "productDocs", "page", code] as const,
    queryFn: () => api.productDocs.getProductPage(code),
  });
}

/** La cronologia di una pagina, dalla più recente. */
export function useProductRevisions(pageId: string) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: ["as", me, "productDocs", "revisions", pageId] as const,
    queryFn: () => api.productDocs.listProductRevisions(pageId),
  });
}

export function useCreateProductPage() {
  return useWrite(
    ({
      projectId,
      ...input
    }: {
      projectId: string;
      title: string;
      parentId?: string | null;
      index?: number;
    }) => api.productDocs.createProductPage(projectId, input),
    PRODUCT_AREAS,
  );
}

export function useRenameProductPage() {
  return useWrite(
    ({ pageId, title }: { pageId: string; title: string }) =>
      api.productDocs.renameProductPage(pageId, title),
    PRODUCT_AREAS,
  );
}

export function useMoveProductPage() {
  return useWrite(
    ({ pageId, parentId, index }: { pageId: string; parentId: string | null; index: number }) =>
      api.productDocs.moveProductPage(pageId, { parentId, index }),
    PRODUCT_AREAS,
  );
}

export function useDeleteProductPage() {
  return useWrite((pageId: string) => api.productDocs.deleteProductPage(pageId), PRODUCT_AREAS);
}

export function useSaveProductBlocks() {
  return useWrite(
    ({ pageId, ops, sessionId }: { pageId: string; ops: ProductBlockOp[]; sessionId: string }) =>
      api.productDocs.saveProductBlocks(pageId, ops, { sessionId }),
    PRODUCT_AREAS,
  );
}

export function useFollowProductPage() {
  return useWrite((pageId: string) => api.productDocs.followProductPage(pageId), FOLLOW_AREAS);
}

export function useUnfollowProductPage() {
  return useWrite((pageId: string) => api.productDocs.unfollowProductPage(pageId), FOLLOW_AREAS);
}

/** L'interruttore «Docs» di General (Q4): risponde `ProjectResult`, come le altre impostazioni. */
export function useSetDocsModule() {
  return useWrite(
    ({ projectId, on }: { projectId: string; on: boolean }) =>
      api.projectSettings.setDocsModule(projectId, on),
    docsModuleAreas(),
  );
}
