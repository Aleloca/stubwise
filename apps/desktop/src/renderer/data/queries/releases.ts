import { keepPreviousData, useQuery } from "@tanstack/react-query";
import * as api from "../api";
import { MIN_QUERY } from "../../pages/chat/search";
import {
  CONVERSATION_AREAS,
  queryKeys,
  RUN_AREAS,
  TASK_AREAS,
  useConversationChanges,
  useSessionPersonId,
  useWrite,
} from "../queries";

// Gli hook di questa parte dell'area 8a; `data/queries` li ri-esporta.
// L'import circolare con `../queries` è innocuo: gli helper si usano solo
// dentro le funzioni.

// --- Rilasci, PR e ambienti (area 8a) ---------------------------------------------

/**
 * Le scritture dei rilasci cambiano liste, coda, dettaglio e Home (area
 * «releases»), e possono pubblicare avvisi (campanella).
 */
const RELEASE_AREAS = ["releases", "notifications"] as const;
/**
 * Gli ambienti dicono anche quali server ha un progetto (R-L2): le loro
 * scritture ricaricano pure l'area «servers».
 */
const ENVIRONMENT_AREAS = [...RELEASE_AREAS, "servers"] as const;
/**
 * «Fai sistemare a Claude» crea una task e può far partire Claude. Una
 * funzione, non una costante: `RUN_AREAS` viene da `../queries`, che a sua
 * volta carica questo modulo (l'import è circolare).
 */
const fixReleaseAreas = () => [...RELEASE_AREAS, ...RUN_AREAS];

/** Le PR aperte del progetto, di Stubwise e dei colleghi. */
export function useOpenPrs(projectId: string | undefined) {
  const me = useSessionPersonId();
  useConversationChanges();
  return useQuery({
    queryKey: queryKeys.openPrs(me, projectId ?? ""),
    queryFn: () => api.releases.listOpenPrs(projectId!),
    enabled: !!projectId,
  });
}

/** «Pronte per il rilascio». */
export function useReleaseQueue(projectId: string | undefined) {
  const me = useSessionPersonId();
  useConversationChanges();
  return useQuery({
    queryKey: queryKeys.releaseQueue(me, projectId ?? ""),
    queryFn: () => api.releases.listReleaseQueue(projectId!),
    enabled: !!projectId,
  });
}

export function useReleases(projectId: string | undefined) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.releases(me, projectId ?? ""),
    queryFn: () => api.releases.listReleases(projectId!),
    enabled: !!projectId,
  });
}

/** Il dettaglio di un rilascio (`null`: nascosto o inesistente, R-G5). */
export function useRelease(code: string | undefined) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.release(me, code ?? ""),
    queryFn: () => api.releases.getRelease(code!),
    enabled: !!code,
  });
}

export function useEnvironments(projectId: string | undefined) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.environments(me, projectId ?? ""),
    queryFn: () => api.releases.listEnvironments(projectId!),
    enabled: !!projectId,
  });
}

/** ⌘K: i rilasci per codice o titolo (da 2 caratteri, R-G5 nel livello dati). */
export function useReleaseSearch(q: string, enabled = true) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.releaseSearch(me, q),
    queryFn: () => api.releases.searchReleases(q),
    enabled: enabled && q.trim().length >= MIN_QUERY,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === me ? keepPreviousData(previous) : undefined,
  });
}

/** Il blocco «Rilasci» della Home. */
export function useMyReleases() {
  const me = useSessionPersonId();
  useConversationChanges();
  return useQuery({
    queryKey: queryKeys.myReleases(me),
    queryFn: () => api.releases.listMyReleases(),
  });
}

export function useRepositorySettings(projectId: string | undefined) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.repositorySettings(me, projectId ?? ""),
    queryFn: () => api.releases.getRepositorySettings(projectId!),
    enabled: !!projectId,
  });
}

/** «Rilascia» (conferma a due tempi nella UI): l'esito è un codice, come sul web. */
export function useMergePr() {
  return useWrite((prId: string) => api.releases.mergePr(prId), [...RELEASE_AREAS, ...TASK_AREAS]);
}

export function useSetRepoPrMode() {
  return useWrite(
    ({
      repositoryId,
      mode,
    }: {
      repositoryId: string;
      mode: Parameters<typeof api.releases.setRepoPrMode>[1];
    }) => api.releases.setRepoPrMode(repositoryId, mode),
    RELEASE_AREAS,
  );
}

export function useSetReleasePipeline() {
  return useWrite(
    ({
      repositoryId,
      pipeline,
      branch,
    }: {
      repositoryId: string;
      pipeline: Parameters<typeof api.releases.setReleasePipeline>[1];
      branch: string;
    }) => api.releases.setReleasePipeline(repositoryId, pipeline, branch),
    RELEASE_AREAS,
  );
}

export function useSetPrAnalysisOnly() {
  return useWrite(
    ({ prId, on }: { prId: string; on: boolean }) => api.releases.setPrAnalysisOnly(prId, on),
    RELEASE_AREAS,
  );
}

/** «Chiedi modifiche» su una PR di un collega: `needs_maintainer` oltre il tetto. */
export function useRequestPrCorrection() {
  return useWrite(
    ({ prId, text }: { prId: string; text: string }) =>
      api.releases.requestPrCorrection(prId, text),
    // Su una PR di Stubwise nasce una sessione della task.
    [...RELEASE_AREAS, ...RUN_AREAS],
  );
}

export function useFixRelease() {
  return useWrite(
    ({ code, note }: { code: string; note?: string }) => api.releases.fixRelease(code, note),
    fixReleaseAreas(),
  );
}

export function useExplainRelease() {
  return useWrite((code: string) => api.releases.explainRelease(code), CONVERSATION_AREAS);
}

export function useCreateEnvironment() {
  return useWrite(
    ({ projectId, input }: { projectId: string; input: api.releases.EnvironmentInput }) =>
      api.releases.createEnvironment(projectId, input),
    ENVIRONMENT_AREAS,
  );
}

export function useUpdateEnvironment() {
  return useWrite(
    ({ id, patch }: { id: string; patch: Partial<api.releases.EnvironmentInput> }) =>
      api.releases.updateEnvironment(id, patch),
    ENVIRONMENT_AREAS,
  );
}

export function useDeleteEnvironment() {
  return useWrite((id: string) => api.releases.deleteEnvironment(id), ENVIRONMENT_AREAS);
}

/** Solo prototipo: «Simula esito» di una run in corso. */
export function useSimulateRunOutcome() {
  return useWrite(
    ({ code, runId, outcome }: { code: string; runId: string; outcome: "success" | "failed" }) =>
      api.releases.simulateRunOutcome(code, runId, outcome),
    RELEASE_AREAS,
  );
}

/** Solo prototipo: «Simula comparsa sul server». */
export function useSimulateSeenOnServer() {
  return useWrite((code: string) => api.releases.simulateSeenOnServer(code), RELEASE_AREAS);
}

/** Solo prototipo: «Simula push dell'autore». */
export function useSimulateAuthorPush() {
  return useWrite((prId: string) => api.releases.simulateAuthorPush(prId), RELEASE_AREAS);
}

/** Solo prototipo: un passo dell'analisi o della correzione automatica. */
export function useAdvancePrWork() {
  return useWrite((prId: string) => api.releases.advancePrWork(prId), RELEASE_AREAS);
}
