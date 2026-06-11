const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const dateFormat = new Intl.DateTimeFormat("it-IT", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

const dateTimeFormat = new Intl.DateTimeFormat("it-IT", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/**
 * Tempo relativo compatto per liste e timeline: "adesso", "12 min fa",
 * "3 h fa", "5 g fa", poi data assoluta. `now` iniettabile per i test.
 */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const elapsed = now - new Date(iso).getTime();
  if (elapsed < MINUTE) return "adesso";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min fa`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} h fa`;
  if (elapsed < 30 * DAY) return `${Math.floor(elapsed / DAY)} g fa`;
  return dateFormat.format(new Date(iso));
}

/** Data e ora assolute (formato italiano), per i metadati del dettaglio. */
export function formatDateTime(iso: string): string {
  return dateTimeFormat.format(new Date(iso));
}

const integerFormat = new Intl.NumberFormat("it-IT", { maximumFractionDigits: 0 });

/** Intero con separatori delle migliaia (it-IT), per i conteggi token. */
export function formatTokens(value: number): string {
  return integerFormat.format(value);
}

/** Costo in USD con 4 decimali, prefisso "$" (es. "$0.0515"). */
export function formatCostUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}
