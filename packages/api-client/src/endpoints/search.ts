import { searchDocsSemanticResultsSchema, searchResultsSchema } from "@stubwise/shared";
import type { SearchDocsSemanticResults, SearchResults } from "@stubwise/shared";
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
    /** `repositoryId` restringe SOLO il gruppo docs; gli altri restano globali. */
    global(q: string, repositoryId?: string): Promise<SearchResults> {
      return request("GET", `/api/search${toQuery({ q, repositoryId })}`, undefined, searchResultsSchema);
    },

    /** Corsia semantica sui soli Docs, da fondere nel gruppo docs di `global`. */
    docsSemantic(q: string, repositoryId?: string): Promise<SearchDocsSemanticResults> {
      return request(
        "GET",
        `/api/search/docs-semantic${toQuery({ q, repositoryId })}`,
        undefined,
        searchDocsSemanticResultsSchema,
      );
    },
  };
}
