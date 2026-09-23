import { relativeTimeCompact } from "./format";

/**
 * Le regole PURE del cruscotto di un server nell'app (23 set 2026, hub di
 * progetto, tappa 3). Stanno qui e non nella schermata perché ognuna decide
 * se un numero si può mostrare o no, ed è la parte che un test deve fissare.
 */

/**
 * Quanto è vecchio l'ultimo campione.
 *
 * ⚠️ `stale` oltre **2×** l'intervallo di campionamento: è la STESSA soglia
 * della pagina del server sul web (`apps/web/src/routes/monitor/
 * server-detail.tsx`). Non è la soglia di `offline` (3×, in
 * `computeServerStatus`), e non deve diventarla: la prima dice «questi numeri
 * potrebbero non essere più veri», la seconda «l'agente non risponde» — e un
 * cruscotto che mostra numeri di due ore fa come se fossero di adesso mente
 * prima che il server risulti offline.
 *
 * `none`: nessun campione mai ricevuto. Non è un campione vecchio, è l'assenza
 * di numeri — e si dice così, non «0%».
 */
export type SampleAge = { kind: "none" } | { kind: "fresh" | "stale"; at: string };

export function sampleAge(metricsAt: string | null, sampleIntervalSeconds: number, now: number): SampleAge {
  if (metricsAt === null) return { kind: "none" };
  const elapsed = now - new Date(metricsAt).getTime();
  return { kind: elapsed > 2 * sampleIntervalSeconds * 1000 ? "stale" : "fresh", at: metricsAt };
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/**
 * Una quantità di byte leggibile, base 1024 e un decimale senza zeri di troppo
 * («1.5 GB», «2 GB») — la stessa forma di `formatBytes` del web, con in più i
 * TB perché qui si parla di dischi, non di allegati.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = Math.round(value * 10) / 10;
  return `${rounded} ${BYTE_UNITS[unit]}`;
}

/**
 * Percentuale intera di `used` su `total`. `null` quando non si può calcolare
 * (totale zero o assente): un disco con totale 0 non è «pieno al 0%».
 */
export function usedPct(used: number, total: number): number | null {
  if (!(total > 0)) return null;
  return Math.round((used / total) * 100);
}

/**
 * LA MEMORIA di un server, con i DUE significati di `null` tenuti distinti.
 *
 * `memUsedBytes`/`memTotalBytes` sono arrivati nel dettaglio il 23 set 2026
 * (additivi, `.nullable().default(null)`): un server che il campo non lo
 * manda è un server PIÙ VECCHIO di questa app, non un server senza memoria.
 *
 * - `never`: il server non ha mai mandato campioni — non c'è niente da
 *   mostrare, e lo dice già lo stato `never_connected`;
 * - `unavailable`: ha campioni, ma la risposta non porta la memoria (server
 *   non aggiornato) — si dice che qui non è disponibile;
 * - `known`: i due numeri.
 *
 * In nessuno dei due casi `null` diventa «0 GB».
 */
export type MemoryReading =
  | { kind: "never" }
  | { kind: "unavailable" }
  | { kind: "known"; usedBytes: number; totalBytes: number; pct: number | null };

export function memoryReading(detail: {
  metricsAt: string | null;
  memUsedBytes: number | null;
  memTotalBytes: number | null;
}): MemoryReading {
  if (detail.metricsAt === null) return { kind: "never" };
  if (detail.memUsedBytes === null || detail.memTotalBytes === null) return { kind: "unavailable" };
  return {
    kind: "known",
    usedBytes: detail.memUsedBytes,
    totalBytes: detail.memTotalBytes,
    pct: usedPct(detail.memUsedBytes, detail.memTotalBytes),
  };
}

/**
 * Lo stato di un server come lo legge l'app: il valore del server, o il
 * segnaposto `UNKNOWN` di `readerSchema` se è un valore che questa build non
 * conosce. Entrambi stringhe, quindi il tipo è `string`.
 */
type ServerStatusValue = string;

/**
 * La chiave i18n dello stato. Un valore sconosciuto va a «stato sconosciuto»,
 * mai mostrato grezzo — e mai a «online», che sarebbe una rassicurazione
 * inventata.
 */
export function serverStatusKey(status: ServerStatusValue): string {
  if (status === "online") return "mobile.projects.monitor.status.online";
  if (status === "offline") return "mobile.projects.monitor.status.offline";
  if (status === "never_connected") return "mobile.projects.monitor.status.neverConnected";
  return "mobile.projects.monitor.status.unknown";
}

/**
 * Se un server ha qualcosa di DAVVERO rotto: è offline, o ha controlli giù.
 * È l'unica condizione che accende il rosso nell'app — `never_connected` non
 * è un guasto (un server appena registrato), e uno stato sconosciuto non si
 * colora per ipotesi.
 */
export function serverIsBroken(server: { status: ServerStatusValue; checksDown: number }): boolean {
  return server.status === "offline" || server.checksDown > 0;
}

/**
 * «12 min», «adesso»: quanto tempo fa, nella stessa forma compatta delle card
 * d'inbox (`mobile.inbox.time.*`) — un solo vocabolario per le durate brevi
 * in tutta l'app.
 */
export function agoLabel(
  iso: string,
  t: (key: string, options?: Record<string, unknown>) => string,
  now: number = Date.now(),
): string {
  const relative = relativeTimeCompact(iso, now);
  return relative.kind === "now"
    ? t("mobile.inbox.time.now")
    : t(`mobile.inbox.time.${relative.kind}`, { count: relative.count });
}
