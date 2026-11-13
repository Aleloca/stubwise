import {
  projectEnvironmentSchema,
  type CreateEnvironmentInput,
  type MyReleases,
  type OpenPull,
  type PatchEnvironmentInput,
  type PrReleaseNotes,
  type ProjectEnvironment,
  type Reader,
  type ReleaseDetail,
  type ReleaseFixResult,
  type ReleaseQueueItem,
  type ReleaseRow,
} from "@stubwise/shared";
import { z } from "zod";
import type { ApiRequest } from "../client.js";
import { seg } from "../query.js";

/**
 * I rilasci e le PR aperte (area 8, F1). Le forme sono i tipi di
 * `@stubwise/shared/releases`, calcolati dal server (stato derivato,
 * prontezza, permessi per chi guarda): il client li legge, non li deduce. Un
 * progetto che non si vede è 404. Il merge resta `tickets.release` e
 * «Chiedi modifiche» `tickets.requestCorrection`.
 */
export function createReleaseEndpoints(request: ApiRequest) {
  return {
    /** I rilasci di un progetto, dal più recente. */
    list(projectId: string): Promise<{ items: ReleaseRow[] }> {
      return request("GET", `/api/projects/${seg(projectId)}/releases`);
    },
    /** Un rilascio per codice (`AUD-V7`). */
    get(code: string): Promise<ReleaseDetail> {
      return request("GET", `/api/releases/${seg(code)}`);
    },
    /** «Fai sistemare a Claude»: 201 una task nuova, 200 quella già aperta (`existing`). */
    fix(code: string, body: { note?: string; start?: boolean } = {}): Promise<ReleaseFixResult> {
      return request("POST", `/api/releases/${seg(code)}/fix`, body);
    },
    /** Le PR aperte del progetto, a chi lo vede. */
    pulls(projectId: string): Promise<{ items: OpenPull[] }> {
      return request("GET", `/api/projects/${seg(projectId)}/pulls`);
    },
    /**
     * La coda di chi ha `release.merge` (vuota per gli altri). Corsia grezza:
     * lo stato dei controlli è una union di literal (fase 8) che `readerSchema`
     * non apre senza cambiare quale opzione vince.
     */
    queue(): Promise<{ items: ReleaseQueueItem[] }> {
      return request("GET", "/api/release-queue");
    },
    /** La Home «Rilasci». */
    mine(): Promise<MyReleases> {
      return request("GET", "/api/me/releases");
    },
    /** Le note di una PR: il testo salvato, la bozza calcolata, `canEdit`. */
    releaseNotes(repositoryId: string, prNumber: number): Promise<PrReleaseNotes> {
      return request("GET", `/api/repositories/${seg(repositoryId)}/pulls/${prNumber}/release-notes`);
    },
    putReleaseNotes(repositoryId: string, prNumber: number, body: string): Promise<PrReleaseNotes> {
      return request("PUT", `/api/repositories/${seg(repositoryId)}/pulls/${prNumber}/release-notes`, { body });
    },
    /** «Solo analisi» su una PR di un collega (`prs.adopt`). */
    analysisOnly(repositoryId: string, prNumber: number, on: boolean): Promise<{ analysisOnly: { byId: string | null; at: string } | null }> {
      return request(on ? "POST" : "DELETE", `/api/repositories/${seg(repositoryId)}/pulls/${prNumber}/analysis-only`);
    },
  };
}

/** Gli ambienti di un progetto, coi server per repository (area 8, F1, R-L2). */
export function createEnvironmentEndpoints(request: ApiRequest) {
  return {
    list(projectId: string): Promise<Reader<ProjectEnvironment[]>> {
      return request("GET", `/api/projects/${seg(projectId)}/environments`, undefined, z.array(projectEnvironmentSchema));
    },
    create(projectId: string, body: CreateEnvironmentInput): Promise<Reader<ProjectEnvironment>> {
      return request("POST", `/api/projects/${seg(projectId)}/environments`, body, projectEnvironmentSchema);
    },
    update(projectId: string, environmentId: string, patch: PatchEnvironmentInput): Promise<Reader<ProjectEnvironment>> {
      return request("PATCH", `/api/projects/${seg(projectId)}/environments/${seg(environmentId)}`, patch, projectEnvironmentSchema);
    },
    remove(projectId: string, environmentId: string): Promise<void> {
      return request("DELETE", `/api/projects/${seg(projectId)}/environments/${seg(environmentId)}`);
    },
  };
}
