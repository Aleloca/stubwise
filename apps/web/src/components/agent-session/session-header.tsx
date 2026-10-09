import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type { getAgentSession } from "../../lib/api";
import { elapsedParts } from "@stubwise/shared";
import { formatRelativeTime } from "../../lib/format";
import { catalogKey } from "./i18n-key";

export type AgentSessionDetailData = Awaited<ReturnType<typeof getAgentSession>>;

/**
 * Intestazione della vista: tipo, titolo, progetto, ticket, stato e durata (o
 * esito, se conclusa). La durata la conta il CLIENT da `startedAt`. I campi
 * additivi si difendono qui (`?? null`) anche se il client tipato li parsa: è
 * la cintura oltre le bretelle per un oggetto che non è passato da un parse.
 */
export function SessionHeader({ detail, now }: { detail: AgentSessionDetailData; now: number }) {
  const { t } = useTranslation("agents");
  const ended = detail.state === "ended";
  const outcome = detail.outcome ?? null;
  const elapsed = elapsedParts(detail.startedAt, now);

  return (
    <header className="flex flex-col gap-1">
      <span className="font-mono text-[11px] tracking-[0.14em] text-fg-faint uppercase">
        {t(`kind.${catalogKey(detail.kind)}`)}
      </span>
      <h1 className="text-lg font-semibold text-fg">{detail.title}</h1>
      <p className="flex flex-wrap items-baseline gap-x-3 text-[12px] text-fg-muted">
        {detail.projectName !== null && <span>{detail.projectName}</span>}
        {detail.ticketId !== null && detail.ticketNumber !== null && (
          <Link to="/tickets/$id" params={{ id: detail.ticketId }} className="text-fg hover:underline">
            #{detail.ticketNumber}
          </Link>
        )}
        <span>{t(`state.${catalogKey(detail.state)}`)}</span>
        {ended ? (
          <>
            {outcome !== null && <span>{t(`outcome.${catalogKey(outcome)}`)}</span>}
            <span>{formatRelativeTime(detail.lastEventAt ?? detail.startedAt, now)}</span>
          </>
        ) : (
          <span>
            {elapsed.hours > 0
              ? t("elapsed", { hours: elapsed.hours, minutes: elapsed.minutes })
              : t("elapsedMinutes", { minutes: elapsed.minutes })}
          </span>
        )}
      </p>
    </header>
  );
}
