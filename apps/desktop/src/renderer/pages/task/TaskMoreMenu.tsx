import { featureIntegrated } from "../../data/integration";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { WhoCanLink } from "../../components/WhoCanLink";
import {
  useActivity,
  useDecisionRequests,
  usePeople,
  useTaskDeletion,
  useTasks,
} from "../../data/queries";
import type { Department, Milestone, Project, ProjectStatus, Task } from "../../data/types";
import { taskFileName, taskToMarkdown } from "../../domain/export";
import { linksOf } from "../../domain/links";
import { copyText, downloadText } from "../../tasks-ui/exportFile";
import { MenuGroup, MenuNote, itemClass } from "../../tasks-ui/Menu";
import { useToast } from "../../tasks-ui/Toast";
import { MenuButton } from "../tasks/controls";
import { DeleteTaskDialog } from "./DeleteTaskDialog";
import { focusAfterDelete, rowAfter } from "./deleteFocus";
import { MoreIcon, ghostButton } from "./parts";

/**
 * «Altre azioni» della testata della task: l'esportazione in Markdown («Copy
 * as Markdown», «Download <CODE>.md»), per chiunque veda la task. Il testo si
 * compone al clic, con le etichette nella lingua di chi esporta; finché
 * decisioni e attività non sono arrivate il menu lo dice.
 *
 * In fondo, dopo un filetto, «Delete task…» (area 10a, shape task-delete.md):
 * accesa con `canDelete` della vista `getTaskDeletion` (anche con `busy`, che
 * lo dice il dialogo), spenta con la sua frase e «Who?» per un permesso,
 * «Checking…» finché la vista non arriva [TD 3]. Dopo l'eliminazione il
 * pannello si chiude e il fuoco va alla riga che ne prende il posto [TD 4].
 */
export function TaskMoreMenu({
  task,
  project,
  status,
  department,
  milestone,
  onClosePanel,
}: {
  task: Task;
  project: Project | undefined;
  status: ProjectStatus | undefined;
  department: Department | undefined;
  milestone: Milestone | undefined;
  /** Chiude il pannello della task (dopo l'eliminazione). */
  onClosePanel: () => void;
}) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const peopleQ = usePeople();
  const activityQ = useActivity(task.id);
  const decisionsQ = useDecisionRequests({ taskId: task.id });
  const tasksQ = useTasks();
  const deletion = useTaskDeletion(task.id);
  const [deleting, setDeleting] = useState(false);
  const reads = [peopleQ, activityQ, decisionsQ, tasksQ];
  const people = peopleQ.data;
  const activity = activityQ.data;
  const decisions = decisionsQ.data;
  const tasks = tasksQ.data;
  const ready = !!people && !!activity && !!decisions && !!tasks && !!project;
  const failed = reads.some((q) => q.isError);
  // I collegamenti come li vede la task: anche gli inversi, fra le task visibili.
  const links = () => {
    const byId = new Map(tasks!.map((x) => [x.id, x]));
    const all = [task, ...tasks!.filter((x) => x.id !== task.id)];
    return linksOf(task, all).flatMap((l) => {
      const other = byId.get(l.taskId);
      return other ? [{ kind: l.kind, code: other.code, title: other.title }] : [];
    });
  };

  const markdown = () =>
    taskToMarkdown(
      task,
      {
        language: i18n.language,
        projectCode: project!.code,
        projectName: project!.name,
        statusName: status?.name ?? null,
        departmentName: department?.name ?? null,
        milestoneName: milestone?.name ?? null,
        personName: (id) => people!.find((p) => p.id === id)?.name ?? null,
        decisions: decisions!,
        activity: activity!,
        links: links(),
      },
      t,
    );

  const copy = () =>
    copyText(markdown()).then(
      () => toast.show(t("export.copied", { name: task.code })),
      () => toast.error(t("export.copyFailed")),
    );
  const download = () => {
    const file = taskFileName(task);
    try {
      downloadText(file, markdown());
      toast.show(t("export.downloaded", { file }));
    } catch {
      toast.error(t("export.downloadFailed"));
    }
  };

  // La task non c'è più: il pannello si chiude e il fuoco va alla riga dopo.
  const leave = (next: string | null) => {
    setDeleting(false);
    onClosePanel();
    focusAfterDelete(task.code, next);
  };

  return (
    <>
      <MenuButton
        menuLabel={t("taskDetail.more", { code: task.code })}
        ariaLabel={t("taskDetail.more", { code: task.code })}
        title={t("taskDetail.more", { code: task.code })}
        align="right"
        className={`${ghostButton} w-8 justify-center px-0 aria-expanded:bg-ink/8`}
        label={<MoreIcon />}
      >
        {(close) => (
          <>
            <MenuGroup label={t("export.group")}>
              {failed ? (
                <>
                  <MenuNote>{t("export.loadFailed")}</MenuNote>
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    className={itemClass}
                    onClick={() => {
                      for (const q of reads) if (q.isError) void q.refetch();
                    }}
                  >
                    {t("export.retry")}
                  </button>
                </>
              ) : ready ? (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    className={itemClass}
                    onClick={() => {
                      close();
                      void copy();
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
                      download();
                    }}
                  >
                    <span className="flex min-w-0 flex-1 items-baseline justify-between gap-3">
                      {t("export.download")}
                      <span className="num truncate text-xs text-ink-faint">
                        {taskFileName(task)}
                      </span>
                    </span>
                  </button>
                </>
              ) : (
                <MenuNote>{t("export.preparing")}</MenuNote>
              )}
            </MenuGroup>
            {/* «Elimina task» (area 10a) non è nella fetta 1 dell'integrazione. */}
            {featureIntegrated("task-delete") && (
              <MenuGroup>
                <DeleteItem
                  state={deletion}
                  projectCode={project?.code ?? ""}
                  projectId={task.projectId}
                  onOpen={() => {
                    // Prima il fuoco torna al «⋯»: il dialogo lo ricorda come origine.
                    close();
                    setDeleting(true);
                  }}
                />
              </MenuGroup>
            )}
          </>
        )}
      </MenuButton>
      {deleting && (
        <DeleteTaskDialog
          task={task}
          projectCode={project?.code ?? ""}
          onClose={() => setDeleting(false)}
          onDeleted={leave}
          onGone={() => leave(rowAfter(task.code))}
        />
      )}
    </>
  );
}

/**
 * La voce «Delete task…» e i suoi stati: in verifica, errore con Retry,
 * accesa (`critical`), spenta con la frase del suo permesso e «Who?».
 */
function DeleteItem({
  state,
  projectCode,
  projectId,
  onOpen,
}: {
  state: ReturnType<typeof useTaskDeletion>;
  projectCode: string;
  projectId: string;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const label = t("task.delete.menu");
  // Spenta: la voce, e sotto la sua nota (12 px, a capo a 280 px).
  const off = (note: ReactNode) => (
    <>
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        aria-disabled="true"
        className={`${itemClass} cursor-default text-ink-muted hover:bg-transparent`}
      >
        {label}
      </button>
      <span className="block max-w-[280px] px-2 pb-1.5 text-xs text-pretty text-ink-muted">
        {note}
      </span>
    </>
  );
  if (state.isError)
    return (
      <>
        <MenuNote>{t("task.delete.checkFailed")}</MenuNote>
        <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          className={itemClass}
          onClick={() => void state.refetch()}
        >
          {t("task.delete.retry")}
        </button>
      </>
    );
  const view = state.data;
  if (view === undefined) return off(t("task.delete.checking"));
  // La task non si vede più: la voce non promette niente (il pannello lo dirà).
  if (view === null) return null;
  if (view.canDelete)
    return (
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        className={`${itemClass} text-critical`}
        onClick={onOpen}
      >
        {label}
      </button>
    );
  const action = view.whoAction ?? "deleteTasks";
  return off(
    <>
      {t(`task.delete.why.${action}`, { project: projectCode })}
      <span aria-hidden="true" className="text-ink-faint">
        {" · "}
      </span>
      <WhoCanLink action={action} projectId={projectId} projectCode={projectCode} menuItem />
    </>,
  );
}
