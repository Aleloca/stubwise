// La salute di un server in una parola, da quando e perché (area 8, F4a; era
// `domain/servers/health.ts` del prototipo). UNA funzione, che usano il server
// (la vista) e il renderer: due copie della regola divergerebbero.

/** Perché un server è in difficoltà o non risponde. Un `kind` nuovo non rompe un client vecchio: i campi sono facoltativi. */
export interface EpisodeReason {
  kind: string;
  valuePct?: number;
  thresholdPct?: number;
  checkId?: string;
  since?: string;
}

/** Ciò che serve di un episodio: dall'allarme al rientro. */
export interface HealthEpisode {
  severity: "trouble" | "down";
  reasons: readonly EpisodeReason[];
  startedAt: string;
  recoveredAt: string | null;
}

export type ServerHealthWord = "healthy" | "trouble" | "down" | "recovered" | "never_connected";

export interface ServerHealth {
  health: ServerHealthWord;
  /** Inizio del problema; per `recovered` l'ora del rientro; null in salute o mai collegato. */
  since: string | null;
  reasons: EpisodeReason[];
}

/** Per quante ore un server rientrato si dice «recovered». */
export const RECOVERED_SHOWN_HOURS = 24;

const HOUR_MS = 3_600_000;

/**
 * La salute adesso. `never_connected` prima di tutto (un agente mai sentito
 * non dice niente); poi `down` se un episodio aperto è `down` o l'agente è
 * offline (anche senza episodio); `trouble` con un episodio aperto;
 * `recovered` se l'ultimo episodio è rientrato da meno di
 * `RECOVERED_SHOWN_HOURS`; altrimenti in salute. Con più episodi aperti i
 * motivi si sommano, dal più vecchio.
 */
export function serverHealth(
  s: { status: "online" | "offline" | "never_connected"; lastSeenAt: string | null },
  episodes: readonly HealthEpisode[],
  now: string,
): ServerHealth {
  if (s.status === "never_connected") return { health: "never_connected", since: null, reasons: [] };
  const own = [...episodes].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const open = own.filter((e) => e.recoveredAt === null);
  const openReasons = open.flatMap((e) => [...e.reasons]);
  const down = open.find((e) => e.severity === "down");
  if (down) return { health: "down", since: down.startedAt, reasons: openReasons };
  if (s.status === "offline") {
    if (open.length > 0) return { health: "down", since: open[0]!.startedAt, reasons: openReasons };
    return { health: "down", since: s.lastSeenAt, reasons: s.lastSeenAt ? [{ kind: "agent_silent", since: s.lastSeenAt }] : [] };
  }
  if (open.length > 0) return { health: "trouble", since: open[0]!.startedAt, reasons: openReasons };
  const last = own
    .filter((e) => e.recoveredAt !== null)
    .reduce<HealthEpisode | null>((latest, e) => (latest === null || e.recoveredAt! > latest.recoveredAt! ? e : latest), null);
  if (last && Date.parse(now) - Date.parse(last.recoveredAt!) < RECOVERED_SHOWN_HOURS * HOUR_MS) {
    return { health: "recovered", since: last.recoveredAt, reasons: [...last.reasons] };
  }
  return { health: "healthy", since: null, reasons: [] };
}
