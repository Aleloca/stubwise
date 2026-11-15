import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { ScriptLang } from "../../domain/servers/installScript";
import * as api from "@backend/api";
import { revealAgentKey } from "../revealedAgentKey";
import { featureIntegrated } from "../integration";
import { MIN_QUERY } from "../../pages/chat/search";
import { queryKeys, useConversationChanges, useSessionPersonId, useWrite } from "../queries";

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
    enabled: !!projectId && featureIntegrated("servers-monitor"),
  });
}

/**
 * Tutti i server dell'istanza, coi progetti visibili e gli orfani
 * (Amministrazione → Servers, area 9b; errore `forbidden` senza
 * `monitor.manage`).
 */
export function useAllServers() {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.allServers(me),
    queryFn: () => api.servers.listAllServers(),
  });
}

/** I server che chi guarda può collegare a un ambiente (quelli che vede), per il form. */
export function useLinkableServers(enabled = true) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.linkableServers(me),
    queryFn: () => api.servers.listLinkableServers(),
    enabled: enabled && featureIntegrated("environments"),
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
    // Solo dove l'area è integrata (review area 8 F1, m5).
    // La ricerca ⌘K dei server è fuori dalla F4a: la sua funzione, spenta.
    enabled: enabled && q.trim().length >= MIN_QUERY && featureIntegrated("servers-search"),
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === me ? keepPreviousData(previous) : undefined,
  });
}

/** Un server nuovo in un ambiente; la chiave dell'agente è SOLO nel risultato. */
/**
 * Un server nuovo. La chiave dell'agente NON sta nel risultato (la cache
 * delle mutazioni la terrebbe, regola I2): la si mette da parte per il
 * pannello che la mostra una volta (`takeAgentKey`).
 */
export async function createServerAndReveal(input: api.servers.CreateServerInput) {
  const { agentKey, instanceUrl, ...rest } = await api.servers.createServer(input);
  revealAgentKey(rest.server.code, { key: agentKey, ...(instanceUrl ? { instanceUrl } : {}) });
  return rest;
}

/** Una chiave nuova per l'agente: per il pannello, mai nel risultato (I2). */
export async function regenerateAndReveal(code: string): Promise<void> {
  const { agentKey, instanceUrl } = await api.servers.regenerateAgentKey(code);
  revealAgentKey(code, { key: agentKey, ...(instanceUrl ? { instanceUrl } : {}) });
}

export function useCreateServer() {
  return useWrite(createServerAndReveal, SERVER_ENV_AREAS);
}

export function useRegenerateAgentKey() {
  return useWrite(regenerateAndReveal, SERVER_AREAS);
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

/**
 * Il comando dell'accesso SSH da rivedere (solo chiavi pubbliche; solo
 * `servers.ssh.manage`: chi chiama lo abilita solo se `access.canManage`).
 */
export function useInstallCommand(code: string | undefined, enabled: boolean) {
  const me = useSessionPersonId();
  const lang = useScriptLang();
  return useQuery({
    queryKey: queryKeys.serverInstallCommand(me, code ?? "", lang),
    queryFn: () => api.servers.getInstallCommand(code!, lang),
    enabled: enabled && !!code,
  });
}

/**
 * La chiave pubblica d'istanza dei comandi (R3, `monitor.manage`): per il
 * comando d'installazione con le operazioni accese. Letta solo quando serve.
 */
export function useCommandKey(enabled: boolean) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: ["as", me, "servers", "commandKey"] as const,
    queryFn: () => api.servers.getCommandKey(),
    enabled,
    staleTime: Infinity,
  });
}

/** Il comando di rimozione dopo una revoca (solo `servers.ssh.manage`, solo `revoked`). */
export function useRemovalCommand(code: string | undefined, enabled: boolean) {
  const me = useSessionPersonId();
  const lang = useScriptLang();
  return useQuery({
    queryKey: queryKeys.serverRemovalCommand(me, code ?? "", lang),
    queryFn: () => api.servers.getRemovalCommand(code!, lang),
    enabled: enabled && !!code,
  });
}

/** I commenti degli script nella lingua dell'interfaccia (inglese salvo l'italiano). */
function useScriptLang(): ScriptLang {
  const { i18n } = useTranslation();
  return i18n.language.startsWith("it") ? "it" : "en";
}

/**
 * Le scritture degli accessi SSH (Task 4). Cambiano il dettaglio (area
 * «servers», compreso il comando); la revoca ferma anche la correzione viva
 * sul server e spegne l'approvazione di un piano che aspetta (task e
 * conversazioni), e così una verifica che cambia l'accesso di correzione.
 */
const SSH_AREAS = [
  "servers",
  "tasks",
  "task",
  "conversations",
  "conversation",
  "notifications",
  "activity",
] as const;

export function useLinkSshAccess() {
  return useWrite((code: string) => api.servers.linkSshAccess(code), SSH_AREAS);
}

export function useVerifySshAccess() {
  return useWrite((code: string) => api.servers.verifySshAccess(code), SSH_AREAS);
}

export function useRegenerateSshAccess() {
  return useWrite((code: string) => api.servers.regenerateSshAccess(code), SSH_AREAS);
}

export function useRevokeSshAccess() {
  return useWrite((code: string) => api.servers.revokeSshAccess(code), SSH_AREAS);
}

/** Solo prototipo: l'esito della prossima «Verify» (riquadro «Prototype only»). */
export function useSimulateSshVerifyOutcome() {
  return useWrite(
    ({
      code,
      outcome,
    }: {
      code: string;
      outcome: Parameters<typeof api.servers.simulateSshVerifyOutcome>[1];
    }) => api.servers.simulateSshVerifyOutcome(code, outcome),
    SERVER_AREAS,
  );
}

/**
 * Il blocco «Server» di una task di server: server, episodio, a che punto è
 * la correzione e perché chi guarda non può avviarla (`startBlock`, mai
 * dedotto). `null` per una task senza `serverRef`. Segue la sessione di
 * correzione dal vivo (area delle conversazioni).
 */
export function useServerTaskInfo(taskId: string) {
  const me = useSessionPersonId();
  useConversationChanges();
  return useQuery({
    queryKey: queryKeys.serverTaskInfo(me, taskId),
    queryFn: () => api.servers.getServerTaskInfo(taskId),
    // Review F4b I3: nell'app la sezione non sente le sessioni (l'esecuzione
    // è deterministica, senza Claude): mentre la correzione pianifica o gira
    // si rilegge ogni pochi secondi.
    refetchInterval: (q) => serverTaskRefetch(q.state.data?.state),
  });
}

/** Ogni quanto rileggere la sezione Server: solo mentre la correzione è viva. */
export function serverTaskRefetch(state: string | undefined): number | false {
  return state === "fix_planning" || state === "fixing" ? 4000 : false;
}

/**
 * Avvia la correzione sul server dalla task (`servers.operate`): nasce una
 * sessione di lavoro che scrive il piano e si ferma ad aspettare
 * l'approvazione. Cambia task, conversazioni e server.
 */
const FIX_AREAS = [
  "servers",
  "tasks",
  "task",
  "conversations",
  "conversation",
  "activity",
  "waitingOnMe",
] as const;

/**
 * Il piano della correzione deciso dalla task (decisione del maintainer, 15
 * nov 2026): Approva col digest della vista, Rifiuta con la nota, Stop.
 */
export function useApproveServerFix() {
  return useWrite(
    ({ taskId, planDigest }: { taskId: string; planDigest: string }) =>
      api.servers.approveServerFix(taskId, planDigest),
    FIX_AREAS,
  );
}

export function useRejectServerFix() {
  return useWrite(
    ({ taskId, note }: { taskId: string; note: string }) =>
      api.servers.rejectServerFix(taskId, note),
    FIX_AREAS,
  );
}

export function useStopServerFix() {
  return useWrite((taskId: string) => api.servers.stopServerFix(taskId), FIX_AREAS);
}

export function useStartServerFix() {
  return useWrite(
    ({ taskId, notes }: { taskId: string; notes?: string }) =>
      api.servers.startServerFix(taskId, { notes }),
    FIX_AREAS,
  );
}

/**
 * «Ask Claude to look into it» (R0-A2): l'analisi a mano di un server. Nasce
 * una sessione di Claude; cambia il server e le conversazioni.
 */
export function useStartServerAnalysis() {
  return useWrite((code: string) => api.servers.startServerAnalysis(code), FIX_AREAS);
}

/**
 * Mentre un'analisi gira, il dettaglio del server si rilegge a ogni cambio
 * delle sessioni (solo il dettaglio: non grafici né elenchi), così la riga
 * dell'analisi a mano arriva alla fine da sola.
 */
export function useServerFollowsAnalysis(code: string, running: boolean) {
  const client = useQueryClient();
  const me = useSessionPersonId();
  useEffect(() => {
    if (!running) return undefined;
    const reread = () => void client.invalidateQueries({ queryKey: queryKeys.server(me, code) });
    const off = api.onConversationChange(reread);
    // Un cambio arrivato fra la lettura e l'iscrizione non si perde: si rilegge subito.
    reread();
    return off;
  }, [client, me, code, running]);
}

/** Solo prototipo: l'esito del prossimo controllo dopo la correzione. */
export function useSimulateFixCheck() {
  return useWrite(
    ({ code, outcome }: { code: string; outcome: "resolved" | "not_resolved" }) =>
      api.servers.simulateFixCheck(code, outcome),
    SERVER_AREAS,
  );
}
