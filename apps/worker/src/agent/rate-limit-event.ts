/**
 * Lettura PURA del `rate_limit_event` dello stream-json del CLI `claude`.
 *
 * Il CLI lo emette una volta per run, dopo la prima risposta del modello, e
 * porta la percentuale d'uso delle finestre dell'abbonamento (`utilization` è
 * una FRAZIONE 0–1, `resetsAt` epoch in SECONDI). Qui non c'è I/O né stato:
 * una funzione che non lancia mai, così chi la chiama dal flusso del run non
 * deve proteggersi — un evento illeggibile è semplicemente `null`.
 *
 * Una finestra con `utilization` negativa o non numerica viene SCARTATA (non
 * azzerata): meglio nessun dato che un 0% inventato, che sbloccherebbe un
 * account. Sopra 1 si satura a 100 (l'overage è già «pieno»).
 */

export interface RateLimitWindow {
  usedPercent: number;
  resetsAt: Date | null;
}

export interface RateLimitInfo {
  /** "allowed" | "allowed_warning" | "rejected" | altro: riportato così com'è. */
  status: string;
  rateLimitType: string | null;
  /** TUTTE le chiavi valide di `unifiedWindows` (o la sola finestra di `rateLimitType`). */
  windows: Record<string, RateLimitWindow>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function toWindow(raw: unknown): RateLimitWindow | null {
  if (!isRecord(raw)) return null;
  const u = raw.utilization;
  if (typeof u !== "number" || !Number.isFinite(u) || u < 0) return null;
  const r = raw.resetsAt;
  const resetsAt =
    typeof r === "number" && Number.isFinite(r) ? new Date(r * 1000) : null;
  return { usedPercent: Math.min(100, Math.round(u * 100)), resetsAt };
}

export function parseRateLimitEvent(
  ev: Record<string, unknown>,
): RateLimitInfo | null {
  if (!isRecord(ev) || ev.type !== "rate_limit_event") return null;
  const info = ev.rate_limit_info;
  if (!isRecord(info)) return null;

  const rateLimitType =
    typeof info.rateLimitType === "string" ? info.rateLimitType : null;
  const windows: Record<string, RateLimitWindow> = {};

  if (isRecord(info.unifiedWindows)) {
    for (const [key, raw] of Object.entries(info.unifiedWindows)) {
      const w = toWindow(raw);
      if (w) windows[key] = w;
    }
  } else if (rateLimitType) {
    // Forma vecchia: una sola finestra, piatta, col nome in `rateLimitType`.
    const w = toWindow(info);
    if (w) windows[rateLimitType] = w;
  }

  if (Object.keys(windows).length === 0) return null;
  return {
    status: typeof info.status === "string" ? info.status : "unknown",
    rateLimitType,
    windows,
  };
}
