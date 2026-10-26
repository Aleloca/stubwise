import { now, TODAY } from "../../data/dates";

// Date e ore della Posta, sull'orologio fisso del prototipo (`now()`), in
// UTC come il seme: «10:42» oggi, «Oct 22» quest'anno, «Oct 22, 2025» prima.

const fmt = (language: string, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(language, { timeZone: "UTC", ...options });

/** L'ora o la data di una conversazione o di un messaggio. */
export function whenLabel(iso: string, language: string): string {
  if (iso.slice(0, 10) === TODAY) {
    return fmt(language, { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
  }
  const sameYear = iso.slice(0, 4) === TODAY.slice(0, 4);
  return fmt(language, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(new Date(iso));
}

/** Un giorno vicino in parole: «Today», «Yesterday», altrimenti come `whenLabel`. */
export function relativeDay(iso: string, language: string, words: { today: string; yesterday: string }): string {
  const day = iso.slice(0, 10);
  if (day === TODAY) return words.today;
  const yesterday = new Date(Date.parse(`${TODAY}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  if (day === yesterday) return words.yesterday;
  return whenLabel(iso, language);
}

/** «10:42» (un esito di oggi) o «Oct 22, 10:42». */
export function whenWithTime(iso: string, language: string): string {
  const time = fmt(language, { hour: "2-digit", minute: "2-digit", hour12: false }).format(
    new Date(iso),
  );
  return iso.slice(0, 10) === TODAY ? time : `${whenLabel(iso, language)}, ${time}`;
}

/** Un giorno (YYYY-MM-DD) come «Oct 29». */
export const dayLabel = (date: string, language: string): string =>
  fmt(language, { month: "short", day: "numeric" }).format(new Date(`${date.slice(0, 10)}T00:00:00Z`));

/** Una scadenza rispetto a oggi: futura, oggi o passata. */
export function dueState(date: string): "future" | "today" | "overdue" {
  const day = date.slice(0, 10);
  return day === TODAY ? "today" : day < TODAY ? "overdue" : "future";
}

/** Da quanti minuti interi è stata allineata una casella. */
export const minutesSince = (iso: string): number =>
  Math.max(0, Math.floor((Date.parse(now()) - Date.parse(iso)) / 60_000));
