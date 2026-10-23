import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { Task } from "../../data/types";
import { inputClass } from "../../tasks-ui/Dialog";
import { Markdown } from "../../tasks-ui/Markdown";
import { useInlineUpdate } from "../tasks/pickers";
import { Section, ghostButton, smallPrimary, smallSecondary } from "./parts";

/**
 * La descrizione: markdown in sola lettura; con `tickets.edit` «Edit» la
 * apre in un campo di testo (⌘/Ctrl+Invio salva, Esc annulla).
 */
export function DescriptionSection({ task, canEdit }: { task: Task; canEdit: boolean }) {
  const { t } = useTranslation();
  const change = useInlineUpdate();
  const [draft, setDraft] = useState<string | null>(null);
  const save = () => {
    if (draft !== null && draft !== task.description) change(task, { description: draft });
    setDraft(null);
  };
  const title = t("taskDetail.description.title");

  if (draft !== null) {
    return (
      <Section title={title}>
        <textarea
          autoFocus
          aria-label={title}
          value={draft}
          rows={6}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setDraft(null);
            } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              save();
            }
          }}
          className={`${inputClass} resize-y`}
        />
        <div className="flex items-center gap-1.5">
          <span className="mr-auto text-xs text-ink-faint">{t("taskDetail.description.hint")}</span>
          <button type="button" className={smallSecondary} onClick={() => setDraft(null)}>
            {t("taskDetail.cancel")}
          </button>
          <button type="button" className={smallPrimary} onClick={save}>
            {t("taskDetail.save")}
          </button>
        </div>
      </Section>
    );
  }

  const edit = canEdit && (
    <button
      type="button"
      className={ghostButton}
      aria-label={t("taskDetail.description.edit")}
      onClick={() => setDraft(task.description)}
    >
      {task.description.trim() ? t("taskDetail.edit") : t("taskDetail.add")}
    </button>
  );

  if (!task.description.trim()) {
    return <Section title={title} empty={t("taskDetail.description.none")} action={edit} />;
  }
  return (
    <Section title={title} action={edit}>
      <Markdown source={task.description} />
    </Section>
  );
}
