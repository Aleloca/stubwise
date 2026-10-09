import { isUnknown } from "@stubwise/shared";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type { listAgentSessions } from "../../lib/api";
import { elapsedParts } from "../../lib/elapsed";
import { formatRelativeTime } from "../../lib/format";

export type AgentSessionRowData = Awaited<ReturnType<typeof listAgentSessions>>["live"][number];

/** Chiave del catalogo per un valore di enum aperto da `readerSchema`: l'ignoto ha la sua voce. */
function key(value: string): string {
  return isUnknown(value) ? "unknown" : value;
}

/**
 * Una riga dell'elenco `/agents`. La durata («da X») la conta il CLIENT da
 * `startedAt` e solo per le vive; le concluse mostrano esito e data. I campi
 * additivi (`lastActivity`, `outcome`) si difendono qui con `?? null`: un server
 * del solo piano A non li manda.
 */
export function SessionRow({
  session,
  now,
  live,
}: {
  session: AgentSessionRowData;
  now: number;
  live: boolean;
}) {
  const { t } = useTranslation("agents");
  const activity = session.lastActivity ?? null;
  const outcome = session.outcome ?? null;
  const elapsed = elapsedParts(session.startedAt, now);

  return (
    <li>
      <Link
        to="/agents/$id"
        params={{ id: session.id }}
        className="flex flex-col gap-1 px-4 py-3 hover:bg-ink-800"
      >
        <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-mono text-[11px] tracking-[0.14em] text-fg-faint uppercase">
            {t(`kind.${key(session.kind)}`)}
          </span>
          <span className="text-sm text-fg">{session.title}</span>
          <span className="text-[12px] text-fg-muted">
            {session.projectName ?? ""}
            {session.ticketNumber !== null ? ` #${session.ticketNumber}` : ""}
          </span>
        </span>
        <span className="flex flex-wrap items-baseline gap-x-3 text-[12px] text-fg-muted">
          <span>{live ? t(`state.${key(session.state)}`) : outcome ? t(`outcome.${key(outcome)}`) : null}</span>
          <span>
            {live
              ? elapsed.hours > 0
                ? t("elapsed", { hours: elapsed.hours, minutes: elapsed.minutes })
                : t("elapsedMinutes", { minutes: elapsed.minutes })
              : formatRelativeTime(session.lastEventAt ?? session.startedAt, now)}
          </span>
        </span>
        {live && (
          <span className="font-mono text-[12px] text-fg-faint">
            {activity
              ? t(`activity.${key(activity.kind)}`, { target: activity.target ?? "" })
              : t("activity.none")}
          </span>
        )}
      </Link>
    </li>
  );
}
