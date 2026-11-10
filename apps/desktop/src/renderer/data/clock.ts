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
const WEEK_AREAS = new Set(["tasks", "task", "stalled", "dayArrangements", "pulse"]);
/** Quelle che dipendono dal giorno: le ferme (giorni di inattività), le task (in ritardo, oggi) e il polso che le conta. */
const DAY_AREAS = new Set(["tasks", "task", "stalled", "pulse"]);

/**
 * Montato una volta nel layout: al cambio di giorno rilegge task e ferme, al
 * cambio di settimana anche le sistemazioni per giorno (il server ricalcola
 * settimana effettiva e slittamento). Chi legge «oggi» al render usa `useToday`.
 */
export function useClockRefresh(): void {
  const today = useToday();
  const week = isoWeek(today);
  const client = useQueryClient();
  const seen = useRef({ today, week });
  useEffect(() => {
    if (today === seen.current.today) return;
    const areas = week === seen.current.week ? DAY_AREAS : WEEK_AREAS;
    seen.current = { today, week };
    void client.invalidateQueries({
      predicate: (q) => q.queryKey[0] === "as" && areas.has(q.queryKey[2] as string),
    });
  }, [today, week, client]);
}
