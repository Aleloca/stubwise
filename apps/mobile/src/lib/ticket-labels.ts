import { isUnknown } from "@stubwise/shared";
import type { Reader, TicketPriority, TicketStatus, TicketType } from "@stubwise/shared";
import type { TFunction } from "i18next";
import { openedSince } from "./format";

/**
 * Gli stati, le priorità e i tipi di un ticket, in parole.
 *
 * ⚠️ **Le chiavi i18n sono quelle di altre sezioni** (`mobile.search.*` per
 * gli stati, `mobile.inbox.pulse.priority.*` per le priorità) e NON sono
 * ricopiate qui sotto un `mobile.work.*` nuovo. È deliberato: sono le stesse
 * sei parole, e una seconda copia significa che il giorno in cui uno stato
 * cambia nome una superficie resta indietro — esattamente il difetto che
 * questo repo insegue altrove (due regole scritte in due lingue). Il posto
 * che DECIDE quale chiave usare è questo, uno solo; le traduzioni restano
 * dove sono già tradotte.
 *
 * `UNKNOWN` (uno stato che questa build non conosce, `readerSchema`) non
 * degrada al valore grezzo: ha una parola sua, come in `pulse-line.ts`.
 *
 * ⚠️ **Il TIPO fa eccezione alla regola qui sopra, e va detto perché**: le
 * sue chiavi sono NUOVE (`mobile.work.ticketType.*`, 22 set 2026) e non
 * riusate da un'altra sezione, perché in nessun catalogo dell'app esistevano
 * — verificato sui due file i18n prima di scriverle, non assunto. La regola
 * non era «non creare chiavi», era «non ricopiare parole già tradotte»: qui
 * non c'era niente da ricopiare.
 */
export const TICKET_STATUSES: TicketStatus[] = ["open", "triaged", "in_progress", "in_review", "done", "closed"];

export const TICKET_PRIORITIES: TicketPriority[] = ["low", "medium", "high", "urgent"];

export function ticketStatusLabel(status: Reader<TicketStatus>, t: TFunction): string {
  if (isUnknown(status)) return t("mobile.search.ticketStatus.unknown");
  return t(`mobile.search.ticketStatus.${status}`);
}

export function ticketPriorityLabel(priority: Reader<TicketPriority>, t: TFunction): string {
  if (isUnknown(priority)) return t("mobile.search.ticketStatus.unknown");
  return t(`mobile.inbox.pulse.priority.${priority}`);
}

export const TICKET_TYPES: TicketType[] = ["bug", "feature", "task", "feedback", "review"];

export function ticketTypeLabel(type: Reader<TicketType>, t: TFunction): string {
  if (isUnknown(type)) return t("mobile.search.ticketStatus.unknown");
  return t(`mobile.work.ticketType.${type}`);
}

/**
 * La riga grigia di testa di un ticket: `#27 · urgente · guasto · aperto 2
 * mesi` (22 set 2026, design §3).
 *
 * ⚠️ **I pezzi assenti si omettono CON il loro separatore**: una riga
 * `#27 · · bug` è peggio di `#27 · bug`. I tre campi arrivano `.optional()`
 * da un server che può essere più vecchio dell'app (vedi il docblock di
 * `pulseWaitingForYouItemSchema`), quindi l'assenza è un caso normale, non
 * un guasto — e si rende come assenza, mai con un segnaposto inventato.
 * `#numero` invece c'è sempre: è nello schema dal giorno in cui il polso è
 * nato.
 *
 * ⚠️ **L'età non perde mai la sua parola** («aperto …»): sulla stessa riga
 * del titolo, a destra, vive l'altro tempo — i giorni di FERMO — e le due
 * date si distinguono solo per l'etichetta. Un numero nudo qui riaprirebbe
 * il difetto corretto sul web il 21 settembre, dove `createdAt` si leggeva
 * come «ultima attività». Chi accorcia questa riga non tolga «aperto».
 */
export function ticketHeading(
  item: {
    ticketNumber: number;
    priority?: Reader<TicketPriority>;
    type?: Reader<TicketType>;
    createdAt?: string;
  },
  t: TFunction,
  now: number = Date.now(),
): string {
  const parts: string[] = [`#${item.ticketNumber}`];
  if (item.priority !== undefined) parts.push(ticketPriorityLabel(item.priority, t));
  if (item.type !== undefined) parts.push(ticketTypeLabel(item.type, t));
  if (item.createdAt !== undefined) {
    // `null` = data illeggibile: il pezzo si omette, esattamente come un campo
    // assente. Mai un ripiego su «aperto oggi», che su un ticket di due mesi
    // sarebbe falso — vedi il docblock di {@link openedSince}.
    const opened = openedSince(item.createdAt, now);
    if (opened !== null) {
      parts.push(
        opened.kind === "today"
          ? t("mobile.work.opened.today")
          : t(`mobile.work.opened.${opened.kind}`, { count: opened.count }),
      );
    }
  }
  return parts.join(" · ");
}

