import { useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import { useCallback, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  useArchiveRequest,
  usePeople,
  useProjects,
  useProjectStatuses,
  useReopenRequest,
  useRestoreRequest,
  useRequest,
  useRefineOf,
  useRequests,
  useStartRefineConversation,
  useTasks,
  useUpdateRequest,
} from "../../data/queries";
import type { Project, ProjectRequest, RequestLevel, RequestPatch, Task } from "../../data/types";
import { requestFileName, requestToMarkdown } from "../../domain/export";
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
import { copyText, downloadText } from "../../tasks-ui/exportFile";
import { MenuGroup, RadioItem, itemClass } from "../../tasks-ui/Menu";
import { PageError } from "../../tasks-ui/PageStates";
import { PersonChip } from "../../tasks-ui/PersonChip";
import { StatusLabel } from "../../tasks-ui/StatusLabel";
import { useToast } from "../../tasks-ui/Toast";
import { NewTaskDialog } from "../task/NewTaskDialog";
import {
  CloseIcon,
  MoreIcon,
  Section,
  ghostButton,
  smallPrimary,
  smallSecondary,
} from "../task/parts";
import { fieldButton, hoverChevron } from "../task/TaskHeader";
import { MenuButton } from "../tasks/controls";
import { SizeOptions } from "../tasks/pickers";
import { MergeDialog } from "./MergeDialog";
import { RequestStatusLabel, RequestStatusSign, RiskMark, UrgencyMark } from "./marks";
import { NextStepLine, SuggestionsSection } from "./RequestGuidance";

/** Le richieste di un progetto: l'unica route su cui si apre il pannello della richiesta. */
const REQUESTS_PATH = /^\/p\/([^/]+)\/requests\/?$/;

/**
 * Il pannello della richiesta, montato dal layout su `?request=<id>` nella
 * sezione Requests di un progetto: affiancato da 1200 px, sovrapposto sotto,
 * come quello della task (stessa larghezza, stesso Esc, stesso fuoco). Se
 * nell'indirizzo c'è anche una task, vince la task.
 */
export function RequestDetailHost() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { request?: string; task?: string; refine?: string };
  // Il codice del progetto della route: una richiesta di un altro progetto qui non c'è.
  const routeCode = useRouterState({
    select: (s) => REQUESTS_PATH.exec(s.location.pathname)?.[1] ?? null,
  });
  const docked = useMediaQuery(DOCKED_PANEL_QUERY);
  const close = useCallback(() => {
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, request: undefined }),
    } as never);
  }, [navigate]);
  const id = search.request;
  // Nel refine la richiesta è il lato della conversazione: lo monta la vista di refine.
  if (!id || !routeCode || search.task || search.refine === "1") return null;
  return (
    <DetailPanel
      mode={docked ? "docked" : "overlay"}
      label={t("requests.detail.label")}
      onClose={close}
    >
      <RequestDetail key={id} id={id} projectCode={routeCode} onClose={close} />
    </DetailPanel>
  );
}

/**
 * La barra in alto del pannello: il codice della richiesta (come quello della
 * task nel suo pannello), poi il progetto. Finché la richiesta non è caricata
 * (o non si vede) al posto del codice c'è «Request».
 */
function TopBar({
  project,
  code,
  onClose,
}: {
  project?: Project;
  code?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="page-header box-content flex h-12 shrink-0 items-center gap-2 pl-4 [--page-header-pr:8px]">
      {code ? (
        <span className="num shrink-0 text-xs font-semibold tracking-[0.02em] text-ink-muted">
          <span className="sr-only">{t("requests.detail.kind")} </span>
          {code}
        </span>
      ) : (
        <span className="shrink-0 text-xs font-semibold text-ink-muted">
          {t("requests.detail.kind")}
        </span>
      )}
      {project && (
        <span className="min-w-0 truncate text-xs text-ink-faint" title={project.name}>
          {/* Col codice della richiesta (STW-R3) il codice del progetto è già detto. */}
          {!code && <span className="num">{project.code} </span>}
          {project.name}
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
export function RequestDetail({
  id,
  projectCode,
  onClose,
}: {
  id: string;
  /** Il progetto della route: una richiesta di un altro progetto vale «non trovata». */
  projectCode?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { data: request, isPending, isError, refetch } = useRequest(id);
  const projects = useProjects().data;
  const project = projects?.find((p) => p.id === request?.projectId);
  if (isError) {
    return (
      <>
        <TopBar onClose={onClose} />
        <PageError message={t("requests.detail.error")} onRetry={() => void refetch()} />
      </>
    );
  }
  // Il progetto dice se la richiesta è di questa route: finché non c'è, si aspetta.
  if (isPending || (request && projectCode && !projects)) {
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
  if (!request || (projectCode && project?.code !== projectCode)) {
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
  const people = usePeople().data;
  const projectTasks = useTasks({ projectIds: [request.projectId] }).data;
  const statuses = useProjectStatuses(request.projectId).data;
  const archive = useArchiveRequest();
  const reopen = useReopenRequest();
  const restore = useRestoreRequest();
  const refine = useStartRefineConversation();
  const refineOf = useRefineOf(request.id).data ?? null;
  const liveRefine = refineOf !== null && refineOf.state !== "finished";
  const [converting, setConverting] = useState(false);
  const [merging, setMerging] = useState(false);

  const canEdit = can(viewer, "backlog.edit", request.projectId);
  const canConvert = can(viewer, "tickets.create", request.projectId);
  const open = isRequestOpen(request);
  const mergedInto = request.mergedIntoId
    ? all?.find((r) => r.id === request.mergedIntoId)
    : undefined;
  const related = all ? relatedRequests(request, all) : [];
  // La task nata dalla richiesta (la prima): la riga del prossimo passo parla di lei.
  const linkedTask = projectTasks?.find((x) => request.taskIds.includes(x.id)) ?? null;

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

  // L'«Undo» rimette lo stato di prima (pronta resta pronta, in rifinitura resta in rifinitura).
  const doArchive = () => {
    const before = request.status as "new" | "refining" | "ready";
    archive.mutate(request.id, {
      onSuccess: () =>
        toast.show(t("requests.detail.toast.archived"), {
          action: {
            label: t("requests.detail.undo"),
            run: () =>
              restore.mutate(
                { id: request.id, status: before },
                { onError: () => toast.error(t("requests.detail.toast.undoFailed")) },
              ),
          },
        }),
      onError: () => toast.error(t("requests.detail.toast.archiveFailed")),
    });
  };
  const doReopen = () =>
    reopen.mutate(request.id, {
      onSuccess: () => toast.show(t("requests.detail.toast.reopened")),
      onError: () => toast.error(t("requests.detail.toast.reopenFailed")),
    });
  /** La conversazione di refine della richiesta (`?refine=1`), al posto dell'elenco. */
  const openRefine = () =>
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, request: request.id, refine: "1" }),
    } as never);
  const doRefine = () =>
    refine.mutate(request.id, {
      onSuccess: openRefine,
      onError: () => toast.error(t("requests.detail.toast.refineFailed")),
    });

  // L'esportazione: le etichette nella lingua di chi esporta, i nomi risolti adesso.
  const markdown = () =>
    requestToMarkdown(
      request,
      {
        language: i18n.language,
        projectCode: project?.code ?? "",
        projectName: project?.name ?? "",
        personName: (id) => people?.find((p) => p.id === id)?.name ?? null,
        tasks: (projectTasks ?? [])
          .filter((x) => request.taskIds.includes(x.id))
          .map((x) => ({
            code: x.code,
            title: x.title,
            statusName: statuses?.find((s) => s.id === x.statusId)?.name ?? null,
          })),
      },
      t,
    );
  const copyMarkdown = () =>
    copyText(markdown()).then(
      () => toast.show(t("export.copied", { name: request.title })),
      () => toast.error(t("export.copyFailed")),
    );
  const downloadMarkdown = () => {
    const file = requestFileName(request);
    try {
      downloadText(file, markdown());
      toast.show(t("export.downloaded", { file }));
    } catch {
      toast.error(t("export.downloadFailed"));
    }
  };

  const busy = archive.isPending || reopen.isPending || restore.isPending || refine.isPending;
  const actions: ReactNode[] = [];
  if (open && canConvert) {
    actions.push(
      <button key="convert" type="button" className={smallPrimary} onClick={() => setConverting(true)}>
        {t("requests.detail.actions.convert")}
      </button>,
    );
  }
  // Una sola sessione viva per richiesta: se c'è si apre, non se ne avvia un'altra.
  if (canEdit && liveRefine) {
    actions.push(
      <button key="refine" type="button" className={smallSecondary} onClick={openRefine}>
        {t("requests.detail.actions.openRefine")}
      </button>,
    );
  } else if (
    canEdit &&
    request.mergedIntoId === null &&
    (request.status === "new" || request.status === "ready" || request.status === "refining")
  ) {
    actions.push(
      <button key="refine" type="button" className={smallSecondary} disabled={busy} onClick={doRefine}>
        {t("requests.detail.actions.refine")}
      </button>,
    );
  }
  // Una fusa non si riapre da qui: segue la richiesta in cui è confluita.
  if (canEdit && request.status === "archived" && !request.mergedIntoId) {
    actions.push(
      <button key="reopen" type="button" className={smallSecondary} disabled={busy} onClick={doReopen}>
        {t("requests.detail.actions.reopen")}
      </button>,
    );
  }
  // «Altre azioni» c'è per tutti: l'esportazione non chiede permessi.
  actions.push(
    <MenuButton
      key="more"
      menuLabel={t("requests.detail.actions.more")}
      align="right"
      ariaLabel={t("requests.detail.actions.more")}
      title={t("requests.detail.actions.more")}
      className={`${ghostButton} w-7 justify-center px-0 aria-expanded:bg-ink/8`}
      label={<MoreIcon />}
    >
      {(close) => (
        <>
          {canEdit && open && (
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
          <MenuGroup label={t("export.group")}>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={itemClass}
              onClick={() => {
                close();
                void copyMarkdown();
              }}
            >
              {t("export.copy")}
            </button>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={itemClass}
              onClick={() => {
                close();
                downloadMarkdown();
              }}
            >
              {t("export.download")}
            </button>
          </MenuGroup>
        </>
      )}
    </MenuButton>,
  );

  return (
    <article
      data-request-detail={request.id}
      className="flex flex-col pb-6"
      style={{ minWidth: DETAIL_PANEL_MIN_WIDTH - 1 }}
    >
      <TopBar project={project} code={request.code} onClose={onClose} />
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
        <Metadata request={request} canEdit={canEdit && open} />
        <Field label={t("requests.detail.fields.sent")}>
          <span className="num text-sm text-ink">{formatDate(request.createdAt, i18n.language)}</span>
        </Field>
        <NextStepLine request={request} task={linkedTask} onGoTask={goTask} />
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
          <span>
            {canEdit
              ? liveRefine
                ? t("requests.detail.refiningLive")
                : t("requests.detail.refiningIdle")
              : t("requests.detail.refiningOthers", { code: project?.code ?? "" })}
          </span>
        </p>
      )}

      {open && !canEdit && !canConvert && (
        <p className="px-4 pb-3 text-sm text-ink-muted">{t("requests.detail.whoDecides")}</p>
      )}
      <div className="flex flex-wrap items-center gap-1.5 px-4 pb-4">{actions}</div>

      {/* Una richiesta chiusa è in sola lettura: le proposte non contano più. */}
      {open && <SuggestionsSection request={request} canEdit={canEdit} />}

      <Section
        title={t("requests.detail.description")}
        empty={request.description.trim() ? undefined : t("requests.detail.noDescription")}
      >
        {request.description.trim() && <Markdown source={request.description} />}
      </Section>

      {/* Scritti nel refine con Claude: si leggono anche senza poter seguire la conversazione. */}
      {request.design?.trim() && (
        <Section title={t("requests.refine.side.design")}>
          <Markdown source={request.design} />
        </Section>
      )}
      {request.plan?.trim() && (
        <Section
          title={t("requests.refine.side.plan")}
          action={
            <span data-plan-approval="none" className="text-xs text-ink-muted">
              {t("requests.refine.side.notApproved")}
            </span>
          }
        >
          <Markdown source={request.plan} />
        </Section>
      )}

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

/**
 * Urgenza, taglia, rischio e nota sul rischio: con `backlog.edit` (e la
 * richiesta ancora aperta) ognuno si cambia dal suo menu, la nota con un
 * campo in linea; altrimenti si leggono e basta. La taglia è quella delle
 * task: convertendo la richiesta, la task nasce con la stessa.
 */
function Metadata({ request, canEdit }: { request: ProjectRequest; canEdit: boolean }) {
  const { t } = useTranslation();
  const toast = useToast();
  const update = useUpdateRequest();
  const save = (patch: RequestPatch) =>
    update.mutate(
      { id: request.id, patch },
      { onError: () => toast.error(t("requests.detail.saveFailed")) },
    );
  const f = (key: string) => t(`requests.detail.fields.${key}`);
  const menuField = (
    label: string,
    name: string,
    value: ReactNode,
    menuLabel: string,
    options: (close: () => void) => ReactNode,
  ) => (
    <Field label={label}>
      {canEdit ? (
        <MenuButton
          menuLabel={menuLabel}
          ariaLabel={t("requests.detail.fields.change", { field: label, value: name })}
          wrapperClassName="flex min-w-0 max-w-full"
          className={fieldButton}
          label={
            <>
              {value}
              {hoverChevron}
            </>
          }
        >
          {(close) => <MenuGroup>{options(close)}</MenuGroup>}
        </MenuButton>
      ) : (
        <span className="flex min-w-0 items-center">{value}</span>
      )}
    </Field>
  );
  const levelOptions = (current: RequestLevel | null, onPick: (v: RequestLevel) => void, mark: (v: RequestLevel) => ReactNode) =>
    LEVELS.map((level) => (
      <RadioItem key={level} checked={level === current} onSelect={() => onPick(level)}>
        {mark(level)}
      </RadioItem>
    ));

  return (
    <>
      {menuField(
        f("urgency"),
        t(`requests.urgency.${request.urgency}`),
        <UrgencyMark urgency={request.urgency} />,
        t("requests.detail.urgencyMenu"),
        (close) =>
          levelOptions(
            request.urgency,
            (urgency) => {
              close();
              if (urgency !== request.urgency) save({ urgency });
            },
            (level) => <UrgencyMark urgency={level} />,
          ),
      )}
      {menuField(
        f("size"),
        request.size ?? t("taskUi.size.none"),
        request.size ? (
          <span className="num text-sm font-semibold text-ink">{request.size}</span>
        ) : (
          <span className="text-sm text-ink-faint">{t("taskUi.size.none")}</span>
        ),
        t("requests.detail.sizeMenu"),
        (close) => (
          <SizeOptions
            current={request.size ?? null}
            onPick={(size) => {
              close();
              if (size !== (request.size ?? null)) save({ size });
            }}
          />
        ),
      )}
      {menuField(
        f("risk"),
        request.risk ? t(`requests.risk.${request.risk}`) : t("requests.risk.none"),
        <RiskMark risk={request.risk} />,
        t("requests.detail.riskMenu"),
        (close) => (
          <>
            <RadioItem
              checked={!request.risk}
              onSelect={() => {
                close();
                if (request.risk) save({ risk: null });
              }}
            >
              <span className="text-ink-muted">{t("requests.risk.none")}</span>
            </RadioItem>
            {levelOptions(
              request.risk ?? null,
              (risk) => {
                close();
                if (risk !== request.risk) save({ risk });
              },
              (level) => <RiskMark risk={level} />,
            )}
          </>
        ),
      )}
      {(canEdit || request.riskNote) && (
        <RiskNoteField note={request.riskNote ?? null} canEdit={canEdit} onSave={(riskNote) => save({ riskNote })} />
      )}
    </>
  );
}

const LEVELS: RequestLevel[] = ["low", "medium", "high"];

/** La nota sul rischio: una riga; un clic la rende un campo, Invio salva, Esc annulla. */
function RiskNoteField({
  note,
  canEdit,
  onSave,
}: {
  note: string | null;
  canEdit: boolean;
  onSave: (note: string | null) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<string | null>(null);
  const label = t("requests.detail.fields.riskNote");
  const commit = () => {
    const next = draft?.trim() || null;
    setDraft(null);
    if (next !== note) onSave(next);
  };
  let value: ReactNode;
  if (draft !== null) {
    value = (
      <input
        autoFocus
        aria-label={label}
        value={draft}
        maxLength={160}
        placeholder={t("requests.detail.riskNotePlaceholder")}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            // Esc annulla la modifica, non chiude il pannello.
            e.preventDefault();
            e.stopPropagation();
            setDraft(null);
          }
        }}
        className="-mx-1.5 h-8 w-[calc(100%+12px)] rounded-md border border-rule-strong bg-transparent px-1.5 text-sm text-ink placeholder:text-ink-faint"
      />
    );
  } else if (canEdit) {
    value = (
      <button
        type="button"
        onClick={() => setDraft(note ?? "")}
        aria-label={note ? `${t("requests.detail.editRiskNote")}: ${note}` : t("requests.detail.addRiskNote")}
        className={`${fieldButton} h-auto min-h-8 py-1 text-left`}
      >
        {note ? (
          <span className="min-w-0 [overflow-wrap:anywhere]">{note}</span>
        ) : (
          <span className="text-ink-faint">{t("requests.detail.addRiskNote")}</span>
        )}
      </button>
    );
  } else {
    value = <span className="py-1.5 text-sm text-ink [overflow-wrap:anywhere]">{note}</span>;
  }
  return <Field label={label}>{value}</Field>;
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
