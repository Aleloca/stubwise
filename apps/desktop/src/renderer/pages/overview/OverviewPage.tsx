import { useSearch } from "@tanstack/react-router";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { useProject, useProjectPulse } from "../../data/queries";
import { useTaskKeys } from "../tasks/useTaskKeys";
import { useOpenTask } from "../home/blocks/BlockSection";
import { DecisionLog } from "./DecisionLog";
import { OpenSection } from "./OpenSection";
import { ProgressSection } from "./ProgressSection";
import { ProjectTimeline } from "./ProjectTimeline";
import { pulseParts } from "./pulseLine";
import { PulseText } from "./PulseText";
import { StalledSection } from "./StalledSection";

/**
 * L'Overview di un progetto (shape overview.md): un resoconto dall'alto in
 * basso, una colonna di lettura (fino a 960 px), nell'ordine delle tre
 * domande. h1 e riga di polso in prosa; poi «Stalled» — solo se qualcosa è
 * fermo —, «Where it stands», «What's open», la cronologia e il registro
 * decisioni. Ogni sezione ha i suoi stati: l'errore di una resta lì.
 */
export function OverviewPage({ projectCode }: { projectCode: string }) {
  const { t, i18n } = useTranslation();
  const project = useProject(projectCode).data ?? undefined;
  const pulse = useProjectPulse(project?.id ?? "");
  const body = useRef<HTMLDivElement>(null);
  const search = useSearch({ strict: false }) as { task?: string };
  const openTask = useOpenTask();
  useTaskKeys({ body, openCode: search.task, onOpen: openTask });

  const parts = project && pulse.data ? pulseParts(pulse.data, t, i18n.language) : null;

  return (
    <section className="flex min-h-full flex-col pb-16 pl-8">
      <div ref={body} className="flex w-full max-w-[960px] flex-col pr-8">
        <header className="page-header flex shrink-0 flex-col gap-1.5 pb-5 [--page-header-pr:32px] [--page-header-pt:32px]">
          <h1 className="text-2xl font-semibold text-ink">{t("project.sections.overview")}</h1>
          {parts ? (
            <p data-pulse-line className="text-md text-ink-muted">
              <PulseText parts={parts} projectCode={projectCode} />
            </p>
          ) : pulse.isError ? (
            <p className="text-md text-ink-muted">{t("overview.pulse.error")}</p>
          ) : (
            <span
              aria-hidden="true"
              className="skeleton-breathe my-1 block h-3 w-80 rounded-sm bg-ink/8"
            />
          )}
        </header>
        {project && (
          <>
            <StalledSection projectId={project.id} projectCode={project.code} />
            <ProgressSection projectId={project.id} projectCode={project.code} />
            <OpenSection projectId={project.id} projectCode={project.code} />
            <ProjectTimeline projectId={project.id} />
            <DecisionLog projectId={project.id} />
          </>
        )}
      </div>
    </section>
  );
}
