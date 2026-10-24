import { Link, useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStalled, useTask } from "../../data/queries";
import type { Task } from "../../data/types";
import { can, useViewer } from "../../data/viewer";
import {
  DETAIL_PANEL_MIN_WIDTH,
  DOCKED_PANEL_QUERY,
  DetailPanel,
  forcesOverlay,
} from "../../layout/useDetailPanel";
import { useMediaQuery } from "../../layout/useMediaQuery";
import { PageError } from "../../tasks-ui/PageStates";
import { Conversation } from "../claude/conversation/Conversation";
import { ActivityFeed } from "./ActivityFeed";
import { ClaudeSection } from "./ClaudeSection";
import { DecisionSection } from "./DecisionSection";
import { DescriptionSection } from "./DescriptionSection";
import { LinksSection } from "./LinksSection";
import { CloseIcon, ghostButton } from "./parts";
import { StallControl } from "./StallControl";
import { TaskHeader } from "./TaskHeader";
import { TechnicalSection } from "./TechnicalSection";

/**
 * Il pannello della task, montato dal layout su `?task=<CODE-n>` in ogni
 * route: si apre sopra la vista senza cambiare pagina. Affiancato da 1200 px,
 * sovrapposto sotto (e sempre in Planning). Chiuderlo toglie `task` dall'indirizzo e lascia il resto.
 */
export function TaskDetailHost() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { task?: string };
  const wide = useMediaQuery(DOCKED_PANEL_QUERY);
  const overlayOnly = useRouterState({ select: (s) => forcesOverlay(s.location.pathname) });
  const docked = wide && !overlayOnly;
  const code = search.task;
  const close = useCallback(() => {
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, task: undefined }),
    } as never);
  }, [navigate]);
  if (!code) return null;
  return (
    <DetailPanel
      mode={docked ? "docked" : "overlay"}
      label={t("taskDetail.label", { code })}
      onClose={close}
    >
      {/* Una task nuova riparte da capo: niente modifiche a metà della precedente. */}
      <TaskDetail key={code} code={code} onClose={close} />
    </DetailPanel>
  );
}

/** La barra in cima al pannello quando non c'è una task da mostrare: solo «Close». */
function BareTop({ code, onClose }: { code: string; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="page-header box-content flex h-12 shrink-0 items-center gap-2 pl-4 [--page-header-pr:8px]">
      <span className="num shrink-0 text-xs font-semibold tracking-[0.02em] whitespace-nowrap text-ink-muted">{code}</span>
      <button
        type="button"
        onClick={onClose}
        aria-label={t("taskDetail.close")}
        title={t("taskDetail.close")}
        className={`${ghostButton} ml-auto w-8 justify-center px-0`}
      >
        <CloseIcon />
      </button>
    </div>
  );
}

/** Lo scheletro con la forma del pannello: testata, campi, due sezioni. */
function PanelSkeleton() {
  const { t } = useTranslation();
  const bar = "rounded-sm bg-ink/8";
  return (
    <div aria-busy="true" className="skeleton-breathe flex flex-col gap-5 px-4 pt-2 pb-6">
      <span role="status" className="sr-only">
        {t("taskUi.states.loading")}
      </span>
      <div className="flex flex-col gap-2">
        <span className={`h-5 w-4/5 ${bar}`} />
        <span className={`h-5 w-1/2 ${bar}`} />
      </div>
      <div className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-3.5">
        {[56, 72, 48, 30, 40, 44].map((w, i) => (
          <div key={i} className="contents">
            <span className={`h-2.5 w-14 ${bar}`} />
            <span className={`h-2.5 ${bar}`} style={{ width: `${w}%` }} />
          </div>
        ))}
      </div>
      <span className="h-px bg-rule" />
      <div className="flex flex-col gap-2">
        <span className={`h-2.5 w-24 ${bar}`} />
        <span className={`h-2.5 w-11/12 ${bar}`} />
        <span className={`h-2.5 w-3/4 ${bar}`} />
      </div>
    </div>
  );
}

/**
 * Il dettaglio di una task, dall'alto: testata (codice, titolo, campi,
 * «Follow»), ferma, decisioni, descrizione, Claude, richiesta d'origine /
 * collegate / allegati, attività. Senza `tickets.edit` i campi si leggono e
 * basta; senza `tickets.comment` niente commenti né «Ask for a decision».
 */
export function TaskDetail({ code, onClose }: { code: string; onClose: () => void }) {
  const { t } = useTranslation();
  const { data: task, isPending, isError, refetch } = useTask(code);
  if (isError) {
    return (
      <>
        <BareTop code={code} onClose={onClose} />
        <PageError message={t("taskDetail.error")} onRetry={() => void refetch()} />
      </>
    );
  }
  if (isPending) {
    return (
      <>
        <BareTop code={code} onClose={onClose} />
        <PanelSkeleton />
      </>
    );
  }
  if (!task) {
    return (
      <>
        <BareTop code={code} onClose={onClose} />
        <div className="flex flex-col items-start gap-2 px-4 py-6">
          <p className="text-md font-semibold text-ink">{t("taskDetail.notFound")}</p>
          <p className="text-sm text-ink-muted">{t("taskDetail.notFoundBody")}</p>
        </div>
      </>
    );
  }
  return <TaskBody task={task} onClose={onClose} />;
}

function TaskBody({ task, onClose }: { task: Task; onClose: () => void }) {
  // «Follow here»: il pannello diventa la conversazione della sessione, finché non si torna.
  const [following, setFollowing] = useState<string | null>(null);
  if (following) {
    return (
      <FollowSession
        task={task}
        conversationId={following}
        onBack={() => setFollowing(null)}
        onClose={onClose}
      />
    );
  }
  return <TaskSections task={task} onClose={onClose} onFollow={setFollowing} />;
}

/**
 * La sessione di Claude seguita nel pannello: testata «AUD-91 · Claude
 * session» con «← Task» e «Open full page», sotto la conversazione nella
 * sua forma stretta (casella in fondo al pannello).
 */
function FollowSession({
  task,
  conversationId,
  onBack,
  onClose,
}: {
  task: Task;
  conversationId: string;
  onBack: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div data-follow-session={conversationId} className="flex min-h-0 flex-1 flex-col">
      <div className="page-header box-content flex h-12 shrink-0 items-center gap-1 border-b border-rule pl-2 [--page-header-pr:8px]">
        <button
          type="button"
          onClick={onBack}
          aria-label={t("taskDetail.claude.follow.backLabel", { code: task.code })}
          className={`${ghostButton} shrink-0`}
        >
          <span aria-hidden="true">←</span>
          {t("taskDetail.claude.follow.back")}
        </button>
        <h2 className="min-w-0 flex-1 truncate px-1 text-sm font-semibold text-ink">
          <span className="num">{task.code}</span>
          <span aria-hidden="true" className="px-1.5 text-ink-faint">
            ·
          </span>
          {t("taskDetail.claude.follow.title")}
        </h2>
        <Link
          to="/claude/$id"
          params={{ id: conversationId }}
          className={`${ghostButton} shrink-0`}
        >
          {t("taskDetail.claude.follow.openFull")}
        </Link>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("taskDetail.close")}
          title={t("taskDetail.close")}
          className={`${ghostButton} w-8 shrink-0 justify-center px-0`}
        >
          <CloseIcon />
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <Conversation id={conversationId} />
      </div>
    </div>
  );
}

function TaskSections({
  task,
  onClose,
  onFollow,
}: {
  task: Task;
  onClose: () => void;
  onFollow: (conversationId: string) => void;
}) {
  const { viewer } = useViewer();
  const canEdit = can(viewer, "tickets.edit", task.projectId);
  const canComment = can(viewer, "tickets.comment", task.projectId);
  const stall = useStalled({ projectIds: [task.projectId] }).data?.find(
    (row) => row.task.id === task.id,
  )?.stall;
  return (
    <article
      data-task-detail={task.code}
      className="flex flex-col pb-6"
      style={{ minWidth: DETAIL_PANEL_MIN_WIDTH - 1 }}
    >
      <TaskHeader task={task} canEdit={canEdit} onClose={onClose} />
      <StallControl task={task} stall={stall ?? null} canEdit={canEdit} />
      <DecisionSection task={task} canComment={canComment} />
      <DescriptionSection task={task} canEdit={canEdit} />
      <TechnicalSection task={task} />
      <ClaudeSection task={task} canEdit={canEdit} onFollow={onFollow} />
      <LinksSection task={task} canEdit={canEdit} />
      <ActivityFeed task={task} canComment={canComment} />
    </article>
  );
}
