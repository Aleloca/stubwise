import { historyLineSpec, isSafeWebUrl } from "@stubwise/shared";
import type { HistoryTitle, HistoryTone, HistoryWho } from "@stubwise/shared";
import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TicketHistoryEventView, TicketHistoryView } from "../lib/api";
import { formatRelativeTime } from "../lib/format";
import { STATUS_LABEL_KEYS } from "./badges";

/** Quante righe si vedono prima di «Mostra tutto» (come nell'app). */
export const HISTORY_PREVIEW = 8;

/**
 * Il colore del pallino per tono. La REGOLA (quale tono per quale evento) è
 * `historyToneFor` di `@stubwise/shared`, la stessa dell'app: qui c'è solo il
 * colore Tailwind di ciascun tono. `sky` non è un token del tema, come
 * nell'app (`theme/tokens.ts`): sky-400 per convenzione.
 */
export const TONE_DOT_CLASS: Record<HistoryTone, string> = {
  ok: "bg-ok",
  signal: "bg-signal",
  sky: "bg-sky-400",
  danger: "bg-danger",
  faint: "bg-fg-faint",
};

/** Uno stato del ticket in parole; uno ignoto non esce grezzo. */
function statusWord(status: string, t: TFunction): string {
  const key = STATUS_LABEL_KEYS[status as keyof typeof STATUS_LABEL_KEYS];
  return key ? t(key) : t("tickets:history.statusUnknown");
}

function titleWords(title: HistoryTitle, t: TFunction): string {
  switch (title.key) {
    case "review_completed":
      return t("tickets:history.kinds.review_completed", {
        verdict: t(`tickets:history.verdict.${title.verdict}`),
      });
    case "ticket_closed":
      return t("tickets:history.kinds.ticket_closed", { status: title.status });
    case "status_changed":
      return t("tickets:history.kinds.status_changed", {
        from: statusWord(title.from, t),
        to: statusWord(title.to, t),
      });
    case "status_changed_to":
      return t("tickets:history.kinds.status_changed_to", { to: statusWord(title.to, t) });
    default:
      return t(`tickets:history.kinds.${title.key}`);
  }
}

function whoWords(who: HistoryWho | null, t: TFunction): string | null {
  if (who === null) return null;
  switch (who.key) {
    case "name":
      return who.name;
    case "agent":
      return t("tickets:history.who.agent");
    case "someone":
      return t("tickets:history.who.someone");
    case "provider":
      return t("tickets:history.who.provider", { name: who.name });
  }
}

export interface HistoryLineView {
  title: string;
  who: string | null;
  pr: string | null;
  url: string | null;
  tone: HistoryTone;
}

/**
 * Una riga della storia in parole. La regola è `historyLineSpec` di shared
 * (la stessa dell'app, `apps/mobile/src/lib/ticket-history.ts`): qui si
 * difendono i campi assenti — il web non passa sempre dal parse, vedi
 * CLAUDE.md, «quella regola NON protegge il web» — e si mettono le parole.
 */
export function historyLineFor(event: TicketHistoryEventView, t: TFunction): HistoryLineView {
  const spec = historyLineSpec({
    kind: event.kind,
    detail: event.detail ?? null,
    fromStatus: event.fromStatus ?? null,
    actor: event.actor ?? null,
    prNumber: event.prNumber ?? null,
    prUrl: event.prUrl ?? null,
    round: event.round ?? null,
  });
  const pr =
    spec.pr === null
      ? null
      : spec.pr.round === null
        ? t("tickets:history.pr", { number: spec.pr.number })
        : t("tickets:history.prCorrection", { number: spec.pr.number, round: spec.pr.round });
  return { title: titleWords(spec.title, t), who: whoWords(spec.who, t), pr, url: spec.url, tone: spec.tone };
}

/**
 * La «Storia del lavoro» del ticket: un evento per riga, dal più recente,
 * come lo calcola il server (`buildTicketHistory`, `GET
 * /api/tickets/:id/history`). Gemella della sezione dell'app
 * (`apps/mobile/src/components/work/TicketHistory.tsx`).
 *
 * Primi {@link HISTORY_PREVIEW}, poi «Mostra tutto (N)» espande sul posto. N
 * è `total` del server (il numero prima del tetto di 200), `?? events.length`
 * per un server che non lo mandasse.
 *
 * `status: "error"` = la query è fallita o il server è più vecchio della
 * rotta (404): la sezione lo dice, e il resto della pagina resta intero.
 */
export function TicketHistory({
  history,
  status,
}: {
  history: TicketHistoryView | undefined;
  status: "pending" | "error" | "success";
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  if (status === "pending") {
    return <p className="font-mono text-[12px] text-fg-faint">{t("common:loading")}</p>;
  }
  if (status === "error" || history === undefined) {
    return (
      <p className="text-[13px] text-fg-faint" data-testid="ticket-history-unavailable">
        {t("tickets:history.unavailable")}
      </p>
    );
  }

  const events = history.events ?? [];
  if (events.length === 0) {
    return (
      <p className="text-[13px] text-fg-faint" data-testid="ticket-history-empty">
        {t("tickets:history.empty")}
      </p>
    );
  }

  const total = history.total ?? events.length;
  const shown = expanded ? events : events.slice(0, HISTORY_PREVIEW);
  const hiddenCount = events.length - shown.length;

  return (
    <div>
      <ol className="flex flex-col">
        {shown.map((event, index) => {
          const line = historyLineFor(event, t);
          const meta = [line.who, line.pr].filter((part): part is string => part !== null).join(" · ");
          const content = (
            <>
              {index < shown.length - 1 && (
                <span aria-hidden className="absolute bottom-[-2px] left-[5px] top-[14px] w-px bg-line" />
              )}
              <span
                aria-hidden
                data-testid={`ticket-history-dot-${event.id}`}
                data-tone={line.tone}
                className={`absolute left-0 top-[5px] h-[11px] w-[11px] rounded-full ${TONE_DOT_CLASS[line.tone]}`}
              />
              <span className="flex flex-wrap items-baseline gap-x-2.5">
                <span className="text-[13.5px] text-fg">{line.title}</span>
                <span className="font-mono text-[11px] text-fg-faint">{formatRelativeTime(event.at)}</span>
              </span>
              {meta !== "" && <span className="block font-mono text-[11px] text-fg-muted">{meta}</span>}
            </>
          );
          const url = line.url;
          return (
            <li key={event.id} className="relative pb-3.5 pl-6" data-testid={`ticket-history-row-${event.id}`}>
              {url !== null && isSafeWebUrl(url) ? (
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={t("tickets:history.openPr")}
                  className="block rounded-sm hover:bg-ink-850 focus-visible:outline-2"
                >
                  {content}
                </a>
              ) : (
                content
              )}
            </li>
          );
        })}
      </ol>
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="font-mono text-[12px] text-signal hover:text-signal-bright"
        >
          {t("tickets:history.showAll", { count: total })}
        </button>
      )}
      {expanded && total > events.length && (
        <p className="text-[13px] text-fg-faint" data-testid="ticket-history-capped">
          {t("tickets:history.capped", { shown: events.length, total })}
        </p>
      )}
    </div>
  );
}
