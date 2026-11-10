import { Link, useRouterState } from "@tanstack/react-router";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { parseCriteria } from "../../../domain/filters";
import { usePeople, useProjects, useSettlePageEvent } from "../../../data/queries";
import type { PageAction } from "../../../data/types";
import { undoPageEvent, usePageApply, usePageUndoView } from "../../../layout/claudePanel/pageActions";
import type { Ev } from "./flow";
import { CheckGlyph, CrossGlyph, UndoneGlyph } from "./parts";

// La riga di un'azione della pagina (area 10b, Task 9; shape
// `claude-scenarios.md` §3.10): la stessa forma della riga eseguita del 10a
// — segno, verbo al passato, oggetto, a destra «Undo» — senza toast. La
// frase si compone a lettura dai valori stabili dell'evento, nella lingua di
// chi guarda (la riga della lingua esce così nella lingua nuova). «Undo» e
// lo stato li vede solo chi ha aperto la conversazione: un altro lettore
// della pubblica legge la riga chiusa (il «vedi come»). Il valore di prima
// lo sa solo il riquadro (`usePageUndoView`): la riga non lo deduce.

const K = "claude.conversation.page";

const linkClass =
  "font-medium text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink";

/** Il filtro in parole: il progetto (se chi legge lo vede) e i criteri. */
function FilterPhrase({
  action,
  viewerId,
}: {
  action: Extract<PageAction, { kind: "filter" }>;
  viewerId: string;
}) {
  const { t } = useTranslation();
  const projects = useProjects().data;
  const people = usePeople().data;
  const code = /^\/p\/([A-Z]{2,4})\//.exec(action.route)?.[1] ?? null;
  // R-G5: un progetto che chi legge non vede non si nomina.
  if (!code || !projects?.some((p) => p.code === code)) return <>{t(`${K}.filterHidden`)}</>;
  const criteria = parseCriteria(action.search.filters) ?? {};
  const details: string[] = [];
  const assignee = criteria.assigneeIds?.[0];
  if (assignee === viewerId) details.push(t(`${K}.assignedToYou`));
  else {
    const name = people?.find((p) => p.id === assignee)?.name;
    if (name) details.push(t(`${K}.assignedTo`, { name }));
  }
  const families = criteria.families ?? [];
  if (families.length === 1 && families[0] === "closed") details.push(t(`${K}.closed`));
  else if (families.includes("todo") && families.includes("active")) details.push(t(`${K}.open`));
  if (criteria.stalled) details.push(t(`${K}.stalled`));
  return (
    <Trans
      i18nKey={details.length > 0 ? `${K}.filterWith` : `${K}.filter`}
      values={{ details: details.join(" · ") }}
      components={{ obj: <span className="num font-semibold text-ink">{code}</span> }}
    />
  );
}

/** La frase dell'azione, al passato. */
function Phrase({ action, viewerId }: { action: PageAction; viewerId: string }) {
  const { t } = useTranslation();
  switch (action.kind) {
    case "language":
      return <>{t(`${K}.language.${action.to}`)}</>;
    case "theme":
      return <>{t(`${K}.theme.${action.to}`)}</>;
    case "filter":
      return <FilterPhrase action={action} viewerId={viewerId} />;
  }
}

export function PageActionRow({
  conversationId,
  event,
  viewerId,
  ownerId,
}: {
  conversationId: string;
  event: Ev<"pageAction">;
  viewerId: string;
  /** Chi ha aperto la conversazione: solo lui vede «Undo» e lo stato. */
  ownerId: string;
}) {
  const { t } = useTranslation();
  const mine = viewerId === ownerId;
  const view = usePageUndoView(event.id);
  const apply = usePageApply(event.id);
  const settle = useSettlePageEvent();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const statusRef = useRef<HTMLSpanElement>(null);
  const [focusTick, setFocusTick] = useState(0);

  // Dopo il clic il bottone sparisce: il fuoco va sul testo nuovo, mai sul body.
  useLayoutEffect(() => {
    if (focusTick > 0) statusRef.current?.focus();
  }, [focusTick]);

  // Build app: letta, non arrivata dal vivo in questa finestra (un
  // ricaricamento, un riavvio, un'altra scheda): non è partita da sola, e la
  // riga offre il gesto per applicarla adesso.
  if (apply && mine && event.status === "failed") {
    return (
      <div className="event-enter flex min-w-0 flex-wrap items-start gap-x-3 gap-y-1" data-page-action={event.action.kind} data-page-not-applied>
        <p className="flex min-h-8 min-w-0 flex-[1_1_16rem] items-start gap-2 py-1 text-md text-ink [overflow-wrap:anywhere]">
          <span className="min-w-0">
            <span className="text-ink-muted">{t(`${K}.notApplied`)}</span>
            <span className="text-ink-muted">
              {" · "}
              <Phrase action={event.action} viewerId={viewerId} />
            </span>
          </span>
        </p>
        <button
          type="button"
          onClick={apply}
          className="inline-flex h-7 shrink-0 items-center rounded-md px-2 text-sm font-semibold text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 active:bg-ink/10"
        >
          {t(`${K}.apply`)}
        </button>
      </div>
    );
  }

  if (event.status === "failed") {
    return (
      <p
        className="event-enter flex min-h-8 min-w-0 items-start gap-2 py-1 text-md text-ink [overflow-wrap:anywhere]"
        data-page-action={event.action.kind}
        data-page-failed
      >
        <span className="mt-[3px] text-critical" aria-hidden="true">
          <CrossGlyph />
        </span>
        <span className="min-w-0">
          <span className="text-critical">
            {t(`${K}.didntRun`, { reason: t(`${K}.failedReason`) })}
          </span>
          <span className="text-ink-muted">
            {" · "}
            <Phrase action={event.action} viewerId={viewerId} />
          </span>
        </span>
      </p>
    );
  }

  function undo() {
    const result = undoPageEvent(event.id);
    setFocusTick((n) => n + 1);
    // Un secondo clic (o nessun valore di prima) non scrive niente.
    if (result === "not_undoable") return;
    settle.mutate({ id: conversationId, eventId: event.id, status: result });
  }

  const outcome =
    event.status === "undone" || view === "undone"
      ? "undone"
      : event.status === "changed_after" || view === "changed_after"
        ? "changed_after"
        : view === "available"
          ? "available"
          : "gone";

  const state = ((): ReactNode => {
    switch (outcome) {
      case "available":
        return (
          <button
            type="button"
            onClick={undo}
            className="inline-flex h-7 shrink-0 items-center rounded-md px-2 text-sm font-semibold text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 active:bg-ink/10"
            data-undo-button
          >
            {t("claude.conversation.undo.undo")}
          </button>
        );
      case "undone":
        return (
          <span className="inline-flex items-center gap-1 text-ink-muted">
            <UndoneGlyph size={14} />
            {t(`${K}.undone`)}
          </span>
        );
      case "changed_after":
        return <span className="text-ink-muted">{t(`${K}.changedAfter`)}</span>;
      case "gone":
        return <span className="text-ink-muted">{t(`${K}.gone`)}</span>;
    }
  })();

  // «Show»: chi chiede ha lasciato la pagina filtrata, e il filtro vale ancora.
  const action = event.action;
  // Annullata no: lì «Show» rifarebbe ciò che chi chiede ha tolto.
  const show =
    mine &&
    action.kind === "filter" &&
    outcome !== "undone" &&
    (event.status === "done" || event.status === "changed_after") &&
    pathname !== action.route;

  return (
    <div
      className="event-enter flex min-w-0 flex-wrap items-start gap-x-3 gap-y-1"
      data-page-action={action.kind}
    >
      <p className="flex min-h-8 min-w-0 flex-[1_1_16rem] items-start gap-2 py-1 text-md text-ink [overflow-wrap:anywhere]">
        <span className="mt-[3px]" aria-hidden="true">
          <CheckGlyph />
        </span>
        <span className="min-w-0">
          <Phrase action={action} viewerId={viewerId} />
          {show && action.kind === "filter" && (
            <span className="text-ink-muted">
              {" · "}
              <Link
                to={action.route as never}
                search={action.search as never}
                className={linkClass}
              >
                {t(`${K}.show`)}
              </Link>
            </span>
          )}
        </span>
      </p>
      {mine && (
        <span
          ref={statusRef}
          tabIndex={-1}
          aria-live="polite"
          data-undo={outcome}
          className="ml-auto inline-flex min-h-8 min-w-0 max-w-full items-center justify-end rounded-sm text-sm outline-offset-2 focus-visible:outline-2 focus-visible:outline-focus"
        >
          {state}
        </span>
      )}
    </div>
  );
}
