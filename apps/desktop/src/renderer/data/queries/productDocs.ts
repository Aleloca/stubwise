import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
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
export function useProductSpace(projectId: string, { enabled = true }: { enabled?: boolean } = {}) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: ["as", me, "productDocs", "space", projectId] as const,
    queryFn: () => api.productDocs.getProductSpace(projectId),
    enabled,
  });
}

/** La ricerca nelle pagine di prodotto (⌘K); con `projectId` solo in quello spazio. */
export function useProductSearch(q: string, projectId: string | null, enabled = true) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: ["as", me, "productDocs", "search", q, projectId] as const,
    queryFn: () => api.productDocs.searchProductPages(q, projectId ? { projectId } : {}),
    enabled: enabled && q.trim().length > 0,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === me ? keepPreviousData(previous) : undefined,
  });
}

/** Una pagina di prodotto per codice; `null` se non c'è per chi guarda. */
export function useProductPage(code: string, { enabled = true }: { enabled?: boolean } = {}) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: ["as", me, "productDocs", "page", code] as const,
    queryFn: () => api.productDocs.getProductPage(code),
    enabled,
  });
}

/**
 * La lettura dell'esportazione (Task 12, P20), al momento del gesto: una
 * pagina (`pageId`) o lo spazio intero, già risolti per chi esporta. Sempre
 * fresca (`staleTime: 0`): si esporta la pagina com'è adesso.
 */
export function useReadProductExport() {
  const me = useSessionPersonId();
  const client = useQueryClient();
  return useCallback(
    (projectId: string, { pageId }: { pageId?: string } = {}) =>
      client.fetchQuery({
        queryKey: ["as", me, "productDocs", "export", projectId, pageId ?? null] as const,
        queryFn: () => api.productDocs.getProductExport(projectId, pageId === undefined ? {} : { pageId }),
        staleTime: 0,
        retry: false,
      }),
    [client, me],
  );
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

/** La scrittura del corpo dall'editor; `undoOf` per ⌘Z / ⇧⌘Z dell'editor (Task 8). */
export function useSaveProductBlocks() {
  return useWrite(
    ({
      pageId,
      ops,
      sessionId,
      undoOf,
    }: {
      pageId: string;
      ops: ProductBlockOp[];
      sessionId: string;
      undoOf?: string;
    }) => api.productDocs.saveProductBlocks(pageId, ops, undoOf ? { sessionId, undoOf } : { sessionId }),
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

// --- i commenti (Task 4) -------------------------------------------------------

/**
 * Un commento cambia la pagina (i fili aperti nella barra) e l'inbox di chi
 * è menzionato; non cambia citazioni né Docs.
 */
const COMMENT_AREAS: readonly string[] = ["productDocs", "notifications"];

/** I fili di una pagina, aperti e risolti. */
export function useProductComments(pageId: string, { enabled = true }: { enabled?: boolean } = {}) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: ["as", me, "productDocs", "comments", pageId] as const,
    queryFn: () => api.productDocs.listProductComments(pageId),
    enabled,
  });
}

/**
 * Commenta o risponde. Un doppio clic riceve la stessa scrittura
 * (`addProductComment` tiene quelle in volo); la pagina spegne comunque
 * «Comment» con `isPending`.
 */
export function useAddProductComment() {
  return useWrite(
    ({
      pageId,
      ...input
    }: {
      pageId: string;
      anchorId: string;
      quote: string;
      body: string;
      replyToId?: string;
    }) => api.productDocs.addProductComment(pageId, input),
    COMMENT_AREAS,
  );
}

export function useResolveProductComment() {
  return useWrite((rootId: string) => api.productDocs.resolveProductComment(rootId), COMMENT_AREAS);
}

export function useReopenProductComment() {
  return useWrite((rootId: string) => api.productDocs.reopenProductComment(rootId), COMMENT_AREAS);
}

/** Chi si può menzionare nel progetto (chi ne legge i Docs), per «@». */
export function useProductMentionCandidates(projectId: string, q: string) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: ["as", me, "productDocs", "mentionCandidates", projectId, q] as const,
    queryFn: () => api.productDocs.productMentionCandidates(projectId, q),
  });
}

// --- la presenza e la scrittura dal vivo (Task 5) -------------------------------

/**
 * Gli altri presenti nella pagina (non chi guarda), dal vivo: l'iscrizione
 * alla pagina ricarica la presenza a ogni `presence`; `blocks` e `comments`
 * ricaricano pagina, commenti e cronologia; `gone` tutto lo spazio Prodotto
 * di chi guarda (la pagina dice «non trovata», l'albero la perde).
 */
export function useProductPresence(pageId: string) {
  const me = useSessionPersonId();
  const client = useQueryClient();
  useEffect(() => {
    const area = ["as", me, "productDocs"] as const;
    return api.productDocs.subscribeProductPage(pageId, (event) => {
      if (event === "presence") {
        void client.invalidateQueries({ queryKey: [...area, "presence", pageId] });
        return;
      }
      if (event === "gone") {
        void client.invalidateQueries({ queryKey: area });
        return;
      }
      void client.invalidateQueries({ queryKey: [...area, "page"] });
      void client.invalidateQueries({ queryKey: [...area, "comments", pageId] });
      void client.invalidateQueries({ queryKey: [...area, "revisions", pageId] });
    });
  }, [client, me, pageId]);
  return useQuery({
    queryKey: ["as", me, "productDocs", "presence", pageId] as const,
    queryFn: () => api.productDocs.getProductPresence(pageId),
  });
}

/**
 * Entra nella pagina al montaggio (e avvia il suo copione) ed esce allo
 * smontaggio, al cambio di pagina e al cambio di persona. L'uscita nomina la
 * persona di quando si è entrati: al cambio col «vedi come» la sessione è
 * già dell'altra. Un ingresso ancora in volo quando si esce si ritira appena
 * arriva, così nessuna presenza resta appesa.
 */
export function useJoinProductPage(pageId: string | null) {
  const me = useSessionPersonId();
  useEffect(() => {
    if (!pageId) return;
    let left = false;
    api.productDocs.joinProductPage(pageId).then(
      () => {
        if (left) api.productDocs.leaveProductPageAs(me, pageId);
      },
      // Una pagina che chi guarda non legge: niente presenza, la pagina lo dice da sé.
      () => undefined,
    );
    return () => {
      left = true;
      api.productDocs.leaveProductPageAs(me, pageId);
    };
  }, [me, pageId]);
}

/**
 * Dove scrive chi guarda (`null` = c'è ma non scrive). Nessuna area da
 * ricaricare: la presenza la porta l'iscrizione (`useProductPresence`).
 */
export function useSetProductPresence() {
  return useMutation({
    mutationFn: ({
      pageId,
      at,
    }: {
      pageId: string;
      at: { anchorId: string; offset: number; selection?: [number, number] | null } | null;
    }) => api.productDocs.setProductPresence(pageId, at),
  });
}
