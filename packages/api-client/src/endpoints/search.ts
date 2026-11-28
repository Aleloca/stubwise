import { z } from "zod";
import { searchDocsSemanticResultsSchema, searchHistoryItemSchema, searchResultsSchema } from "@stubwise/shared";
import type {
  Reader,
  RecordSearchHistoryBody,
  SearchDocsSemanticResults,
  SearchEntityType,
  SearchHistoryItem,
  SearchResults,
} from "@stubwise/shared";
import type { ApiRequest } from "../client.js";
import { toQuery } from "../query.js";

/**
 * Ricerca GLOBALE: federata su ticket, progetti, repository e docs — non è una
 * funzione del dominio Docs, ed è per questo che vive in un modulo suo invece
 * che sotto `client.docs`, dove il gruppo docs dei risultati la farebbe
 * sembrare tale.
 *
 * Due corsie che il chiamante FONDE: `global` è full-text ed è veloce,
 * `docsSemantic` è il retrieval vettoriale sui soli Docs ed è lenta ma
 * migliore. La seconda è best-effort lato server (mai un errore: lista vuota se
 * il retrieval non è disponibile), quindi si lancia in parallelo alla prima e si
 * fonde quando arriva.
 */
export function createSearchEndpoints(request: ApiRequest) {
  return {
    /**
     * `repositoryId` restringe SOLO il gruppo docs; gli altri restano globali.
     * `citable`: il gruppo docs delle sole pagine citabili, senza le note di
     * rilascio (il «#» e ⌘K del desktop).
     */
    global(q: string, repositoryId?: string, opts: { citable?: boolean } = {}): Promise<Reader<SearchResults>> {
      return request(
        "GET",
        `/api/search${toQuery({ q, repositoryId, citable: opts.citable ? "true" : undefined })}`,
        undefined,
        searchResultsSchema,
      );
    },

    /** Corsia semantica sui soli Docs, da fondere nel gruppo docs di `global`. */
    docsSemantic(q: string, repositoryId?: string): Promise<Reader<SearchDocsSemanticResults>> {
      return request(
        "GET",
        `/api/search/docs-semantic${toQuery({ q, repositoryId })}`,
        undefined,
        searchDocsSemanticResultsSchema,
      );
    },

    /**
     * La cronologia della ricerca di chi chiama: i risultati APERTI di recente
     * (non le query), dal più recente, filtrati a lettura dai permessi. Con
     * `repositoryId`, quelli di quello spazio Docs. La posta non c'è mai.
     */
    history(repositoryId?: string): Promise<Reader<SearchHistoryItem>[]> {
      return request("GET", `/api/search/history${toQuery({ repositoryId })}`, undefined, z.array(searchHistoryItemSchema));
    },

    /** Ricorda un risultato aperto (upsert per tipo e oggetto). 204. */
    remember(body: RecordSearchHistoryBody): Promise<void> {
      return request("POST", "/api/search/history", body);
    },

    /** Toglie una voce (idempotente). 204. */
    forget(type: SearchEntityType, entityId: string): Promise<void> {
      return request("DELETE", `/api/search/history/${encodeURIComponent(type)}/${encodeURIComponent(entityId)}`);
    },

    /** Svuota tutta la cronologia di chi chiama. 204. */
    clearHistory(): Promise<void> {
      return request("DELETE", "/api/search/history");
    },
  };
}
