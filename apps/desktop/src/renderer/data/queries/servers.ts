import { keepPreviousData, useQuery } from "@tanstack/react-query";
import * as api from "../api";
import { MIN_QUERY } from "../../pages/chat/search";
import { queryKeys, useSessionPersonId, useWrite } from "../queries";

// Gli hook dei Server (area 8b); `data/queries` li ri-esporta. L'import
// circolare con `../queries` è innocuo: gli helper si usano solo dentro le
// funzioni.

/**
 * Le scritture del monitor cambiano elenco, dettaglio e grafici (area
 * «servers»); creare e togliere un server cambiano anche gli ambienti
 * (area «releases», R-L2).
 */
const SERVER_AREAS = ["servers"] as const;
const SERVER_ENV_AREAS = ["servers", "releases"] as const;

/** I server degli ambienti del progetto. */
export function useProjectServers(projectId: string | undefined) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.projectServers(me, projectId ?? ""),
    queryFn: () => api.servers.listProjectServers(projectId!),
    enabled: !!projectId,
  });
}

/** Il dettaglio di un server (errore `not_found`: nascosto o inesistente, R-G5). */
export function useServer(code: string | undefined) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.server(me, code ?? ""),
    queryFn: () => api.servers.getServer(code!),
    enabled: !!code,
  });
}

/**
 * Le metriche di un server nell'intervallo, ridotte per il grafico; con un
 * controllo anche i suoi campioni (R-L1). Cambiando intervallo resta il
 * grafico di prima finché arriva il nuovo.
 */
export function useServerMetrics(
  code: string | undefined,
  range: api.servers.MetricRange,
  checkId?: string,
) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.serverMetrics(me, code ?? "", range, checkId ?? ""),
    queryFn: () => api.servers.getServerMetrics(code!, range, checkId),
    enabled: !!code,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === me && previousQuery.queryKey[4] === code
        ? keepPreviousData(previous)
        : undefined,
  });
}

/** ⌘K: i server per codice, nome o hostname (da 2 caratteri, R-G5 nel livello dati). */
export function useServerSearch(q: string, enabled = true) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.serverSearch(me, q),
    queryFn: () => api.servers.searchServers(q),
    enabled: enabled && q.trim().length >= MIN_QUERY,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === me ? keepPreviousData(previous) : undefined,
  });
}

/** Un server nuovo in un ambiente; la chiave dell'agente è SOLO nel risultato. */
export function useCreateServer() {
  return useWrite(
    (input: api.servers.CreateServerInput) => api.servers.createServer(input),
    SERVER_ENV_AREAS,
  );
}

/** Una chiave nuova per l'agente: SOLO nel risultato. */
export function useRegenerateAgentKey() {
  return useWrite((code: string) => api.servers.regenerateAgentKey(code), SERVER_AREAS);
}

export function useUpdateServer() {
  return useWrite(
    ({ code, patch }: { code: string; patch: api.servers.UpdateServerInput }) =>
      api.servers.updateServer(code, patch),
    SERVER_AREAS,
  );
}

export function useDeleteServer() {
  return useWrite((code: string) => api.servers.deleteServer(code), SERVER_ENV_AREAS);
}

export function useSetThresholds() {
  return useWrite(
    ({
      code,
      thresholds,
    }: {
      code: string;
      thresholds: Parameters<typeof api.servers.setThresholds>[1];
    }) => api.servers.setThresholds(code, thresholds),
    SERVER_AREAS,
  );
}

export function useCreateCheck() {
  return useWrite(
    ({ code, input }: { code: string; input: api.servers.CheckInput }) =>
      api.servers.createCheck(code, input),
    SERVER_AREAS,
  );
}

export function useUpdateCheck() {
  return useWrite(
    ({ checkId, patch }: { checkId: string; patch: Partial<api.servers.CheckInput> }) =>
      api.servers.updateCheck(checkId, patch),
    SERVER_AREAS,
  );
}

export function useDeleteCheck() {
  return useWrite((checkId: string) => api.servers.deleteCheck(checkId), SERVER_AREAS);
}

/**
 * Solo prototipo: i «Simula …» del riquadro in fondo al dettaglio. Un
 * allarme apre l'episodio, avvisa e può far partire l'analisi (sessione e
 * task): ricaricano anche task, conversazioni e avvisi.
 */
const SIMULATE_AREAS = [
  "servers",
  "tasks",
  "task",
  "conversations",
  "conversation",
  "notifications",
  "alerts",
  "activity",
  "waitingOnMe",
] as const;

export function useSimulateServerAlert() {
  return useWrite(
    ({
      code,
      reason,
      severity,
      overrun,
    }: {
      code: string;
      reason: Parameters<typeof api.servers.simulateServerAlert>[1];
      severity: "trouble" | "down";
      overrun: boolean;
    }) => api.servers.simulateServerAlert(code, reason, { severity, overrun }),
    SIMULATE_AREAS,
  );
}

export function useSimulateServerRecovery() {
  return useWrite((code: string) => api.servers.simulateServerRecovery(code), SIMULATE_AREAS);
}

export function useSimulateSshUnreachable() {
  return useWrite(
    ({ code, on }: { code: string; on: boolean }) => api.servers.simulateSshUnreachable(code, on),
    SIMULATE_AREAS,
  );
}
