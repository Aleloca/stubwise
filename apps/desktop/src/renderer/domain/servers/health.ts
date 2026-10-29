import type {
  EpisodeReason,
  MonitoredServer,
  ServerAnalysis,
  ServerEpisode,
  Task,
} from "../../data/model";
import { RECOVERED_SHOWN_HOURS } from "./limits";

/** La salute di un server in una parola, da quando e perché. */
export interface ServerHealth {
  health: "healthy" | "trouble" | "down" | "recovered" | "never_connected";
  /**
   * Inizio del problema; per `recovered`, l'ora del rientro; `null` se in
   * salute o mai collegato.
   */
  since: string | null;
  reasons: EpisodeReason[];
}

/** Cosa sta facendo Claude su un server. */
export type ServerWork = "none" | "analyzing" | "diagnosis_ready" | "fixing";

const HOUR_MS = 3_600_000;

/**
 * La salute di `s` adesso. `never_connected` prima di tutto (R-L4): un
 * agente che non si è mai fatto sentire non dice niente sul server, che
 * quindi non è «in salute»; non ha dati né episodi. Poi `down` se un episodio aperto è `down` o l'agente
 * risulta offline (anche senza episodio: «non risponde» si vede subito);
 * `trouble` con un episodio aperto; `recovered` se l'ultimo episodio è
 * rientrato da meno di `RECOVERED_SHOWN_HOURS`; altrimenti in salute. Con
 * più episodi aperti i motivi si sommano, dal più vecchio.
 */
export function serverHealth(
  s: MonitoredServer,
  episodes: ServerEpisode[],
  now: string,
): ServerHealth {
  if (s.status === "never_connected") {
    return { health: "never_connected", since: null, reasons: [] };
  }
  const own = episodes
    .filter((e) => e.serverCode === s.code)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const open = own.filter((e) => e.recoveredAt === null);
  const openReasons = open.flatMap((e) => e.reasons);

  const down = open.find((e) => e.severity === "down");
  if (down) return { health: "down", since: down.startedAt, reasons: openReasons };
  if (s.status === "offline") {
    if (open.length > 0) return { health: "down", since: open[0]!.startedAt, reasons: openReasons };
    return {
      health: "down",
      since: s.lastSeenAt,
      reasons: s.lastSeenAt ? [{ kind: "agent_silent", since: s.lastSeenAt }] : [],
    };
  }
  if (open.length > 0)
    return { health: "trouble", since: open[0]!.startedAt, reasons: openReasons };

  const last = own
    .filter((e) => e.recoveredAt !== null)
    .reduce<ServerEpisode | null>(
      (latest, e) => (latest === null || e.recoveredAt! > latest.recoveredAt! ? e : latest),
      null,
    );
  if (last && Date.parse(now) - Date.parse(last.recoveredAt!) < RECOVERED_SHOWN_HOURS * HOUR_MS) {
    return { health: "recovered", since: last.recoveredAt, reasons: last.reasons };
  }
  return { health: "healthy", since: null, reasons: [] };
}

/**
 * Il lavoro di Claude su un server (le analisi e le task di QUEL server):
 * una correzione viva prevale su un'analisi in corso, che prevale su una
 * diagnosi pronta (una task di server ancora aperta).
 */
export function serverWork(input: {
  analyses: ServerAnalysis[];
  serverTasks: { task: Task; liveFix: boolean }[];
}): ServerWork {
  if (input.serverTasks.some((t) => t.liveFix)) return "fixing";
  if (input.analyses.some((a) => a.outcome === "running")) return "analyzing";
  if (input.serverTasks.some((t) => t.task.closedAt === null)) return "diagnosis_ready";
  return "none";
}
