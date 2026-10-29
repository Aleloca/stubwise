import type { ServerEpisode } from "../../types";
import { daysFromToday } from "../dates";

// Gli episodi del seme. Le ore sono quelle delle notifiche che li hanno
// annunciati: l'allarme di memoria di SRV-1 e il suo rientro sono le righe
// `monitor.alert` / `monitor.recovered` di `notifications.ts` (52 e 50 «ore
// fa» nella loro tabella, cioè due giorni fa alle 18:00 e alle 20:00).

const at = (days: number, hm: string) => `${daysFromToday(-days)}T${hm}:00Z`;

/** L'episodio di memoria di SRV-1: analizzato, rientrato da sé dopo due ore. */
export const SRV1_MEMORY_EPISODE: ServerEpisode = {
  id: "ep-srv-1-1",
  serverCode: "SRV-1",
  severity: "trouble",
  reasons: [{ kind: "memory", valuePct: 94, thresholdPct: 90 }],
  startedAt: at(2, "18:00"),
  recoveredAt: at(2, "20:00"),
  analysisId: "an-srv-1-1",
};

/** SRV-2 adesso: disco al 93% e la replica che non risponde; nessun accesso, nessuna analisi. */
export const SRV2_DISK_EPISODE: ServerEpisode = {
  id: "ep-srv-2-1",
  serverCode: "SRV-2",
  severity: "trouble",
  reasons: [
    { kind: "disk", valuePct: 93, thresholdPct: 90 },
    { kind: "check", checkId: "chk-srv-2-replica" },
  ],
  startedAt: at(0, "09:40"),
  recoveredAt: null,
  analysisId: null,
};

/** SRV-3 sei giorni fa: l'agente tace per 22 minuti (riavvio del server); nessun accesso di lettura. */
export const SRV3_SILENT_EPISODE: ServerEpisode = {
  id: "ep-srv-3-1",
  serverCode: "SRV-3",
  severity: "down",
  reasons: [{ kind: "agent_silent", since: at(6, "03:10") }],
  startedAt: at(6, "03:10"),
  recoveredAt: at(6, "03:32"),
  analysisId: null,
};

export const SERVER_EPISODES: ServerEpisode[] = [
  SRV1_MEMORY_EPISODE,
  SRV2_DISK_EPISODE,
  SRV3_SILENT_EPISODE,
];
