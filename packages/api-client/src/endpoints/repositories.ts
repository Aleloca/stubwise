import { detachedRepositorySchema, releasePipelineSchema, repositorySaveResponseSchema, repositorySchema, webhookSecretResultSchema } from "@stubwise/shared";
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
 * le impostazioni di rilascio (area 8), la rigenerazione del segreto del
 * webhook (area 9, F5) e, col ritiro del web vecchio (inventario §1.3), la
 * pagina Repositories intera: creare, modificare i dettagli, configurare il
 * webhook, i file d'ambiente. Il mobile non le chiama.
 *
 * ⚠️ **Il segreto HMAC del webhook NON è in `repositorySchema`** e non passa
 * di qui: permetterebbe di forgiare webhook di merge e forzare i ticket a
 * `done`. Si legge solo dalla rotta admin dedicata, che questo pacchetto non
 * mappa (la creazione lo restituisce una volta: `repositorySaveResponseSchema`
 * non lo ha, quindi il parse lo scarta). Dei file d'ambiente passano i
 * NOMI delle variabili e quando sono state scritte, mai i valori.
 */

/** Un file d'ambiente come lo dà il server: nomi delle variabili, mai i valori. */
export const envFileSchema = z.object({
  id: z.uuid(),
  environmentId: z.uuid(),
  path: z.string(),
  vars: z.array(z.object({ key: z.string(), setAt: z.iso.datetime().optional() })),
});

/** L'esito di un import: `replaced` e `skipped` mancano da un server di prima. */
export const envImportResultSchema = z.object({
  count: z.number().int(),
  imported: z.array(z.string()),
  replaced: z.array(z.string()).default([]),
  skipped: z.array(z.object({ line: z.number().int(), reason: z.string() })).default([]),
});

/** L'esito di «Configure automatically» (il segreto e le credenziali non escono mai). */
export const configureWebhookResultSchema = z.object({
  ok: z.literal(true),
  created: z.boolean(),
  updated: z.boolean(),
  detail: z.string(),
  url: z.string(),
});

/** Il corpo della creazione (`repos.manage` nel progetto e `git_accounts.manage`). */
export interface CreateRepositoryInput {
  projectId: string;
  name: string;
  gitAccountId: string;
  repoUrl: string;
  defaultBranch: string;
  testCommand?: string | null;
  installCommand?: string | null;
}

/** I campi della pagina del repository (patch: gli assenti restano invariati). */
export interface UpdateRepositoryInput {
  name?: string;
  repoUrl?: string;
  gitAccountId?: string;
  reviewGitAccountId?: string | null;
  testCommand?: string | null;
  installCommand?: string | null;
  graphEnabled?: boolean;
  protectedBranches?: string[];
  releaseBranch?: string | null;
}
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
     * Registro, A5 r.209: accende o spegne il grafo del repository
     * (`repos.manage`): solo `graphEnabled`, il resto resta invariato (patch).
     */
    setGraphEnabled(slug: string, enabled: boolean): Promise<Reader<Repository>> {
      return request("PATCH", `/api/repositories/${seg(slug)}`, { graphEnabled: enabled }, repositorySchema);
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
     * Ritiro del web vecchio: crea un repository nel progetto. 403 senza
     * `git_accounts.manage` (scegliere l'account è una decisione d'istanza).
     * Il segreto del webhook della risposta non arriva al chiamante.
     */
    create(input: CreateRepositoryInput) {
      return request("POST", "/api/repositories", input, repositorySaveResponseSchema);
    },
    /** I dettagli della pagina del repository; cambiare l'account vuole `git_accounts.manage`. */
    update(slug: string, patch: UpdateRepositoryInput) {
      return request("PATCH", `/api/repositories/${seg(slug)}`, patch, repositorySaveResponseSchema);
    },
    /** «Configure automatically» del webhook (`repos.manage`); 422 `git_provider_error` col messaggio della piattaforma. */
    configureWebhook(slug: string) {
      return request("POST", `/api/repositories/${seg(slug)}/configure-webhook`, undefined, configureWebhookResultSchema);
    },
    /** I file d'ambiente del repository (`repos.manage`), di tutti gli ambienti. */
    envFiles(repositoryId: string) {
      return request("GET", `/api/repositories/${seg(repositoryId)}/env-files`, undefined, z.array(envFileSchema));
    },
    /** Un file vuoto in un ambiente (nessuna riconferma). 409 se il percorso c'è già. */
    createEnvFile(repositoryId: string, input: { environmentId: string; path: string }) {
      return request("POST", `/api/repositories/${seg(repositoryId)}/env-files`, input, envFileSchema);
    },
    /** Importa un testo `.env` (riconferma). Il testo va al server e non torna. */
    importEnvFile(repositoryId: string, fileId: string, content: string) {
      return request("POST", `/api/repositories/${seg(repositoryId)}/env-files/${seg(fileId)}/import`, { content }, envImportResultSchema);
    },
    /** Imposta una variabile (riconferma): il valore va al server e non torna. */
    setEnvVar(repositoryId: string, fileId: string, key: string, value: string): Promise<void> {
      return request("PUT", `/api/repositories/${seg(repositoryId)}/env-files/${seg(fileId)}/vars/${seg(key)}`, { value }).then(() => undefined);
    },
    /** Toglie una variabile (riconferma). */
    removeEnvVar(repositoryId: string, fileId: string, key: string): Promise<void> {
      return request("DELETE", `/api/repositories/${seg(repositoryId)}/env-files/${seg(fileId)}/vars/${seg(key)}`);
    },
    /** Elimina un file e le sue variabili (riconferma). */
    deleteEnvFile(repositoryId: string, fileId: string): Promise<void> {
      return request("DELETE", `/api/repositories/${seg(repositoryId)}/env-files/${seg(fileId)}`);
    },
    /**
     * Area 9, F6: i repository senza progetto (Amministrazione). 403 a chi non
     * ha `repos.manage` in nessun progetto e non è full admin.
     */
    detached(): Promise<Reader<DetachedRepository>[]> {
      return request("GET", "/api/repositories/detached", undefined, z.array(detachedRepositorySchema));
    },
    /** Collega uno staccato a un progetto (`repos.manage` lì). 409 `name_taken` / `not_detached`; 404 `target_not_found` (la destinazione) o `not_found` (il repository). */
    link(id: string, projectId: string): Promise<void> {
      return request("POST", `/api/repositories/${seg(id)}/link`, { projectId });
    },
    /** Elimina uno staccato: solo un full admin, con la riconferma. 409 `not_detached`. */
    deleteDetached(id: string): Promise<void> {
      return request("DELETE", `/api/repositories/${seg(id)}`);
    },
  };
}
