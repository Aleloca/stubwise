// L'orologio della build «app» (`@backend/clock`), con le firme di
// `data/seed/dates.ts`. «Oggi» è la data di Europe/Rome (`WEEK_TIME_ZONE`):
// lo stesso fuso in cui il server deriva la settimana effettiva e lo
// slittamento, così renderer e server concordano sulla settimana corrente
// anche per chi sta in un altro fuso. A differenza del prototipo «oggi»
// AVANZA mentre l'app resta aperta: al ritorno sulla finestra, e con un
// controllo al minuto. Chi ascolta (`subscribeClock`) è avvisato quando cambia
// il giorno; `TODAY` è un binding vivo per chi lo legge a ogni render.
import { WEEK_TIME_ZONE } from "@stubwise/shared";
import { addDaysIso } from "../../clockMath";

export { isoWeek } from "../../clockMath";

const romeDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: WEEK_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** La data (YYYY-MM-DD) di un istante a Roma. */
function dateInRome(now: Date): string {
  return romeDate.format(now);
}

const started = new Date();

/** La data di oggi a Roma (YYYY-MM-DD): cambia con `advanceClock`. */
export let TODAY = dateInRome(started);

/** L'istante in cui la finestra è partita (ISO). */
export const CLOCK_START = started.toISOString();

/** Data ISO (YYYY-MM-DD) a `days` giorni da `TODAY` (negativi = passato). */
export function daysFromToday(days: number): string {
  return addDaysIso(TODAY, days);
}

export function today(): string {
  return TODAY;
}

const listeners = new Set<() => void>();

/** Rilegge l'ora; se il giorno è cambiato, avvisa chi ascolta. `now` per i test. */
export function advanceClock(now: Date = new Date()): void {
  const next = dateInRome(now);
  if (next === TODAY) return;
  TODAY = next;
  for (const listener of [...listeners]) listener();
}

const CHECK_MS = 60_000;
let stopTicking: (() => void) | null = null;

function startTicking(): () => void {
  const tick = () => advanceClock();
  const timer = setInterval(tick, CHECK_MS);
  const onVisible = () => {
    if (document.visibilityState === "visible") tick();
  };
  window.addEventListener("focus", tick);
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    clearInterval(timer);
    window.removeEventListener("focus", tick);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

/** Avvisa `listener` a ogni cambio di giorno; il controllo gira finché c'è qualcuno in ascolto. */
export function subscribeClock(listener: () => void): () => void {
  listeners.add(listener);
  if (!stopTicking && typeof window !== "undefined") stopTicking = startTicking();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && stopTicking) {
      stopTicking();
      stopTicking = null;
    }
  };
}
