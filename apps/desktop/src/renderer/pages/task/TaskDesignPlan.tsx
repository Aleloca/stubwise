import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useRemoveTaskDesignPlan } from "../../data/queries";
import type { TaskDesignPlan } from "../../data/taskDesign";
import type { Task } from "../../data/types";
import { Markdown } from "../../tasks-ui/Markdown";
import { Section, ghostButton } from "./parts";
import { RemoveDesignPlanMenu } from "./RemoveDesignPlan";

/**
 * DESIGN e PLAN di una task (shape `design-plan-remove.md`, DP-Q2): sotto la
 * descrizione, chiuse di default, solo quando ci sono; «Remove…» nel «⋯» per
 * chi ha `tickets.edit` (DP-Q3).
 */
export function TaskDesignPlanSections({
  task,
  saved,
  canEdit,
}: {
  task: Task;
  saved: TaskDesignPlan | undefined;
  canEdit: boolean;
}) {
  const { t } = useTranslation();
  const remove = useRemoveTaskDesignPlan();
  if (!saved) return null;
  const menu = (which: "design" | "plan") =>
    canEdit ? (
      <RemoveDesignPlanMenu
        which={which}
        consequence={t(`designPlan.${which}.taskConsequence`)}
        onRemove={() => remove.mutateAsync({ taskId: task.id, which }).then(() => true)}
      />
    ) : undefined;
  return (
    <>
      {saved.design?.trim() && (
        <Collapsed title={t("designPlan.design.title")} action={menu("design")} source={saved.design} />
      )}
      {saved.plan?.trim() && (
        <Collapsed title={t("designPlan.plan.title")} action={menu("plan")} source={saved.plan} />
      )}
    </>
  );
}

function Collapsed({ title, action, source }: { title: string; action: React.ReactNode; source: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <Section
      title={title}
      action={
        <span className="flex items-center gap-1">
          <button type="button" className={ghostButton} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? t("designPlan.hide") : t("designPlan.show")}
          </button>
          {action}
        </span>
      }
    >
      {open && <Markdown source={source} />}
    </Section>
  );
}
