import { ApiError } from "@stubwise/api-client";
import { isUnknown } from "@stubwise/shared";
import type { DocPageKind, DocSpace, DocsChatAnswer, DocTreeNode, Reader } from "@stubwise/shared";
import { useMutation } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { useAuth } from "../app/providers";
import { useIsOnline } from "./inbox-mutations";

/** Chiavi di query dello screen Docs (Task 18). */
export const docsKeys = {
  all: ["docs"] as const,
  spaces: (projectId: string) => [...docsKeys.all, "spaces", projectId] as const,
  tree: (repositoryId: string) => [...docsKeys.all, "tree", repositoryId] as const,
  page: (repositoryId: string, slug: string) => [...docsKeys.all, "page", repositoryId, slug] as const,
  search: (repositoryId: string, q: string) => [...docsKeys.all, "search", repositoryId, q] as const,
};

/**
 * Lo spazio doc "principale" di un progetto: quello con più pagine — STESSA
 * euristica di `mainSpace` in `apps/web/src/routes/docs/project.$projectId.tsx`
 * (la home Docs di progetto sul web). Il canvas mobile (`3f`) mostra UN solo
 * switcher ("Portale B2B ▾", un PROGETTO — vedi il fixture `PROJECT` di
 * `BacklogScreen.test.tsx`/`CaptureSheet.test.tsx`, stesso nome), non un
 * secondo picker per repository: `DocsScreen` sfoglia e cerca nello spazio
 * principale del progetto scelto, senza esporre uno switcher di repository
 * proprio — coerente col canvas, che non ne mostra uno.
 *
 * `undefined` se il progetto non ha ancora spazi documentati (nessun
 * repository con almeno una pagina, vedi il commento su `docSpaceSchema`).
 */
export function mainDocSpace(spaces: Reader<DocSpace>[]): Reader<DocSpace> | undefined {
  return [...spaces].sort((a, b) => b.pageCount - a.pageCount)[0];
}

/** Un gruppo di «Oppure sfoglia»: le pagine di un kind, contate e in ordine di posizione. */
export interface DocsKindGroup {
  count: number;
  nodes: Reader<DocTreeNode>[];
}

/** Come {@link DocsKindGroup}, per il gruppo "Note di rilascio": porta anche l'ULTIMA release. */
export interface DocsReleaseGroup extends DocsKindGroup {
  latest: Reader<DocTreeNode> | null;
}

/**
 * I tre gruppi di «Oppure sfoglia» (canvas `3f`): "Guida funzionale" (kind
 * `functional`), "Note di rilascio" (kind `releases`) e "Pagine tecniche"
 * (kind `technical`) — SOLO questi tre, come nel canvas: `product` e `manual`
 * non hanno un gruppo qui (nessuna riga per loro nel mockup). Un kind
 * Unknown (server più nuovo di questa build, vedi
 * `packages/shared/src/reader.ts`) non entra in nessun gruppo — non un
 * crash, un conteggio che semplicemente lo ignora.
 *
 * `functional`/`technical` restano nell'ordine dell'albero (già ordinato per
 * `position` dal server); `releases` è riordinato per `createdAt`
 * DECRESCENTE così `latest` è sempre la release più recente, non l'ultima
 * della lista in arrivo.
 */
export function groupTreeByKind(nodes: Reader<DocTreeNode>[]): {
  functional: DocsKindGroup;
  technical: DocsKindGroup;
  releases: DocsReleaseGroup;
} {
  const functional = nodes.filter((n) => n.kind === "functional");
  const technical = nodes.filter((n) => n.kind === "technical");
  const releases = nodes
    .filter((n) => n.kind === "releases")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return {
    functional: { count: functional.length, nodes: functional },
    technical: { count: technical.length, nodes: technical },
    releases: { count: releases.length, nodes: releases, latest: releases[0] ?? null },
  };
}

const KIND_LABEL_KEYS: Record<DocPageKind, string> = {
  technical: "mobile.docs.kind.technical",
  functional: "mobile.docs.kind.functional",
  product: "mobile.docs.kind.product",
  manual: "mobile.docs.kind.manual",
  releases: "mobile.docs.kind.releases",
};

/**
 * Etichetta i18n di un `kind` letto DA `Reader<DocPageKind>` — stesso
 * principio di `backlogStatusLabelKey` in `lib/backlog-mutations.ts`: mai
 * indicizzare `KIND_LABEL_KEYS` direttamente su un valore `Reader`, sempre
 * passare da qui, che gestisce il segnaposto Unknown di un server più nuovo.
 */
export function docsKindLabelKey(kind: Reader<DocPageKind>): string {
  return isUnknown(kind) ? "mobile.docs.kind.unknown" : KIND_LABEL_KEYS[kind];
}

/**
 * Messaggio d'errore di un'azione Docs, dal solo `code` — stessa cautela di
 * `describeBacklogError` (mai da `error.message`, inglese e non contratto).
 * `chat_unavailable` (503, nessun provider AI con chiave API) è il caso
 * ANALOGO alla guardia `codeSession` del backlog (Task 17): un dato lato
 * server che implica un ramo di comportamento diverso, qui semplicemente un
 * messaggio dedicato invece del generico.
 */
export function describeDocsError(error: unknown, t: TFunction): string {
  if (!(error instanceof ApiError)) return t("mobile.docs.errors.generic");
  switch (error.code) {
    case "chat_unavailable":
      return t("mobile.docs.errors.chatUnavailable");
    case "project_not_found":
      return t("mobile.docs.errors.notFound");
    default:
      return t("mobile.docs.errors.generic");
  }
}

export interface DocsActionMutation<TInput, TResult> {
  mutate: (input: TInput, options?: { onSuccess?: (result: TResult) => void }) => void;
  isPending: boolean;
  disabled: boolean;
  online: boolean;
  errorMessage: string | null;
  reset: () => void;
}

/**
 * Un turno della chat «Chiedi al progetto» (`projectChat`, `?stream=false`,
 * fase 4 mobile): risposta JSON completa — vedi il commento su `chat`/
 * `projectChat` in `packages/api-client/src/endpoints/docs.ts`. A differenza
 * di `useSendBacklogChatMessage` (backlog: sessionId = l'id della voce, mai
 * passato a mano) questa è una VERA conversazione a sessione: il CHIAMANTE
 * (`AskProjectScreen`) deve rileggere `sessionId` dalla risposta e ripassarlo
 * al turno successivo — altrimenti ogni messaggio aprirebbe una sessione
 * nuova, perdendo il contesto dei turni precedenti (multi-turno, non
 * singolo: vedi il commento in testa a `AskProjectScreen.tsx`).
 */
export function useAskProjectChat(): DocsActionMutation<
  { projectId: string; message: string; sessionId?: string },
  Reader<DocsChatAnswer>
> {
  const { client } = useAuth();
  const online = useIsOnline();
  const { t } = useTranslation();

  const mutation = useMutation({
    mutationFn: (input: { projectId: string; message: string; sessionId?: string }) => {
      if (!client) return Promise.reject(new Error("useAskProjectChat richiede un client autenticato"));
      return client.docs.projectChat(input.projectId, { message: input.message, sessionId: input.sessionId });
    },
  });

  return {
    mutate: (input, options) => mutation.mutate(input, options),
    isPending: mutation.isPending,
    disabled: !online || mutation.isPending,
    online,
    errorMessage: mutation.error ? describeDocsError(mutation.error, t) : null,
    reset: () => mutation.reset(),
  };
}
