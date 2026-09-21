import { isUnknown } from "@stubwise/shared";
import type { Reader, TicketPriority, TicketStatus } from "@stubwise/shared";
import type { TFunction } from "i18next";

/**
 * Gli stati e le priorità di un ticket, in parole.
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
