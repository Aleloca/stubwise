const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Tempo trascorso da `iso`, nella forma COMPATTA del canvas ("12 min", "1 h",
 * "1 g" nelle card d'inbox — mai "fa", mai una frase intera: è
 * un'etichetta mono a fianco del badge di kind).
 *
 * Ritorna un discriminante invece di una stringa già composta perché l'unità
 * ("min"/"h"/"g") è testo utente e va tradotta (`mobile.inbox.time.*`): la
 * funzione resta pura e senza `t()`, il chiamante (un componente) fa
 * l'interpolazione. `now` iniettabile per i test, stesso pattern di
 * `OfflineBanner`.
 */
export type RelativeTimeCompact =
  | { kind: "now" }
  | { kind: "minutes" | "hours" | "days"; count: number };

export function relativeTimeCompact(iso: string, now: number = Date.now()): RelativeTimeCompact {
  const elapsed = Math.max(0, now - new Date(iso).getTime());
  if (elapsed < MINUTE) return { kind: "now" };
  if (elapsed < HOUR) return { kind: "minutes", count: Math.floor(elapsed / MINUTE) };
  if (elapsed < DAY) return { kind: "hours", count: Math.floor(elapsed / HOUR) };
  return { kind: "days", count: Math.floor(elapsed / DAY) };
}

/**
 * Minuti trascorsi da `iso`, SENZA bucket — continua oltre l'ora (78, non "1
 * h"), a differenza di {@link relativeTimeCompact}: serve a `WorkingPill.tsx`
 * ("sta lavorando da N min"), dove il canvas vuole il conteggio continuo, non
 * la forma compatta dell'inbox. Stessa guardia anti clock-skew (`Math.max(0,
 * …)`) di `relativeTimeCompact`, estratta qui perché duplicarla a mano in
 * `WorkingPill.tsx` era la stessa svista già segnalata nella revisione del
 * Task 16 per `PulseIndicator`.
 */
export function elapsedMinutes(iso: string, now: number = Date.now()): number {
  return Math.floor(Math.max(0, now - new Date(iso).getTime()) / MINUTE);
}

/**
 * L'ora di un istante ISO nel formato `HH:MM`, nel fuso LOCALE di chi
 * guarda (App M3, Fase D, Task 11).
 *
 * ⚠️ **Solo per un evento CON ORARIO.** Un evento "tutto il giorno" è una
 * DATA, non un istante: il worker lo fissa a mezzanotte UTC e leggerlo con i
 * getter locali lo farebbe scivolare al giorno prima per chi sta in un fuso
 * negativo — vedi il docblock di `calendar-grid.ts` in `@stubwise/shared`,
 * dove quella scelta è presa e motivata. Per quelli non si mostra un'ora
 * affatto, si dice "tutto il giorno".
 *
 * A mano, non con `Intl`/`toLocaleTimeString`: l'app non ne usa in nessun
 * altro punto (Hermes non garantisce ICU completo su ogni piattaforma), e
 * qui non serve — `HH:MM` è lo stesso in ogni lingua che l'app parla.
 */
export function clockTime(iso: string): string {
  const at = new Date(iso);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}
