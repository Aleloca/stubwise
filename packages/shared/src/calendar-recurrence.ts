/**
 * LA RICORRENZA A PAROLE (15 set 2026, §2, Task 7): da una RRULE di Google a
 * una frase che una persona legge.
 *
 * ## Due funzioni, e la divisione fra loro non è arbitraria
 *
 * {@link parseRecurrence} è PURA e senza lingua: legge le righe grezze e ne
 * ricava una forma strutturata. {@link formatRecurrence} compone la frase, ma
 * le PAROLE non stanno qui — le chiede a chi la chiama, che le ha nel suo
 * i18n. Così la composizione (l'ordine dei pezzi, quando mettere la virgola)
 * vive in UN posto solo per web e app, mentre ogni superficie resta padrona
 * del proprio vocabolario.
 *
 * ## ⚠️ Quando non si capisce, si TACE
 *
 * Una regola che questo parser non sa leggere torna `null`, e la UI non
 * mostra niente. È deliberato, ed è la stessa dottrina di `deriveNextStep`
 * (`next-step.ts`): **una frase sbagliata su quando si ripete un
 * appuntamento è peggio di nessuna frase.** Chi legge «ogni lunedì» sotto
 * una riunione che è in realtà il secondo lunedì del mese ha
 * un'informazione falsa e non ha modo di accorgersene; chi non legge niente
 * apre Google e guarda.
 *
 * Per lo stesso motivo qui non si prova a dire tutto ciò che RFC 5545
 * permette: `EXDATE`/`RDATE` (le eccezioni) e i `BYDAY` con prefisso
 * numerico (`2MO`, «il secondo lunedì») sono IGNORATI, non tradotti male —
 * vedi i commenti sui singoli rami.
 */

/** Le sole frequenze che sappiamo dire a parole. */
export type RecurrenceFreq = "daily" | "weekly" | "monthly" | "yearly";

/**
 * Un giorno della settimana, con le stesse chiavi dell'i18n già in uso
 * (`mobile.calendar.weekdaysLong`) e le stesse due lettere di RFC 5545
 * (`MO`/`TU`/…) in minuscolo: nessuna convenzione numerica da ricordare, e
 * quindi nessun fuso o `getDay()` da sbagliare.
 */
export type RecurrenceWeekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

/** Una regola di ricorrenza nella forma che una UI sa rendere. */
export interface RecurrenceRule {
  freq: RecurrenceFreq;
  /** `INTERVAL`, sempre >= 1 («ogni 2 settimane»). Assente in RRULE = 1. */
  interval: number;
  /** I giorni di `BYDAY`, in ordine da lunedì a domenica. Vuoto se la regola non li dice. */
  byWeekday: RecurrenceWeekday[];
  /** `COUNT`: quante volte in tutto. `null` se la regola non lo dice. */
  count: number | null;
  /** `UNTIL` in forma `YYYY-MM-DD`. `null` se la regola non lo dice. */
  until: string | null;
}

const FREQS: Record<string, RecurrenceFreq> = {
  DAILY: "daily",
  WEEKLY: "weekly",
  MONTHLY: "monthly",
  YEARLY: "yearly",
};

const WEEKDAYS: Record<string, RecurrenceWeekday> = {
  MO: "mon",
  TU: "tue",
  WE: "wed",
  TH: "thu",
  FR: "fri",
  SA: "sat",
  SU: "sun",
};

/** L'ordine in cui i giorni si leggono, indipendente da quello in cui Google li manda. */
const WEEKDAY_ORDER: RecurrenceWeekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/**
 * La regola di ricorrenza, o `null` se non c'è o non sappiamo dirla.
 *
 * `null` in tutti questi casi, che per chi legge sono lo stesso — «di questo
 * non diciamo niente»:
 *  - nessuna riga `RRULE` (un evento singolo, o solo `EXDATE`/`RDATE`);
 *  - `FREQ` mancante o fuori dalle quattro che sappiamo dire (`HOURLY`,
 *    `MINUTELY`, `SECONDLY`, o un valore nuovo);
 *  - `INTERVAL` non numerico o <= 0 — una regola malformata, che preferiamo
 *    non interpretare a modo nostro.
 */
export function parseRecurrence(lines: readonly string[] | null | undefined): RecurrenceRule | null {
  if (!lines) return null;
  // Solo la prima RRULE: più di una è legale in RFC 5545 ma rarissima, e
  // comporle a parole produrrebbe una frase che nessuno riesce a leggere.
  const raw = lines.find((line) => line.trim().toUpperCase().startsWith("RRULE:"));
  if (raw === undefined) return null;

  const parts = new Map<string, string>();
  for (const chunk of raw.trim().slice(raw.trim().indexOf(":") + 1).split(";")) {
    const separator = chunk.indexOf("=");
    if (separator === -1) continue;
    parts.set(chunk.slice(0, separator).trim().toUpperCase(), chunk.slice(separator + 1).trim());
  }

  const freq = FREQS[(parts.get("FREQ") ?? "").toUpperCase()];
  if (freq === undefined) return null;

  const interval = parts.has("INTERVAL") ? Number(parts.get("INTERVAL")) : 1;
  if (!Number.isInteger(interval) || interval <= 0) return null;

  // ⚠️ I `BYDAY` con prefisso numerico (`2MO` = «il secondo lunedì») vengono
  // SCARTATI, non tradotti come se fossero `MO`: «ogni lunedì» sotto una
  // riunione mensile che cade il secondo lunedì sarebbe falso. Restano la
  // frequenza e l'intervallo, che sono veri comunque — «ogni mese» dice meno
  // ma non mente.
  const byWeekday = new Set<RecurrenceWeekday>();
  for (const token of (parts.get("BYDAY") ?? "").split(",")) {
    const day = WEEKDAYS[token.trim().toUpperCase()];
    if (day !== undefined) byWeekday.add(day);
  }

  const countRaw = parts.has("COUNT") ? Number(parts.get("COUNT")) : null;
  const count = countRaw !== null && Number.isInteger(countRaw) && countRaw > 0 ? countRaw : null;

  return {
    freq,
    interval,
    byWeekday: WEEKDAY_ORDER.filter((day) => byWeekday.has(day)),
    count,
    until: parseUntil(parts.get("UNTIL")),
  };
}

/**
 * `UNTIL` in `YYYY-MM-DD`.
 *
 * RFC 5545 lo scrive `20261231` oppure `20261231T235959Z`: a noi serve il
 * GIORNO, e prendere i primi otto caratteri è sufficiente e non dipende dal
 * fuso di chi legge — la data di fine di una ricorrenza è una data, non un
 * istante (lo stesso ragionamento degli eventi «tutto il giorno»).
 */
function parseUntil(value: string | undefined): string | null {
  if (value === undefined) return null;
  const match = /^(\d{4})(\d{2})(\d{2})/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day] = match;
  const month_ = Number(month);
  const day_ = Number(day);
  if (month_ < 1 || month_ > 12 || day_ < 1 || day_ > 31) return null;
  return `${year}-${month}-${day}`;
}

/**
 * Le parole che {@link formatRecurrence} chiede a chi la chiama.
 *
 * Le chiavi sono RELATIVE: il chiamante le aggancia al proprio namespace
 * (`calendar:recurrence.*` sul web, `mobile.calendar.recurrence.*` nell'app).
 * Servono:
 *  - `freq.daily` / `freq.weekly` / `freq.monthly` / `freq.yearly`, con
 *    `{{count}}` = l'intervallo (plurale i18next: «Ogni settimana» /
 *    «Ogni 2 settimane»);
 *  - `weekday.mon` … `weekday.sun`;
 *  - `withDays` (`{{frequency}}`, `{{days}}`), `withUntil`
 *    (`{{recurrence}}`, `{{date}}`), `withCount` (`{{recurrence}}`,
 *    `{{count}}`).
 */
export type RecurrenceTranslate = (key: string, params?: Record<string, unknown>) => string;

/**
 * La frase, composta dai pezzi che il chiamante traduce.
 *
 * L'ordine è: frequenza, poi i giorni, poi la FINE (una sola delle due —
 * `UNTIL` vince su `COUNT` se una regola malformata avesse entrambi, perché
 * una data è più utile di un conteggio a chi deve organizzarsi).
 */
export function formatRecurrence(rule: RecurrenceRule, t: RecurrenceTranslate): string {
  const frequency = t(`freq.${rule.freq}`, { count: rule.interval });
  const base =
    rule.byWeekday.length > 0
      ? t("withDays", {
          frequency,
          days: rule.byWeekday.map((day) => t(`weekday.${day}`)).join(", "),
        })
      : frequency;
  if (rule.until !== null) return t("withUntil", { recurrence: base, date: rule.until });
  if (rule.count !== null) return t("withCount", { recurrence: base, count: rule.count });
  return base;
}
