import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { isoWeek, subscribeClock, today } from "./dates";

// «Oggi» per i componenti: nella build app l'orologio avanza (Europe/Rome, al
// ritorno sulla finestra e col controllo al minuto) e chi usa questi hook si
// ridisegna al cambio di giorno; nel prototipo «oggi» è fisso e non cambia mai.

export function useToday(): string {
  return useSyncExternalStore(subscribeClock, today, today);
}

/** La settimana corrente (`YYYY-Www`), aggiornata al cambio di giorno. */
export function useCurrentWeek(): string {
  return isoWeek(useToday());
}

/** Le aree che dipendono dalla settimana corrente: task (effettiva, slittamento), ferme, giorni. */
const WEEK_AREAS = new Set(["tasks", "task", "stalled", "dayArrangements"]);

/**
 * Montato una volta nel layout: al cambio di settimana rilegge task e
 * pianificazione, perché il server ricalcola settimana effettiva e slittamento.
 */
export function useClockRefresh(): void {
  const week = useCurrentWeek();
  const client = useQueryClient();
  const seen = useRef(week);
  useEffect(() => {
    if (week === seen.current) return;
    seen.current = week;
    void client.invalidateQueries({
      predicate: (q) => q.queryKey[0] === "as" && WEEK_AREAS.has(q.queryKey[2] as string),
    });
  }, [week, client]);
}
