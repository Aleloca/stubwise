import { useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useLatestBrief, useProject } from "../../data/queries";
import type { WeeklyBrief } from "../../data/types";
import { DOCKED_PANEL_QUERY, DetailPanel } from "../../layout/useDetailPanel";
import { useMediaQuery } from "../../layout/useMediaQuery";
import { formatDate } from "../../notifications/time";
import { Markdown } from "../../tasks-ui/Markdown";
import { PageError, PageSkeleton } from "../../tasks-ui/PageStates";
import { CloseIcon, ghostButton, smallSecondary } from "../task/parts";

/**
 * L'etichetta di ogni testo scritto dall'AI (brief, report giornalieri): il
 * contorno tratteggiato è il segno di Claude nell'app (l'anello di «Claude
 * working»), qui sul testo. Un fatto — il registro decisioni — non la porta
 * mai: la differenza si vede, non si deduce.
 */
export function GeneratedTag() {
  const { t } = useTranslation();
  return (
    <span className="inline-flex h-5 shrink-0 items-center rounded-[4px] border border-dashed border-ink/45 px-1.5 text-xs font-medium whitespace-nowrap text-ink-muted">
      {t("overview.generated")}
    </span>
  );
}

/**
 * Il brief settimanale nell'«Where it stands»: «Weekly brief · Generated
 * text · Oct 19», la prima sezione («dove siamo») su due righe, «Read the
 * brief» apre il pannello di lettura (`?brief=<id>`). Il brief non si
 * rigenera da qui. Senza brief: «No brief yet · The first one arrives on
 * Monday».
 */
export function BriefCard({ projectId }: { projectId: string }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const brief = useLatestBrief(projectId);
  const open = (b: WeeklyBrief) =>
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, brief: b.id, task: undefined }),
    } as never);

  let body;
  if (brief.isError) {
    body = (
      <div role="alert" className="flex items-center gap-3">
        <p className="text-md text-ink">{t("overview.brief.error")}</p>
        <button type="button" className={smallSecondary} onClick={() => void brief.refetch()}>
          {t("taskUi.states.retry")}
        </button>
      </div>
    );
  } else if (brief.data === undefined) {
    body = (
      <div aria-busy="true" className="skeleton-breathe flex flex-col gap-2 py-1">
        <span className="h-2.5 w-[86%] rounded-sm bg-ink/8" />
        <span className="h-2.5 w-[64%] rounded-sm bg-ink/8" />
      </div>
    );
  } else if (brief.data === null) {
    body = (
      <p className="text-md text-ink-muted">
        <span className="text-ink">{t("overview.brief.none")}</span>
        {" · "}
        {t("overview.brief.firstOnMonday")}
      </p>
    );
  } else {
    const b = brief.data;
    body = (
      <div className="flex flex-col items-start gap-1.5">
        <p className="line-clamp-2 max-w-[72ch] text-md text-ink-muted">{b.headline}</p>
        <button type="button" className={`${ghostButton} -ml-2`} onClick={() => open(b)}>
          {t("overview.brief.read")}
        </button>
      </div>
    );
  }

  return (
    <div data-brief-card className="flex flex-col gap-2 border-t border-rule py-4 pl-4">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
        <h3 className="text-md font-semibold text-ink">{t("overview.brief.title")}</h3>
        {brief.data && (
          <>
            <GeneratedTag />
            <span className="num text-sm text-ink-muted">
              {formatDate(brief.data.createdAt, i18n.language)}
            </span>
          </>
        )}
      </div>
      {body}
    </div>
  );
}

/** L'Overview di un progetto: l'unica route su cui si apre il pannello del brief. */
const OVERVIEW_PATH = /^\/p\/([^/]+)\/overview\/?$/;

/**
 * Il pannello di lettura del brief, montato dal layout su `?brief=<id>`
 * nell'Overview: «Generated text» in testa, il periodo coperto, il markdown
 * intero. Come il pannello della task (affiancato da 1200 px, sovrapposto
 * sotto, Esc chiude); se nell'indirizzo c'è anche una task, vince la task.
 */
export function BriefPanelHost() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { brief?: string; task?: string };
  const routeCode = useRouterState({
    select: (s) => OVERVIEW_PATH.exec(s.location.pathname)?.[1] ?? null,
  });
  const docked = useMediaQuery(DOCKED_PANEL_QUERY);
  const close = useCallback(() => {
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, brief: undefined }),
    } as never);
  }, [navigate]);
  if (!search.brief || !routeCode || search.task) return null;
  return (
    <DetailPanel
      mode={docked ? "docked" : "overlay"}
      label={t("overview.brief.panel")}
      onClose={close}
    >
      <BriefReader projectCode={routeCode} briefId={search.brief} onClose={close} />
    </DetailPanel>
  );
}

function BriefReader({
  projectCode,
  briefId,
  onClose,
}: {
  projectCode: string;
  briefId: string;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const project = useProject(projectCode).data ?? undefined;
  const brief = useLatestBrief(project?.id ?? "");
  const b = brief.data && brief.data.id === briefId ? brief.data : null;

  let body;
  if (brief.isError) {
    body = <PageError message={t("overview.brief.error")} onRetry={() => void brief.refetch()} />;
  } else if (!project || brief.data === undefined) {
    body = <PageSkeleton rows={4} />;
  } else if (!b) {
    // Un brief che non è (più) l'ultimo, o di un altro progetto: si dice, senza inventarlo.
    body = <p className="px-4 py-6 text-md text-ink-muted">{t("overview.brief.gone")}</p>;
  } else {
    body = (
      <article className="flex flex-col gap-3 px-4 pt-2 pb-8">
        <div className="flex flex-wrap items-center gap-2">
          <GeneratedTag />
          <span className="text-sm text-ink-muted">{t("overview.brief.generatedNote")}</span>
        </div>
        <h2 className="text-xl font-semibold text-ink">
          {t("overview.brief.period", {
            from: formatDate(b.periodStart, i18n.language),
            to: formatDate(b.periodEnd, i18n.language),
          })}
        </h2>
        <Markdown source={b.summary} className="text-md text-ink" />
      </article>
    );
  }

  return (
    <>
      <div className="page-header box-content flex h-12 shrink-0 items-center gap-2 pl-4 [--page-header-pr:8px]">
        <span className="shrink-0 text-xs font-semibold text-ink-muted">
          {t("overview.brief.title")}
        </span>
        {project && (
          <span className="min-w-0 truncate text-xs text-ink-faint" title={project.name}>
            <span className="num">{project.code}</span> {project.name}
          </span>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label={t("overview.brief.close")}
          title={t("overview.brief.close")}
          className={`${ghostButton} ml-auto w-8 justify-center px-0`}
        >
          <CloseIcon />
        </button>
      </div>
      {body}
    </>
  );
}
