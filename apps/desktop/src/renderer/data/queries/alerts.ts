import { useMutation, useQuery } from "@tanstack/react-query";
import * as api from "../api";
import {
  queryKeys,
  useInvalidate,
  useOptimistic,
  useSessionPersonId,
} from "../queries";

// Gli hook di questa parte dell'area 8a; `data/queries` li ri-esporta.
// L'import circolare con `../queries` è innocuo: gli helper si usano solo
// dentro le funzioni.

// --- Avvisi (area 8a) ---------------------------------------------------------

/**
 * Le iscrizioni decidono chi riceve gli avvisi futuri, e la campanella legge
 * «già spento» dalle iscrizioni: le scritture ricaricano entrambe. Anche i
 * rilasci: i falliti del blocco Home «Rilasci» seguono l'iscrizione.
 */
const ALERT_AREAS = ["alerts", "notifications", "releases"] as const;

/** Le iscrizioni di chi guarda, per progetto (Preferenze → Notifiche e popover). */
export function useAlertSubscriptions() {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.alertSubscriptions(me),
    queryFn: () => api.alerts.subscriptionRows(),
  });
}

/**
 * Accende o spegne un tipo in un progetto, per App e Telefono. Ottimistica:
 * l'interruttore (pagina e popover leggono la stessa cache) cambia subito e
 * torna com'era se la scrittura fallisce. Telefono richiede App, come nel
 * livello dati.
 */
export function useSetAlertSubscription() {
  return useOptimistic(
    ({
      projectId,
      type,
      change,
    }: {
      projectId: string;
      type: string;
      change: { app?: boolean; phone?: boolean };
    }) => api.alerts.setSubscription(projectId, type, change),
    ["alerts"],
    ({ projectId, type, change }, _area, old) =>
      (old as api.alerts.ProjectSubscriptions[]).map((p) =>
        p.projectId !== projectId
          ? p
          : {
              ...p,
              rows: p.rows.map((r) => {
                if (r.type !== type || (r.state !== "on" && r.state !== "off")) return r;
                const app = change.app ?? (change.phone ? true : r.app);
                const phone = app && (change.phone ?? r.phone);
                return { ...r, app, phone, state: app ? "on" : "off" };
              }),
            },
      ),
    ALERT_AREAS,
  );
}

/** Una scrittura in blocco con «Annulla»: anche l'annullamento ricarica le aree. */
function useUndoableAlertWrite<TVars>(mutationFn: (vars: TVars) => Promise<api.alerts.Undoable>) {
  const invalidate = useInvalidate(ALERT_AREAS);
  return useMutation({
    mutationFn: async (vars: TVars): Promise<api.alerts.Undoable> => {
      const done = await mutationFn(vars);
      return {
        undo: async () => {
          try {
            await done.undo();
          } finally {
            await invalidate();
          }
        },
      };
    },
    onSettled: invalidate,
  });
}

/** «Come questo progetto»: le righe di `to` prendono lo stato di quelle di `from`. */
export function useCopyAlertSubscriptions() {
  return useUndoableAlertWrite(({ from, to }: { from: string; to: string }) =>
    api.alerts.copySubscriptions(from, to),
  );
}

/** «Spegni tutto in questo progetto». */
export function useMuteProjectAlerts() {
  return useUndoableAlertWrite((projectId: string) => api.alerts.muteProject(projectId));
}

/** «Non avvisarmi più di questo in <progetto>», dal pannello. */
export function useMuteFromNotification() {
  return useUndoableAlertWrite((notificationId: string) =>
    api.alerts.muteFromNotification(notificationId),
  );
}
