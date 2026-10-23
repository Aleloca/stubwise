import type { TFunction } from "i18next";
import { TODAY, daysFromToday } from "../data/seed/dates";
import type { AppNotification } from "../data/types";

/** «Adesso» del prototipo: sera del giorno fisso, così le notifiche del seed sono tutte nel passato. */
export const NOW = `${TODAY}T23:00:00Z`;

export type SnoozeOption = "hour" | "tomorrow" | "days3";

export const SNOOZE_OPTIONS: SnoozeOption[] = ["hour", "tomorrow", "days3"];

/** Fino a quando rimandare: 1 h da `NOW`, domani alle 09:00, fra tre giorni alle 09:00 (UTC). */
export function snoozeTarget(option: SnoozeOption): string {
  if (option === "hour") {
    return new Date(Date.parse(NOW) + 3_600_000).toISOString().replace(".000Z", "Z");
  }
  return `${daysFromToday(option === "tomorrow" ? 1 : 3)}T09:00:00Z`;
}

export type Tab = "new" | "snoozed" | "archived";

export function isSnoozed(n: AppNotification): boolean {
  return n.snoozedUntil !== null && n.snoozedUntil > NOW;
}

export function tabOf(n: AppNotification): Tab {
  if (n.archived) return "archived";
  return isSnoozed(n) ? "snoozed" : "new";
}

/** Le non lette che stanno davvero «in arrivo»: né archiviate né rimandate. */
export function unreadCount(list: AppNotification[]): number {
  return list.filter((n) => !n.read && tabOf(n) === "new").length;
}

const day = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);

/** «2h ago», «Yesterday», «3d ago», poi la data: tutto relativo a `NOW`. */
export function relativeTime(iso: string, t: TFunction, language: string): string {
  const minutes = Math.floor((Date.parse(NOW) - Date.parse(iso)) / 60_000);
  if (minutes < 1) return t("notifications.time.now");
  if (minutes < 60) return t("notifications.time.minutes", { n: minutes });
  const days = Math.round((day(NOW) - day(iso)) / 86_400_000);
  if (days < 1) return t("notifications.time.hours", { n: Math.floor(minutes / 60) });
  if (days === 1) return t("notifications.time.yesterday");
  if (days < 7) return t("notifications.time.days", { n: days });
  return formatDate(iso, language);
}

export function formatDate(iso: string, language: string): string {
  return new Intl.DateTimeFormat(language, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(iso));
}

export function formatDateTime(iso: string, language: string): string {
  return new Intl.DateTimeFormat(language, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(new Date(iso));
}
