import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../api";
import { getSessionPersonId } from "../session";
import { streamText } from "../stream";
import { MIN_QUERY } from "../../pages/chat/search";
import {
  queryKeys,
  REQUEST_AREAS,
  useInvalidate,
  useSessionPersonId,
  useWrite,
} from "../queries";

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
  });
}

/** Il dettaglio di una conversazione (`null`: nascosta o inesistente, R-G5). */
export function useSupportConversation(code: string | undefined) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.supportConversation(me, code ?? ""),
    queryFn: () => api.support.getSupportConversation(code!),
    enabled: !!code,
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

/** Il blocco «Clienti in attesa» della Home. */
export function useWaitingCustomers() {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.waitingCustomers(me),
    queryFn: () => api.support.listWaitingCustomers(),
  });
}

export function useSupportWidgets(projectId: string | undefined) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.supportWidgets(me, projectId ?? ""),
    queryFn: () => api.support.listWidgets(projectId!),
    enabled: !!projectId,
  });
}

/** ⌘K: le conversazioni per codice (`ACQ-S2`), cliente o desiderio (da 2 caratteri). */
export function useSupportSearch(q: string, enabled = true) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.supportSearch(me, q),
    queryFn: () => api.support.searchSupport(q),
    enabled: enabled && q.trim().length >= MIN_QUERY,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === me ? keepPreviousData(previous) : undefined,
  });
}

/** Lo stato di una richiesta come lo dice `my_requests` al cliente. */
export function useMyRequestStatus(requestId: string | undefined) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.myRequestStatus(me, requestId ?? ""),
    queryFn: () => api.support.myRequestStatus(requestId!),
    enabled: !!requestId,
  });
}

/** «Invia al cliente»: solo dal clic di chi ha `support.reply`, mai un'email. */
export function useReplyToCustomer() {
  return useWrite(
    ({ code, body }: { code: string; body: string }) => api.support.replyToCustomer(code, body),
    SUPPORT_AREAS,
  );
}

/** «Bozza di Claude»: la rigenera, non la invia. */
export function useDraftReply() {
  return useWrite((code: string) => api.support.draftReply(code), SUPPORT_AREAS);
}

/** «Apri la richiesta» su una non conclusa (`backlog.create`). */
export function useOpenRequestFrom() {
  return useWrite(
    ({ code, title, description }: { code: string; title: string; description: string }) =>
      api.support.openRequestFrom(code, { title, description }),
    supportRequestAreas(),
  );
}

export function useFollowConversation() {
  return useWrite(
    ({ code, on }: { code: string; on: boolean }) => api.support.followConversation(code, on),
    SUPPORT_AREAS,
  );
}

/** «Scrivigli anche per email»: la bozza per il compositore della Posta. Non scrive nulla. */
export function useEmailDraftFor() {
  return useWrite((code: string) => api.support.emailDraftFor(code), []);
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

export function useDeleteWidget() {
  return useWrite((id: string) => api.support.deleteWidget(id), SUPPORT_AREAS);
}

/**
 * «Invia al cliente» SUBITO, fuori da React Query: alla fine della finestra
 * dell'«Annulla» e prima di cambiare persona (`onBeforePersonaChange`), dove
 * `writer` legge la sessione ora — a nome di chi ha cliccato «Invia». La
 * pagina della persona nuova si rilegge comunque da capo.
 */
export function replyToCustomerNow(code: string, body: string) {
  return api.support.replyToCustomer(code, body);
}

/** Ricarica Support (elenco, dettaglio, Home) dopo un invio fatto fuori da React Query. */
export function useInvalidateSupport() {
  return useInvalidate(SUPPORT_AREAS);
}

export type SupportClaudeDraftState =
  | { status: "idle" }
  | { status: "writing"; text: string }
  | { status: "done" | "stopped"; text: string }
  | { status: "failed" };

/**
 * «Bozza di Claude» nella casella di Support (shape support.md §5): la
 * rigenera (`draftReply`) e la scrive a pezzi nel corpo, con lo stesso ritmo
 * delle risposte di Claude (`streamText`). Non invia NULLA: chi risponde la
 * rilegge e preme «Invia al cliente». Di chi l'ha chiesta: cambiando persona
 * si ferma e sparisce.
 */
export function useSupportClaudeDraft() {
  const me = useSessionPersonId();
  const invalidate = useInvalidate(SUPPORT_AREAS);
  const [state, setState] = useState<SupportClaudeDraftState>({ status: "idle" });
  const run = useRef<{ stopped: boolean } | null>(null);

  const stop = useCallback(() => {
    if (run.current) run.current.stopped = true;
  }, []);

  const start = useCallback(
    (code: string) => {
      if (run.current) run.current.stopped = true;
      const current = { stopped: false };
      run.current = current;
      setState({ status: "writing", text: "" });
      void (async () => {
        try {
          const view = await api.support.draftReply(code);
          void invalidate();
          let written = "";
          const complete = await streamText(
            view.claudeDraft ?? "",
            `${me}:${code}`,
            (soFar) => {
              written = soFar;
              if (run.current === current) setState({ status: "writing", text: soFar });
            },
            () => !current.stopped && getSessionPersonId() === me,
          );
          if (run.current === current)
            setState({ status: complete ? "done" : "stopped", text: written });
        } catch {
          if (run.current === current) setState({ status: "failed" });
        }
      })();
    },
    [me, invalidate],
  );

  const reset = useCallback(() => {
    if (run.current) run.current.stopped = true;
    run.current = null;
    setState({ status: "idle" });
  }, []);

  // Un'altra persona, o la casella che si chiude: la bozza si ferma.
  useEffect(() => reset, [me, reset]);

  return { state, start, stop, reset };
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
