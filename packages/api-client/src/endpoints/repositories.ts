import { detachedRepositorySchema, releasePipelineSchema, repositorySchema, webhookSecretResultSchema } from "@stubwise/shared";
import { z } from "zod";
import type { DetachedRepository, Reader, Repository, WebhookSecretResult } from "@stubwise/shared";
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
 * ⚠️ **Le scritture sono poche e nominate, ed è una scelta di prodotto**:
 * l'app mobile non configura un repository (credenziali, webhook, comandi,
 * grafo). Le eccezioni servono all'app desktop e hanno un metodo ciascuna:
 * le impostazioni di rilascio (area 8) e la rigenerazione del segreto del
 * webhook (area 9, F5). Chi aggiunge qui una `create`/`patch` generica stia
 * aggiungendo una superficie nuova, non completando questa.
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
    /**
     * Area 8, F1: i repository (di un progetto, con `projectId`), con le
     * impostazioni di rilascio. Le regole di visibilità sono quelle della
     * rotta: chi ha il solo `docs.view` riceve la configurazione ai valori
     * neutri.
     */
    list(projectId?: string): Promise<Reader<Repository[]>> {
      return request(
        "GET",
        `/api/repositories${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`,
        undefined,
        z.array(repositorySchema),
      );
    },
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
    /**
     * Area 9, F5: un segreto del webhook git nuovo (`repos.manage`,
     * riconferma). Il segreto si legge solo qui (`manual` e `platform`); con
     * `rollback` resta il vecchio. 422 `webhook_scope_missing`, 502
     * `platform_update_failed`: resta il vecchio. Il segreto ATTUALE non passa
     * mai di qui (vedi sopra).
     */
    regenerateWebhookSecret(slug: string): Promise<Reader<WebhookSecretResult>> {
      return request("POST", `/api/repositories/${seg(slug)}/webhook-secret`, undefined, webhookSecretResultSchema);
    },
    /**
     * Area 9, F6: i repository senza progetto (Amministrazione). 403 a chi non
     * ha `repos.manage` in nessun progetto e non è full admin.
     */
    detached(): Promise<Reader<DetachedRepository>[]> {
      return request("GET", "/api/repositories/detached", undefined, z.array(detachedRepositorySchema));
    },
    /** Collega uno staccato a un progetto (`repos.manage` lì). 409 `name_taken` / `not_detached`. */
    link(id: string, projectId: string): Promise<void> {
      return request("POST", `/api/repositories/${seg(id)}/link`, { projectId });
    },
    /** Elimina uno staccato: solo un full admin, con la riconferma. 409 `not_detached`. */
    deleteDetached(id: string): Promise<void> {
      return request("DELETE", `/api/repositories/${seg(id)}`);
    },
  };
}
