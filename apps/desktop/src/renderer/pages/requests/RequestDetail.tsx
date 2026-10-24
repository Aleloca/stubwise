import { useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import { useCallback, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  useArchiveRequest,
  usePeople,
  useProjects,
  useProjectStatuses,
  useReopenRequest,
  useRequest,
  useRequests,
  useStartRefine,
  useTasks,
} from "../../data/queries";
import type { Project, ProjectRequest, Task } from "../../data/types";
import { can, useViewer } from "../../data/viewer";
import { isRequestOpen, relatedRequests } from "../../domain/requests";
import {
  DETAIL_PANEL_MIN_WIDTH,
  DOCKED_PANEL_QUERY,
  DetailPanel,
} from "../../layout/useDetailPanel";
import { useMediaQuery } from "../../layout/useMediaQuery";
import { formatDate } from "../../notifications/time";
import { Markdown } from "../../tasks-ui/Markdown";
import { MenuGroup, itemClass } from "../../tasks-ui/Menu";
import { PageError } from "../../tasks-ui/PageStates";
import { PersonChip } from "../../tasks-ui/PersonChip";
import { StatusLabel } from "../../tasks-ui/StatusLabel";
import { useToast } from "../../tasks-ui/Toast";
import { NewTaskDialog } from "../task/NewTaskDialog";
import { CloseIcon, Section, ghostButton, smallPrimary, smallSecondary } from "../task/parts";
import { MenuButton } from "../tasks/controls";
import { MergeDialog } from "./MergeDialog";
import { RequestStatusLabel, RequestStatusSign, UrgencyMark } from "./marks";

/** Le richieste di un progetto: l'unica route su cui si apre il pannello della richiesta. */
const REQUESTS_PATH = /^\/p\/[^/]+\/requests\/?$/;

/**
 * Il pannello della richiesta, montato dal layout su `?request=<id>` nella
 * sezione Requests di un progetto: affiancato da 1200 px, sovrapposto sotto,
 * come quello della task (stessa larghezza, stesso Esc, stesso fuoco). Se
 * nell'indirizzo c'è anche una task, vince la task.
 */
export function RequestDetailHost() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { request?: string; task?: string };
  const onRequests = useRouterState({ select: (s) => REQUESTS_PATH.test(s.location.pathname) });
  const docked = useMediaQuery(DOCKED_PANEL_QUERY);
  const close = useCallback(() => {
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, request: undefined }),
    } as never);
  }, [navigate]);
  const id = search.request;
  if (!id || !onRequests || search.task) return null;
  return (
    <DetailPanel
      mode={docked ? "docked" : "overlay"}
      label={t("requests.detail.label")}
      onClose={close}
    >
      <RequestDetail key={id} id={id} onClose={close} />
    </DetailPanel>
  );
}

function TopBar({ project, onClose }: { project?: Project; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="page-header box-content flex h-12 shrink-0 items-center gap-2 pl-4 [--page-header-pr:8px]">
      <span className="shrink-0 text-xs font-semibold text-ink-muted">
        {t("requests.detail.kind")}
      </span>
      {project && (
        <span className="min-w-0 truncate text-xs text-ink-faint" title={project.name}>
          <span className="num">{project.code}</span> {project.name}
        </span>
      )}
      <button
        type="button"
        onClick={onClose}
        aria-label={t("requests.detail.close")}
        title={t("requests.detail.close")}
        className={`${ghostButton} ml-auto w-8 justify-center px-0`}
      >
        <CloseIcon />
      </button>
    </div>
  );
}

/**
 * Il dettaglio di una richiesta, dall'alto: titolo, stato/urgenza/data, il
 * riquadro di sola lettura (trasformata, archiviata, fusa), le azioni,
 * descrizione, chi l'ha chiesta, simili, task nate da questa. Le azioni
 * seguono i permessi: «Turn into task» con `tickets.create`, il resto con
 * `backlog.edit`; senza nessuna delle due una riga dice chi decide.
 */
export function RequestDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useTranslation();
  const { data: request, isPending, isError, refetch } = useRequest(id);
  const project = useProjects().data?.find((p) => p.id === request?.projectId);
  if (isError) {
    return (
      <>
        <TopBar onClose={onClose} />
        <PageError message={t("requests.detail.error")} onRetry={() => void refetch()} />
      </>
    );
  }
  if (isPending) {
    return (
      <>
        <TopBar onClose={onClose} />
        <div aria-busy="true" className="skeleton-breathe flex flex-col gap-4 px-4 pt-2">
          <span role="status" className="sr-only">
            {t("taskUi.states.loading")}
          </span>
          <span className="h-5 w-4/5 rounded-sm bg-ink/8" />
          <span className="h-2.5 w-1/2 rounded-sm bg-ink/8" />
          <span className="h-2.5 w-2/3 rounded-sm bg-ink/8" />
        </div>
      </>
    );
  }
  if (!request) {
    return (
      <>
        <TopBar onClose={onClose} />
        <div className="flex flex-col items-start gap-2 px-4 py-6">
          <p className="text-md font-semibold text-ink">{t("requests.detail.notFound")}</p>
          <p className="text-sm text-ink-muted">{t("requests.detail.notFoundBody")}</p>
        </div>
      </>
    );
  }
  return <RequestBody request={request} project={project} onClose={onClose} />;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="contents">
      <dt className="flex h-8 items-center text-sm text-ink-muted">{label}</dt>
      <dd className="flex min-h-8 min-w-0 items-center">{children}</dd>
    </div>
  );
}

function RequestBody({
  request,
  project,
  onClose,
}: {
  request: ProjectRequest;
  project: Project | undefined;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { viewer } = useViewer();
  const navigate = useNavigate();
  const toast = useToast();
  const all = useRequests(request.projectId).data;
  const archive = useArchiveRequest();
  const reopen = useReopenRequest();
  const refine = useStartRefine();
  const [converting, setConverting] = useState(false);
  const [merging, setMerging] = useState(false);

  const canEdit = can(viewer, "backlog.edit", request.projectId);
  const canConvert = can(viewer, "tickets.create", request.projectId);
  const open = isRequestOpen(request);
  const mergedInto = request.mergedIntoId
    ? all?.find((r) => r.id === request.mergedIntoId)
    : undefined;
  const related = all ? relatedRequests(request, all) : [];

  const goRequest = (id: string) =>
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, request: id }),
    } as never);
  const goTask = (code: string) =>
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, request: undefined, task: code }),
    } as never);

  const doArchive = () =>
    archive.mutate(request.id, {
      onSuccess: () =>
        toast.show(t("requests.detail.toast.archived"), {
          action: { label: t("requests.detail.undo"), run: () => reopen.mutate(request.id) },
        }),
      onError: () => toast.error(t("requests.detail.toast.archiveFailed")),
    });
  const doReopen = () =>
    reopen.mutate(request.id, {
      onSuccess: () => toast.show(t("requests.detail.toast.reopened")),
      onError: () => toast.error(t("requests.detail.toast.reopenFailed")),
    });
  const doRefine = () =>
    refine.mutate(request.id, {
      onSuccess: () => toast.show(t("requests.detail.toast.refining")),
      onError: () => toast.error(t("requests.detail.toast.refineFailed")),
    });

  const busy = archive.isPending || reopen.isPending || refine.isPending;
  const actions: ReactNode[] = [];
  if (open && canConvert) {
    actions.push(
      <button key="convert" type="button" className={smallPrimary} onClick={() => setConverting(true)}>
        {t("requests.detail.actions.convert")}
      </button>,
    );
  }
  if (canEdit && (request.status === "new" || request.status === "ready")) {
    actions.push(
      <button key="refine" type="button" className={smallSecondary} disabled={busy} onClick={doRefine}>
        {t("requests.detail.actions.refine")}
      </button>,
    );
  }
  if (canEdit && open) {
    actions.push(
      <MenuButton
        key="more"
        menuLabel={t("requests.detail.actions.more")}
        ariaLabel={t("requests.detail.actions.more")}
        title={t("requests.detail.actions.more")}
        className={`${ghostButton} w-7 justify-center px-0 aria-expanded:bg-ink/8`}
        label={<MoreIcon />}
      >
        {(close) => (
          <MenuGroup>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={itemClass}
              onClick={() => {
                close();
                setMerging(true);
              }}
            >
              {t("requests.detail.actions.merge")}
            </button>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={itemClass}
              onClick={() => {
                close();
                doArchive();
              }}
            >
              {t("requests.detail.actions.archive")}
            </button>
          </MenuGroup>
        )}
      </MenuButton>,
    );
  }
  if (canEdit && request.status === "archived") {
    actions.push(
      <button key="reopen" type="button" className={smallSecondary} disabled={busy} onClick={doReopen}>
        {t("requests.detail.actions.reopen")}
      </button>,
    );
  }

  return (
    <article
      data-request-detail={request.id}
      className="flex flex-col pb-6"
      style={{ minWidth: DETAIL_PANEL_MIN_WIDTH - 1 }}
    >
      <TopBar project={project} onClose={onClose} />
      <div className="px-4 pt-1 pb-3">
        <h2 className="text-xl font-semibold text-balance text-ink [overflow-wrap:anywhere]">
          {request.title}
        </h2>
      </div>
      <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 px-4 pb-3">
        <Field label={t("requests.detail.fields.status")}>
          <span className="text-ink">
            <RequestStatusLabel status={request.status} />
          </span>
        </Field>
        <Field label={t("requests.detail.fields.urgency")}>
          <UrgencyMark urgency={request.urgency} />
        </Field>
        <Field label={t("requests.detail.fields.sent")}>
          <span className="num text-sm text-ink">{formatDate(request.createdAt, i18n.language)}</span>
        </Field>
      </dl>

      <ReadOnlyBanner
        request={request}
        mergedInto={mergedInto}
        canEdit={canEdit}
        onOpenRequest={goRequest}
      />

      {request.status === "refining" && (
        <p className="mx-4 mb-3 flex items-start gap-2 text-sm text-ink-muted">
          <span className="mt-[3px]">
            <RequestStatusSign status="refining" />
          </span>
          <span>{t("requests.detail.refining")}</span>
        </p>
      )}

      {actions.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 px-4 pb-4">{actions}</div>
      ) : (
        open && (
          <p className="px-4 pb-4 text-sm text-ink-muted">{t("requests.detail.whoDecides")}</p>
        )
      )}

      <Section
        title={t("requests.detail.description")}
        empty={request.description.trim() ? undefined : t("requests.detail.noDescription")}
      >
        {request.description.trim() && <Markdown source={request.description} />}
      </Section>

      <Requesters request={request} />

      <Section
        title={t("requests.detail.similar")}
        count={related.length}
        empty={all && related.length === 0 ? t("requests.detail.noSimilar") : undefined}
      >
        {related.length > 0 && (
          <ul className="flex flex-col">
            {related.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => goRequest(r.id)}
                  className="-mx-1.5 flex min-h-8 w-[calc(100%+12px)] min-w-0 items-center gap-2 rounded-md px-1.5 text-left hover:bg-ink/6"
                >
                  <RequestStatusLabel status={r.status} compact />
                  <span className="min-w-0 flex-1 truncate text-sm text-ink" title={r.title}>
                    {r.title}
                  </span>
                  {r.mergedIntoId === request.id && (
                    <span className="shrink-0 text-xs text-ink-faint">
                      {t("requests.detail.mergedHere")}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <TasksFrom request={request} onOpen={goTask} />

      {converting && (
        <NewTaskDialog
          fromRequestId={request.id}
          onClose={() => setConverting(false)}
          onCreated={(task) => {
            setConverting(false);
            toast.show(t("requests.detail.toast.converted", { code: task.code }));
          }}
        />
      )}
      {merging && (
        <MergeDialog
          request={request}
          projectName={project?.name ?? ""}
          onClose={() => setMerging(false)}
          onMerged={(into) => {
            setMerging(false);
            toast.show(t("requests.detail.toast.merged", { title: into.title }));
          }}
        />
      )}
    </article>
  );
}

/** Trasformata, archiviata o fusa: un riquadro che dice perché qui non si cambia più niente. */
function ReadOnlyBanner({
  request,
  mergedInto,
  canEdit,
  onOpenRequest,
}: {
  request: ProjectRequest;
  mergedInto: ProjectRequest | undefined;
  canEdit: boolean;
  onOpenRequest: (id: string) => void;
}) {
  const { t } = useTranslation();
  if (request.status !== "converted" && request.status !== "archived") return null;
  let text: ReactNode;
  if (request.status === "converted") {
    text = t("requests.detail.banner.converted");
  } else if (request.mergedIntoId) {
    text = (
      <>
        {mergedInto ? (
          <button
            type="button"
            onClick={() => onOpenRequest(mergedInto.id)}
            className="block text-left font-medium text-ink underline underline-offset-4 hover:decoration-2"
          >
            {t("requests.mergedInto", { title: mergedInto.title })}
          </button>
        ) : (
          <span className="block font-medium">{t("requests.detail.banner.mergedMissing")}</span>
        )}
        <span className="mt-0.5 block text-ink-muted">{t("requests.detail.banner.mergedTail")}</span>
      </>
    );
  } else {
    text = `${t("requests.detail.banner.archived")}${canEdit ? ` ${t("requests.detail.banner.reopenHint")}` : ""}`;
  }
  return (
    <div
      role="note"
      data-read-only={request.status}
      className="mx-4 mb-3 flex items-start gap-2 rounded-md bg-ink/4 px-3 py-2.5 text-sm text-ink"
    >
      <span className="mt-[3px]">
        <RequestStatusSign status={request.status} />
      </span>
      <p className="min-w-0">{text}</p>
    </div>
  );
}

/** Chi l'ha chiesta: tutti, con «Requested N times» quando sono più d'uno. */
function Requesters({ request }: { request: ProjectRequest }) {
  const { t } = useTranslation();
  const people = usePeople().data;
  const times = request.requesterIds.length;
  return (
    <Section title={t("requests.detail.requesters")} count={times}>
      {times > 1 && (
        <p className="text-sm text-ink-muted">{t("requests.requestedTimes", { count: times })}</p>
      )}
      <ul className="flex flex-col gap-1">
        {request.requesterIds.map((id) => (
          <li key={id} className="flex min-h-7 items-center">
            <PersonChip personId={people?.some((p) => p.id === id) ? id : null} />
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** Le task nate da questa richiesta, con lo stato a cui sono: chi l'ha chiesta vede a che punto è. */
function TasksFrom({ request, onOpen }: { request: ProjectRequest; onOpen: (code: string) => void }) {
  const { t } = useTranslation();
  const tasks = useTasks({ projectIds: [request.projectId] }).data;
  const mine: Task[] = tasks ? tasks.filter((x) => request.taskIds.includes(x.id)) : [];
  return (
    <Section
      title={t("requests.detail.tasks")}
      count={mine.length}
      empty={tasks && mine.length === 0 ? t("requests.detail.noTasks") : undefined}
    >
      {mine.length > 0 && (
        <ul className="flex flex-col">
          {mine.map((task) => (
            <li key={task.id}>
              <TaskLine task={task} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function TaskLine({ task, onOpen }: { task: Task; onOpen: (code: string) => void }) {
  const status = useProjectStatuses(task.projectId).data?.find((s) => s.id === task.statusId);
  return (
    <button
      type="button"
      data-request-task={task.code}
      onClick={() => onOpen(task.code)}
      className="-mx-1.5 flex min-h-8 w-[calc(100%+12px)] min-w-0 items-center gap-2 rounded-md px-1.5 text-left hover:bg-ink/6"
    >
      <span className="num shrink-0 text-xs font-semibold text-ink">{task.code}</span>
      <span className="min-w-0 flex-1 truncate text-sm text-ink" title={task.title}>
        {task.title}
      </span>
      <span className="flex max-w-[45%] shrink-0">
        <StatusLabel status={status} />
      </span>
    </button>
  );
}

function MoreIcon() {
  return (
    <svg viewBox="0 0 16 16" width={16} height={16} fill="currentColor" aria-hidden="true" focusable="false">
      <circle cx="3.5" cy="8" r="1.25" />
      <circle cx="8" cy="8" r="1.25" />
      <circle cx="12.5" cy="8" r="1.25" />
    </svg>
  );
}
