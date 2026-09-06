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
