import { useTranslation } from "react-i18next";
import { useActivity, useDecisionRequests, usePeople, useTasks } from "../../data/queries";
import type { Department, Milestone, Project, ProjectStatus, Task } from "../../data/types";
import { taskFileName, taskToMarkdown } from "../../domain/export";
import { linksOf } from "../../domain/links";
import { copyText, downloadText } from "../../tasks-ui/exportFile";
import { MenuGroup, MenuNote, itemClass } from "../../tasks-ui/Menu";
import { useToast } from "../../tasks-ui/Toast";
import { MenuButton } from "../tasks/controls";
import { MoreIcon, ghostButton } from "./parts";

/**
 * «Altre azioni» della testata della task: per ora l'esportazione in
 * Markdown («Copy as Markdown», «Download <CODE>.md»), per chiunque veda la
 * task. Il testo si compone al clic, con le etichette nella lingua di chi
 * esporta; finché decisioni e attività non sono arrivate il menu lo dice.
 */
export function TaskMoreMenu({
  task,
  project,
  status,
  department,
  milestone,
}: {
  task: Task;
  project: Project | undefined;
  status: ProjectStatus | undefined;
  department: Department | undefined;
  milestone: Milestone | undefined;
}) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const peopleQ = usePeople();
  const activityQ = useActivity(task.id);
  const decisionsQ = useDecisionRequests({ taskId: task.id });
  const tasksQ = useTasks();
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

  return (
    <MenuButton
      menuLabel={t("taskDetail.more", { code: task.code })}
      ariaLabel={t("taskDetail.more", { code: task.code })}
      title={t("taskDetail.more", { code: task.code })}
      align="right"
      className={`${ghostButton} w-8 justify-center px-0 aria-expanded:bg-ink/8`}
      label={<MoreIcon />}
    >
      {(close) => (
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
                  <span className="num truncate text-xs text-ink-faint">{taskFileName(task)}</span>
                </span>
              </button>
            </>
          ) : (
            <MenuNote>{t("export.preparing")}</MenuNote>
          )}
        </MenuGroup>
      )}
    </MenuButton>
  );
}
