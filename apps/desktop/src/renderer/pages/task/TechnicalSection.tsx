import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Task } from "../../data/types";
import { Chevron } from "../../tasks-ui/Menu";
import { Section, ghostButton } from "./parts";

/**
 * «Technical details»: il payload con cui un'integrazione (SDK, widget,
 * webhook…) ha mandato la task, come elenco di definizioni. Chiuso di base —
 * serve a chi indaga, non a chi legge la task — e assente se non c'è.
 */
export function TechnicalSection({ task }: { task: Task }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const entries = Object.entries(task.technical ?? {});
  if (entries.length === 0) return null;
  const source = t(`taskDetail.source.kinds.${task.source ?? "manual"}`);
  return (
    <Section
      title={t("taskDetail.technical.title")}
      count={entries.length}
      action={
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={t(open ? "taskDetail.technical.hideLabel" : "taskDetail.technical.showLabel")}
          onClick={() => setOpen((o) => !o)}
          className={ghostButton}
        >
          {t(open ? "taskDetail.technical.hide" : "taskDetail.technical.show")}
          <span
            className={`transition-transform duration-[var(--duration-fast)] ease-out ${open ? "rotate-180" : ""}`}
          >
            <Chevron />
          </span>
        </button>
      }
    >
      <div id={bodyId} hidden={!open} className="flex flex-col gap-2 [&[hidden]]:hidden">
        <p className="text-sm text-ink-muted">{t("taskDetail.technical.note", { source })}</p>
        <dl
          data-technical
          className="grid grid-cols-[minmax(0,96px)_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-md bg-ink/4 px-3 py-2.5"
        >
          {entries.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="truncate text-sm text-ink-muted" title={key}>
                {key}
              </dt>
              <dd className="num text-sm text-ink [overflow-wrap:anywhere]">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Section>
  );
}
