import type { TFunction } from "i18next";
import { TODAY } from "../../data/dates";
import { formatDate } from "../../notifications/time";

// Numeri e date del Drive, sull'orologio fisso del prototipo (lo stesso
// «adesso» del livello dati: mezzogiorno del giorno fisso).

export const DRIVE_NOW = `${TODAY}T12:00:00Z`;

const KB = 1024;
const MB = 1024 * 1024;

/** «486 KB», «1.2 MB», «101 MB» (una cifra decimale sotto i 10 MB). */
export function formatSize(bytes: number, language: string): string {
  const n = (value: number, digits: number) =>
    new Intl.NumberFormat(language, { maximumFractionDigits: digits }).format(value);
  if (bytes < KB) return `${n(bytes, 0)} B`;
  if (bytes < MB) return `${n(Math.max(1, Math.round(bytes / KB)), 0)} KB`;
  const mb = bytes / MB;
  return `${n(mb, mb < 10 ? 1 : 0)} MB`;
}

/** La modifica: «2 h ago» oggi, altrimenti la data («Oct 21»). */
export function modifiedLabel(iso: string, t: TFunction, language: string): string {
  if (iso.slice(0, 10) === TODAY && iso <= DRIVE_NOW) {
    const minutes = Math.floor((Date.parse(DRIVE_NOW) - Date.parse(iso)) / 60_000);
    if (minutes < 1) return t("drive.time.now");
    if (minutes < 60) return t("drive.time.minutes", { count: minutes });
    return t("drive.time.hours", { count: Math.floor(minutes / 60) });
  }
  return formatDate(iso, language);
}
