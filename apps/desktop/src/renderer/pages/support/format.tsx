import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { now } from "../../data/dates";
import type { SupportConversationView, SupportState } from "../../data/support";
import { Glyph } from "../automations/glyphs";

// Pezzi comuni della sezione Support (shape support.md §3, §5): lo stato in
// parole, l'attesa («waiting 3 h», in `warning` con icona oltre le 24 h
// [A 4]), il glifo del canale con il suo nome, il nome del cliente.

/** Le finestre: elenco e dettaglio insieme sopra ~1100 px; l'anteprima agganciata sopra 1400 px. */
export const SUPPORT_TWO_UP_QUERY = "(min-width: 1100px)";
export const PREVIEW_DOCKED_QUERY = "(min-width: 1400px)";

/** L'ordine dei gruppi dell'elenco [A 2] (lo stesso del livello dati). */
export const STATE_ORDER: readonly SupportState[] = [
  "waiting_us",
  "triage",
  "not_concluded",
  "request_open",
  "reply_sent",
];

/** Oltre quante ore l'attesa si segnala (`warning` con icona) [A 4]. */
const LONG_WAIT_HOURS = 24;

const minutesSince = (iso: string): number =>
  Math.max(0, Math.floor((Date.parse(now()) - Date.parse(iso)) / 60_000));

/** «45 min», «3 h», «2 d»: quanto è passato da `iso` sull'orologio del prototipo. */
export function sinceWords(iso: string, t: TFunction): string {
  const minutes = minutesSince(iso);
  if (minutes < 60) return t("support.duration.minutes", { n: minutes });
  if (minutes < 24 * 60) return t("support.duration.hours", { n: Math.floor(minutes / 60) });
  return t("support.duration.days", { n: Math.floor(minutes / (24 * 60)) });
}

export const waitsLong = (iso: string): boolean => minutesSince(iso) >= LONG_WAIT_HOURS * 60;

/** Il nome del cliente; senza nome (il widget non l'ha detto) «Anonymous visitor». */
export const customerName = (c: Pick<SupportConversationView, "customer">, t: TFunction) =>
  c.customer.name.trim() || t("support.anonymous");

/** Il nome breve (il primo) per le frasi: «Lucia last saw…». */
export const firstName = (c: Pick<SupportConversationView, "customer">, t: TFunction) =>
  customerName(c, t).split(/\s+/)[0]!;

const ClockAlert = () => (
  <Glyph size={14} className="text-warning">
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 5v3.2l2 1.3" />
  </Glyph>
);

/** «waiting 3 h»: oltre le 24 ore in `warning` con l'icona, sempre con la parola. */
export function WaitingSince({ since }: { since: string }) {
  const { t } = useTranslation();
  const long = waitsLong(since);
  return (
    <span
      className={`num inline-flex shrink-0 items-center gap-1 text-xs ${long ? "text-warning" : "text-ink-muted"}`}
    >
      {long && <ClockAlert />}
      {t("support.waiting", { time: sinceWords(since, t) })}
    </span>
  );
}

/** Il glifo del canale, 14 px, col suo nome accessibile (mai da solo). */
export function ChannelGlyph({ channel }: { channel: SupportConversationView["channel"] }) {
  const { t } = useTranslation();
  return (
    <span
      role="img"
      aria-label={t(`support.channel.${channel}`)}
      title={t(`support.channel.${channel}`)}
      className="inline-flex shrink-0 text-ink-faint"
    >
      {channel === "widget" ? (
        <Glyph size={14}>
          <path d="M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5a1.5 1.5 0 0 1-1.5 1.5H7l-3 2.5V11h.5" />
        </Glyph>
      ) : (
        <Glyph size={14}>
          <path d="m5 5.5-2.5 2.5L5 10.5M11 5.5l2.5 2.5-2.5 2.5M9 4l-2 8" />
        </Glyph>
      )}
    </span>
  );
}

/** Lo stato della conversazione in parole (mai solo un colore). */
export const stateWord = (state: SupportState, t: TFunction): string => t(`support.state.${state}`);
