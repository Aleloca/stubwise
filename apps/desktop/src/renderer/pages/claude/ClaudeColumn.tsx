import { Link, useRouterState } from "@tanstack/react-router";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { useConversations } from "../../data/queries";
import { CLAUDE_SCOPES, type ClaudeScope } from "../../data/routes";
import { can, useViewer } from "../../data/viewer";
import { ONE_LINE, columnItemClass } from "../../layout/ProjectColumn";
import { WorkingRing } from "./conversation/parts";

/** Quante conversazioni recenti stanno in colonna. */
export const RECENT_LIMIT = 8;

/**
 * La colonna della destinazione «Claude» (240 px, nessun titolo: il nome è
 * l'h1). In testa «New conversation» a tutta riga; poi gli elenchi con il
 * loro conteggio — «Working now» col punto pieno se una sessione aspetta
 * chi guarda, «Public» solo con `claude.public.view` — e, sotto un
 * filetto, «Recent»: le ultime otto conversazioni proprie, con l'anello se
 * Claude ci sta lavorando. Tutto conta solo ciò che chi guarda vede.
 */
export function ClaudeColumn() {
  const { t } = useTranslation();
  const { viewer } = useViewer();
  const location = useRouterState({ select: (s) => s.location });
  const scope = (location.search as { scope?: string }).scope;
  const onLanding = location.pathname === "/claude" && !scope;
  const live = useConversations({ scope: "live" }).data;
  const mine = useConversations({ scope: "mine" }).data;
  const canPublic = can(viewer, "claude.public.view");
  const publicRows = useConversations({ scope: "public" }, { enabled: canPublic }).data;
  const recentId = useId();
  const waiting = live?.filter((r) => r.waitsOnViewer).length ?? 0;

  const counts: Record<ClaudeScope, number | undefined> = {
    live: live?.length,
    mine: mine?.length,
    public: publicRows?.length,
    finished: undefined,
  };
  const recent = (mine ?? []).slice(0, RECENT_LIMIT);

  return (
    <nav
      aria-label={t("claude.destination.column.label")}
      className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pt-3 pb-2"
    >
      <Link
        to="/claude"
        search={{}}
        aria-current={onLanding ? "page" : undefined}
        title={t("claude.destination.column.newShortcut")}
        className="flex h-8 min-w-0 shrink-0 items-center gap-2 rounded-md border border-rule-strong px-2.5 text-md font-medium text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 active:bg-ink/10 aria-[current=page]:bg-ink/10"
      >
        <PlusGlyph />
        <span style={ONE_LINE} className="min-w-0 flex-1">
          {t("claude.destination.column.new")}
        </span>
        <kbd
          aria-hidden="true"
          className="num grid h-5 min-w-5 place-items-center rounded-[5px] border border-rule-strong px-1 text-xs font-medium text-ink-muted"
        >
          N
        </kbd>
      </Link>
      <ul className="mt-3 flex flex-col gap-px">
        {CLAUDE_SCOPES.filter((s) => s !== "public" || canPublic).map((s) => (
          <li key={s}>
            <Link
              to="/claude"
              search={{ scope: s }}
              activeOptions={{ exact: true, includeSearch: true }}
              data-scope-link={s}
              style={{ whiteSpace: "nowrap" }}
              className={columnItemClass}
            >
              <span style={ONE_LINE} className="min-w-0 flex-1">
                {t(`claude.destination.column.${s}`)}
              </span>
              {s === "live" && waiting > 0 && (
                <span
                  title={t("claude.destination.column.waiting", { count: waiting })}
                  className="grid size-3 shrink-0 place-items-center"
                >
                  <span aria-hidden="true" className="size-2 rounded-full bg-ink" />
                  <span className="sr-only">
                    {t("claude.destination.column.waiting", { count: waiting })}
                  </span>
                </span>
              )}
              {counts[s] !== undefined && (
                <span className="num shrink-0 text-sm font-normal text-ink-faint">{counts[s]}</span>
              )}
            </Link>
          </li>
        ))}
      </ul>
      <div className="mt-3 border-t border-rule pt-1">
        <p id={recentId} className="heading-group px-2.5 pt-3 pb-1.5">
          {t("claude.destination.column.recent")}
        </p>
        <ul aria-labelledby={recentId} className="flex flex-col gap-px">
          {recent.map((c) => (
            <li key={c.id}>
              <Link
                to="/claude/$id"
                params={{ id: c.id }}
                title={c.title || t("claude.destination.page.untitled")}
                style={{ whiteSpace: "nowrap" }}
                className={columnItemClass}
              >
                <span style={ONE_LINE} className="min-w-0 flex-1">
                  {c.title || t("claude.destination.page.untitled")}
                </span>
                {c.state === "working" && (
                  <WorkingRing label={t("claude.destination.column.working")} size={10} />
                )}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}

function PlusGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  );
}
