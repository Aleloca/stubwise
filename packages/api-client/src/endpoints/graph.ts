import { repoGraphQueuedSchema, repoGraphStateSchema } from "@stubwise/shared";
import type { RepoGraphGenerateInput } from "@stubwise/shared";
import type { ApiRequest } from "../client.js";
import { seg } from "../query.js";

/**
 * Il grafo del codice di un repository (graphify; area 5, fetta 1 del
 * desktop): lo stato, la generazione (`force` = da zero), la PR di setup e il
 * resoconto. Chi può lo dice la rotta: leggere con `repos.view` nel progetto
 * (un lettore dei soli Docs riceve 403), agire con `repos.manage`. `html` e
 * `json` sono download di file e restano fuori.
 */
export function createGraphEndpoints(request: ApiRequest) {
  return {
    state(repositoryId: string) {
      return request("GET", `/api/repositories/${seg(repositoryId)}/graph`, undefined, repoGraphStateSchema);
    },
    /** 202 «in coda». */
    generate(repositoryId: string, input: RepoGraphGenerateInput = {}) {
      return request("POST", `/api/repositories/${seg(repositoryId)}/graph/generate`, input, repoGraphQueuedSchema);
    },
    /** La PR che aggiunge il setup del grafo al repository: 202 «in coda». */
    setupPr(repositoryId: string) {
      return request("POST", `/api/repositories/${seg(repositoryId)}/graph/setup-pr`, undefined, repoGraphQueuedSchema);
    },
    /** Il resoconto delle comunità, in Markdown (`text/markdown`). */
    report(repositoryId: string): Promise<string> {
      return request("GET", `/api/repositories/${seg(repositoryId)}/graph/report`);
    },
  };
}
