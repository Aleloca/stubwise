import { serverHealth as deriveServerHealth } from "@stubwise/shared";
import type {
  EpisodeReason,
  MonitoredServer,
  ServerAnalysis,
  ServerEpisode,
  Task,
} from "../../data/model";

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

export { deriveServerHealth };

/**
 * La salute di `s` adesso: la regola è UNA, in `@stubwise/shared` (area 8,
 * F4a: la usa anche il server per la sua vista). Qui il prototipo le passa i
 * soli episodi di quel server. I motivi tornano quelli dei suoi episodi (più
 * `agent_silent`), quindi del tipo del prototipo.
 */
export function serverHealth(
  s: MonitoredServer,
  episodes: ServerEpisode[],
  now: string,
): ServerHealth {
  const out = deriveServerHealth(
    s,
    episodes.filter((e) => e.serverCode === s.code),
    now,
  );
  return { ...out, reasons: out.reasons as EpisodeReason[] };
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
