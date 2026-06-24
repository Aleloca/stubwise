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

/**
 * Tempo relativo "verboso" per la cronologia: "adesso" (<60s), "N minuti fa",
 * "N ore fa", "ieri" (giorno di calendario precedente), poi la data assoluta.
 * Forma estesa e con singolare/plurale, distinta dal `formatRelativeTime`
 * compatto usato altrove. `now` iniettabile per i test.
 */
export function formatRelativeTimeVerbose(iso: string, now: number = Date.now()): string {
  const then = new Date(iso);
  const elapsed = now - then.getTime();
  if (elapsed < MINUTE) return "adesso";
  if (elapsed < HOUR) {
    const minutes = Math.floor(elapsed / MINUTE);
    return `${minutes} ${minutes === 1 ? "minuto" : "minuti"} fa`;
  }
  if (elapsed < DAY) {
    const hours = Math.floor(elapsed / HOUR);
    return `${hours} ${hours === 1 ? "ora" : "ore"} fa`;
  }
  // Oltre le 24h: "ieri" se cade nel giorno di calendario precedente a quello
  // di `now`, altrimenti la data assoluta.
  const nowDate = new Date(now);
  const startOfToday = new Date(
    nowDate.getFullYear(),
    nowDate.getMonth(),
    nowDate.getDate(),
  ).getTime();
  if (then.getTime() >= startOfToday - DAY && then.getTime() < startOfToday) return "ieri";
  return dateFormat.format(then);
}

/** Data e ora assolute (formato italiano), per i metadati del dettaglio. */
export function formatDateTime(iso: string): string {
  return dateTimeFormat.format(new Date(iso));
}

/** Solo data assoluta (formato italiano), per "membro dal" e gli inviti. */
export function formatDate(iso: string): string {
  return dateFormat.format(new Date(iso));
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

const BYTE_UNITS = ["B", "KB", "MB", "GB"] as const;

/**
 * Dimensione di un file leggibile (base 1024): "512 B", "1.5 MB", "2.3 GB".
 * Unità intera per i byte, un decimale (senza zeri inutili) da KB in su. Usata
 * per le etichette degli allegati.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // Un decimale, ma "2.0 MB" → "2 MB" (niente zeri di troppo).
  const rounded = Math.round(value * 10) / 10;
  return `${rounded} ${BYTE_UNITS[unit]}`;
}

/**
 * Ricava `owner/repo` da un URL repository (`https://host/owner/repo[.git][/]`):
 * prende gli ultimi due segmenti del path, toglie `.git` e l'eventuale slash
 * finale. Ritorna `null` se l'URL non è parsabile o non ha abbastanza segmenti
 * — il chiamante può così degradare a un inserimento manuale.
 */
export function deriveFullName(repoUrl: string): string | null {
  const trimmed = repoUrl.trim();
  if (trimmed === "") return null;
  try {
    const segments = new URL(trimmed).pathname.split("/").filter((s) => s.length > 0);
    if (segments.length < 2) return null;
    const owner = segments[segments.length - 2]!;
    const repo = segments[segments.length - 1]!.replace(/\.git$/, "");
    if (owner === "" || repo === "") return null;
    return `${owner}/${repo}`;
  } catch {
    return null;
  }
}
