import { releasePipelineSchema, repositorySchema } from "@stubwise/shared";
import type { z } from "zod";
import type { Reader, Repository } from "@stubwise/shared";
import type { ApiRequest } from "../client.js";
import { seg } from "../query.js";

/**
 * Un repository, in SOLA LETTURA (22 set 2026, hub di progetto, tappa 2).
 *
 * L'ELENCO non è qui e non serve: la proiezione sintetica dei repository di un
 * progetto (`id`, `name`, `slug`, `provider`) arriva già dentro
 * `projects.get` — chiedere una seconda lista sarebbe una richiesta in più
 * per gli stessi dati.
 *
 * ⚠️ **Nessun metodo di scrittura, ed è una scelta di prodotto**: configurare
 * un repository (credenziali, webhook, comandi, grafo) si fa da un computer.
 * Chi aggiunge qui una `create`/`patch` stia aggiungendo una superficie
 * nuova, non completando questa.
 *
 * ⚠️ **Il segreto HMAC del webhook NON è in `repositorySchema`** e non passa
 * di qui: permetterebbe di forgiare webhook di merge e forzare i ticket a
 * `done`. Si legge solo dalla rotta admin dedicata, che questo pacchetto non
 * mappa. Lo stesso vale per i file d'ambiente del progetto, che vivono
 * altrove e restano fuori dall'app (design §8).
 */
export function createRepositoriesEndpoints(request: ApiRequest) {
  return {
    /**
     * Un repository dal suo SLUG — non dall'id: è così che la rotta lo
     * indirizza (`GET /api/repositories/:slug`), e lo slug è quello che la
     * proiezione sintetica di `projects.get` porta con sé.
     */
    get(slug: string): Promise<Reader<Repository>> {
      return request("GET", `/api/repositories/${seg(slug)}`, undefined, repositorySchema);
    },
    /**
     * Area 8, F1: le impostazioni di rilascio del repository (`repos.manage`):
     * il ramo di rilascio (null = il default), la pipeline che conta, il
     * provider della CI e le PR dei colleghi. Solo questi campi: il resto del
     * repository (credenziali, webhook) non passa da qui.
     */
    updateReleaseSettings(
      slug: string,
      patch: {
        releaseBranch?: string | null;
        releasePipeline?: z.input<typeof releasePipelineSchema>;
        ciProvider?: "github_actions" | "bitbucket_pipelines" | null;
        colleaguePrs?: "analyze_and_fix" | "analyze_only" | "off";
      },
    ): Promise<Reader<Repository>> {
      return request("PATCH", `/api/repositories/${seg(slug)}`, patch, repositorySchema);
    },
  };
}
