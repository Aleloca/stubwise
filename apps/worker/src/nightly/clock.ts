/**
 * L'orologio del giro notturno (Piano B, Task B9): il fuso è FISSO,
 * `Europe/Rome` (design 2026-10-15 §3, D11). `Intl` è l'unico posto che sa dei
 * fusi; `hourCycle: "h23"` garantisce `00` a mezzanotte (`hour12: false` su ICU
 * vecchie rende `24`), come in `pulse/poller.ts`.
 *
 * Alle 02:00 di Roma il giorno UTC precedente è chiuso tutto l'anno (00:00 UTC
 * d'estate, 01:00 UTC d'inverno): per questo il default di `NIGHTLY_START` è
 * `02:00` e l'elemento `daily_report` della notte è il giorno UTC di ieri.
 */

export const NIGHTLY_TIMEZONE = "Europe/Rome";

/** `H:MM` o `HH:MM`, 00:00–23:59 (la stessa regola della validazione di `NIGHTLY_START`). */
export const NIGHTLY_START_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** Minuti dalla mezzanotte di un orario `H:MM`/`HH:MM` già validato. */
export function startMinutes(start: string): number {
  const m = NIGHTLY_START_RE.exec(start);
  if (!m) throw new RangeError(`orario non valido: ${start}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

function romeParts(now: Date): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: NIGHTLY_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  return Object.fromEntries(parts.map((p) => [p.type, p.value]));
}

/** La notte di `now`: la data di calendario `Europe/Rome`, `YYYY-MM-DD`. */
export function nightOf(now: Date): string {
  const p = romeParts(now);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Minuti dalla mezzanotte di Roma (`% 24` neutralizza il `24` delle ICU vecchie). */
export function romeMinutes(now: Date): number {
  const p = romeParts(now);
  return (Number(p.hour) % 24) * 60 + Number(p.minute);
}
