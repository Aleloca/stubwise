import type { SecurityEventView } from "@stubwise/shared";
import { useTranslation } from "react-i18next";
import { formatDateTime } from "../../lib/format";

/**
 * Il registro di sicurezza di un account, dal più recente: cosa è successo,
 * quando e — se non è stato l'interessato — chi. Lo mostrano Impostazioni →
 * Sicurezza (il proprio) e la pagina Team (quello di un membro, con
 * `users.manage`).
 *
 * Un `kind` che questa versione non conosce (server più nuovo) si mostra
 * col suo nome grezzo invece di sparire: è una riga di sicurezza, e un buco
 * nell'elenco direbbe meno del vero.
 */
export function SecurityEventsList({ events }: { events: SecurityEventView[] }) {
  const { t } = useTranslation();

  if (events.length === 0) {
    return <p className="font-mono text-[13px] text-fg-faint">{t("settings:security.events.empty")}</p>;
  }

  return (
    <ul className="divide-y divide-line">
      {events.map((event) => (
        <li
          key={event.id}
          className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2"
        >
          <span className="text-sm text-fg">
            {t(`settings:security.events.kinds.${event.kind}`, { defaultValue: event.kind })}
            {event.actorEmail && (
              <span className="text-fg-muted">
                {" "}
                {t("settings:security.events.by", { email: event.actorEmail })}
              </span>
            )}
          </span>
          <time dateTime={event.createdAt} className="font-mono text-[11px] text-fg-faint">
            {formatDateTime(event.createdAt)}
          </time>
        </li>
      ))}
    </ul>
  );
}
