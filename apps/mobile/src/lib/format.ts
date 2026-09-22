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

/**
 * Una data in forma breve `GG/MM/AA`, nel fuso LOCALE di chi guarda.
 *
 * A mano e non con `Intl`, per la stessa ragione di {@link clockTime}: Hermes
 * non garantisce un ICU completo su ogni piattaforma, e questa forma è la
 * stessa in ogni lingua che l'app parla.
 *
 * Serve dove conta QUANDO è successo qualcosa e non «quanto tempo fa»: la
 * data di CREAZIONE di una voce di backlog è un fatto che non cambia, mentre
 * l'ultimo aggiornamento è freschezza e si legge meglio in relativo
 * ({@link relativeTimeCompact}). Su una lista lunga le due domande sono
 * diverse, e mescolarle è il motivo per cui esistono entrambe.
 */
export function shortDate(iso: string): string {
  const at = new Date(iso);
  const day = String(at.getDate()).padStart(2, "0");
  const month = String(at.getMonth() + 1).padStart(2, "0");
  const year = String(at.getFullYear() % 100).padStart(2, "0");
  return `${day}/${month}/${year}`;
}

/**
 * Quando è arrivata un'email, nella forma della RIGA DI RICERCA (16 set 2026,
 * design §3.1 regola 3): `17:45` se è di oggi, `10/09 17:45` se è più
 * vecchia.
 *
 * ## ⚠️ Perché è una funzione NUOVA e non `relativeTimeCompact`
 *
 * Il design dice che «è la stessa regola che la lista MBX usa già». **Non lo
 * è**, verificato leggendo `MbxScreen.tsx`: quella lista usa
 * {@link relativeTimeCompact}, che produce «12 min / 1 h / 3 g» — tempo
 * trascorso a bucket, mai un orario e mai una data. Nessuna funzione di
 * questo modulo produceva la forma dell'anteprima approvata dal maintainer:
 * {@link clockTime} dà solo `HH:MM`, {@link shortDate} solo `GG/MM/AA`.
 *
 * **La lista MBX NON è stata cambiata per usare questa, e non è solo una
 * questione di perimetro: le due letture DEVONO restare diverse.**
 *
 * La lista MBX è ordinata per data DECRESCENTE: lì «3 g» basta, si legge più
 * in fretta di una data, e la posizione nella lista dice già il resto. I
 * risultati di ricerca **non sono ordinati per data** — sono ordinati per
 * rilevanza, e possono mescolare messaggi di mesi diversi uno sotto l'altro.
 * Lì la data VERA è l'informazione, ed è precisamente quella che il
 * maintainer ha detto che mancava («su email non c'è né data né orario di
 * arrivo»). È la stessa distinzione già scritta nel docblock di
 * {@link shortDate}: freschezza e «quando» sono due domande diverse, e
 * mescolarle è il motivo per cui esistono entrambe le forme.
 *
 * Chi un domani volesse «uniformarle» deve prima rispondere a questo, non
 * solo constatare che sono due.
 *
 * A mano e non con `Intl`, per la stessa ragione di {@link clockTime}: Hermes
 * non garantisce un ICU completo su ogni piattaforma, e `GG/MM HH:MM` è la
 * stessa forma in ogni lingua che l'app parla. `now` iniettabile per i test.
 */
export function searchMailTime(iso: string, now: number = Date.now()): string {
  const at = new Date(iso);
  const today = new Date(now);
  const sameDay =
    at.getFullYear() === today.getFullYear() &&
    at.getMonth() === today.getMonth() &&
    at.getDate() === today.getDate();
  const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  if (sameDay) return time;
  const day = String(at.getDate()).padStart(2, "0");
  const month = String(at.getMonth() + 1).padStart(2, "0");
  return `${day}/${month} ${time}`;
}

/**
 * Da quanto un ticket è APERTO, nella forma della riga grigia del dettaglio
 * progetto: «aperto 8 g fa», «aperto 2 mesi» (22 set 2026).
 *
 * ⚠️ **Perché non è un bucket in più su {@link relativeTimeCompact}.** Quella
 * si ferma ai giorni, quindi un ticket di due mesi leggerebbe «63 g» — ed
 * estenderla sarebbe la scorciatoia sbagliata: **la usa l'inbox**, e ogni
 * card più vecchia di due mesi cambierebbe testo su una superficie che
 * nessuno ha chiesto di toccare. È lo stesso precedente di
 * {@link searchMailTime}, scritta nuova il 16 settembre per non piegare
 * `relativeTimeCompact` alla riga di ricerca: quando una superficie nuova
 * vuole una forma diversa, la forma nuova nasce accanto, non dentro.
 *
 * Chi un domani volesse fonderle deve prima rispondere a questo: cosa
 * dovrebbe leggere una card d'inbox di tre mesi fa?
 *
 * Ritorna un discriminante e non una stringa composta, come le sue vicine:
 * l'unità è testo utente e la interpola il componente, così la funzione resta
 * pura e senza `t()`. `now` iniettabile per i test.
 *
 * Il mese è di 30 giorni tondi. Non è una data da calendario — è
 * un'indicazione di anzianità, e «2 mesi» per 61 giorni o per 67 dice la
 * stessa cosa utile a chi guarda un elenco di ticket fermi.
 *
 * ⚠️ **`null` per una data ILLEGGIBILE, e non un ripiego su «oggi»**: chi
 * rende la riga OMETTE il pezzo, come fa già per un campo assente. «Aperto
 * oggi» su un ticket di due mesi sarebbe un'affermazione falsa, ed è la
 * stessa ragione per cui `priority` nello schema del polso è `.optional()` e
 * non `.default("medium")` — un valore inventato è peggio di un'assenza
 * (design §4).
 *
 * È diverso dalla guardia anti clock-skew qui sotto, che invece «oggi» lo
 * dice per davvero: lì la data è leggibile e il futuro è un orologio sfasato
 * di poco, quindi il ticket È di oggi. Qui la data non c'è proprio.
 */
export type OpenedSince = { kind: "today" } | { kind: "days" | "months"; count: number };

const OPENED_MONTH_THRESHOLD_DAYS = 60;

export function openedSince(iso: string, now: number = Date.now()): OpenedSince | null {
  const at = new Date(iso).getTime();
  // Una data illeggibile non produce né «NaN g» né «aperto oggi»: non produce
  // NIENTE, e chi rende la riga salta il pezzo (vedi il docblock sopra).
  if (Number.isNaN(at)) return null;
  // Stessa guardia anti clock-skew delle altre funzioni del modulo: un
  // orologio sfasato non deve produrre un numero negativo.
  const elapsed = Math.max(0, now - at);
  const days = Math.floor(elapsed / DAY);
  if (days < 1) return { kind: "today" };
  if (days <= OPENED_MONTH_THRESHOLD_DAYS) return { kind: "days", count: days };
  return { kind: "months", count: Math.floor(days / 30) };
}

