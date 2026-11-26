import { keepPreviousData, useQuery } from "@tanstack/react-query";
import * as api from "@backend/api";
import { isAppBuild } from "../build";
import { featureIntegrated } from "../integration";
import { MIN_QUERY } from "../../pages/chat/search";
import { queryKeys, REQUEST_AREAS, useInvalidate, useSessionPersonId, useWrite } from "../queries";

// Gli hook di questa parte dell'area 8a; `data/queries` li ri-esporta.
// L'import circolare con `../queries` è innocuo: gli helper si usano solo
// dentro le funzioni.

// --- Support (area 8a) --------------------------------------------------------

/**
 * Le scritture di Support cambiano elenco, dettaglio, anteprima e Home (area
 * «support»); i messaggi simulati del cliente pubblicano avvisi (campanella).
 */
const SUPPORT_AREAS = ["support", "notifications"] as const;
/**
 * «Apri la richiesta» e il triage concluso creano una richiesta. Una
 * funzione: `REQUEST_AREAS` viene da `../queries`, che carica questo modulo.
 */
const supportRequestAreas = () => [...SUPPORT_AREAS, ...REQUEST_AREAS];

/**
 * Ogni quanto Support si rilegge da solo (area 8, F3, R6): nella build app
 * non c'è uno stream. Il dettaglio aperto ogni 15 s finché la conversazione
 * è senza esito (un messaggio del cliente può riportarla in triage); chiusa
 * (`request_open`) ogni 30 s, perché la richiesta e «Continued in» cambiano
 * ancora; l'elenco ogni 30 s. Il prototipo cambia solo da sé: mai.
 */
export function supportRefreshMs(
  kind: "detail" | "list",
  state?: api.support.SupportState,
): number | false {
  if (!isAppBuild()) return false;
  if (kind === "list") return 30_000;
  if (state === undefined) return false;
  // Chiusa: la richiesta (lo stato per il cliente) e «Continued in» cambiano ancora, più piano.
  return state === "request_open" ? 30_000 : 15_000;
}

/** Le conversazioni coi clienti del progetto, raggruppate per stato. */
export function useSupportConversations(
  projectId: string | undefined,
  filter: { state?: api.support.SupportState } = {},
) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.supportConversations(me, projectId ?? "", filter.state ?? ""),
    queryFn: () => api.support.listSupportConversations(projectId!, filter),
    enabled: !!projectId,
    refetchInterval: supportRefreshMs("list"),
  });
}

/** Il dettaglio di una conversazione (`null`: nascosta o inesistente, R-G5). */
export function useSupportConversation(code: string | undefined) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.supportConversation(me, code ?? ""),
    queryFn: () => api.support.getSupportConversation(code!),
    enabled: !!code,
    refetchInterval: (query) => supportRefreshMs("detail", query.state.data?.state),
  });
}

/** «Anteprima del cliente»: cosa vede lui adesso. */
export function useCustomerPreview(code: string | undefined) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.customerPreview(me, code ?? ""),
    queryFn: () => api.support.customerPreview(code!),
    enabled: !!code,
  });
}

export function useSupportWidgets(projectId: string | undefined) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.supportWidgets(me, projectId ?? ""),
    queryFn: () => api.support.listWidgets(projectId!),
    // Build app: i widget hanno la loro funzione (area 8, F3, R1).
    enabled: !!projectId && featureIntegrated("support-widgets"),
  });
}

/** ⌘K: le conversazioni per codice (`ACQ-S2`), cliente o desiderio (da 2 caratteri). */
export function useSupportSearch(q: string, enabled = true) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.supportSearch(me, q),
    queryFn: () => api.support.searchSupport(q),
    // Solo dove la ricerca è integrata (review area 8 F1, m5): non è nella F3
    // (nessuna rotta), quindi ha la sua funzione, spenta anche con `support`.
    enabled: enabled && q.trim().length >= MIN_QUERY && featureIntegrated("support-search"),
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === me ? keepPreviousData(previous) : undefined,
  });
}

/** «Apri la richiesta» su una non conclusa (`backlog.create`). */
export function useOpenRequestFrom() {
  return useWrite(
    ({ code, title, description }: { code: string; title: string; description: string }) =>
      api.support.openRequestFrom(code, { title, description }),
    supportRequestAreas(),
  );
}

/** «Not concluded» su una `answered` (`support.manage`): diventa non conclusa. */
export function useMarkNotConcluded() {
  return useWrite((code: string) => api.support.markNotConcluded(code), SUPPORT_AREAS);
}

export function useCreateWidget() {
  return useWrite(
    ({ projectId, input }: { projectId: string; input: api.support.WidgetInput }) =>
      api.support.createWidget(projectId, input),
    SUPPORT_AREAS,
  );
}

export function useUpdateWidget() {
  return useWrite(
    ({ id, patch }: { id: string; patch: Partial<api.support.WidgetInput> }) =>
      api.support.updateWidget(id, patch),
    SUPPORT_AREAS,
  );
}

/**
 * API per i siti (S6): il segreto d'identità dei clienti, con la riconferma.
 * `secret: true`: il valore non entra mai nella cache (I2).
 */
export function useRegenerateIdentitySecret() {
  return useWrite((id: string) => api.support.regenerateIdentitySecret(id), SUPPORT_AREAS, {
    secret: true,
  });
}

export function useDeleteWidget() {
  return useWrite((id: string) => api.support.deleteWidget(id), SUPPORT_AREAS);
}

/**
 * «Invia al cliente» SUBITO, fuori da React Query: alla fine della finestra
 * dell'«Annulla» e prima di cambiare persona (`onBeforePersonaChange`), dove
 * `writer` legge la sessione ora — a nome di chi ha cliccato «Invia». La
 * pagina della persona nuova si rilegge comunque da capo.
 */
export function replyToCollaboratorNow(code: string, body: string, clientId?: string) {
  return api.support.replyToCollaborator(code, body, clientId);
}

/** Ricarica Support (elenco, dettaglio, Home) dopo un invio fatto fuori da React Query. */
export function useInvalidateSupport() {
  return useInvalidate(SUPPORT_AREAS);
}

/** Solo prototipo: «Simula un messaggio del cliente». */
export function useSimulateCustomerMessage() {
  return useWrite(
    ({ code, body }: { code: string; body: string }) =>
      api.support.simulateCustomerMessage(code, body),
    SUPPORT_AREAS,
  );
}

/** Solo prototipo: «Simula: il cliente se ne va». */
export function useSimulateCustomerLeaves() {
  return useWrite((code: string) => api.support.simulateCustomerLeaves(code), SUPPORT_AREAS);
}

/** Solo prototipo: «Simula: triage concluso». */
export function useSimulateTriageDone() {
  return useWrite((code: string) => api.support.simulateTriageDone(code), supportRequestAreas());
}
