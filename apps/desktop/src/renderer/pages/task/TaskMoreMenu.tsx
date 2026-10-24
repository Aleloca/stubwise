import { useTranslation } from "react-i18next";
import { useActivity, useDecisionRequests, usePeople } from "../../data/queries";
import type { Department, Milestone, Project, ProjectStatus, Task } from "../../data/types";
import { taskFileName, taskToMarkdown } from "../../domain/export";
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
  const people = usePeople().data;
  const activity = useActivity(task.id).data;
  const decisions = useDecisionRequests({ taskId: task.id }).data;
  const ready = !!people && !!activity && !!decisions && !!project;

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
          {ready ? (
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
