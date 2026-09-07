import { useState } from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { MilestoneProgress } from "../../components/milestone-progress";
import { ProjectTimeline } from "../../components/project-timeline";
import type { ProjectTimelineKind } from "../../lib/api";
import {
  milestonesQueryOptions,
  projectQueryOptions,
  projectTimelineQueryOptions,
} from "../../lib/queries";

const route = getRouteApi("/authed/projects/$projectId/roadmap");

/**
 * ROADMAP DI PROGETTO (Fase 5): la pagina per chi NON legge codice.
 *
 * Risponde in due tempi a "dove siamo": prima DOVE STIAMO ANDANDO (le
 * milestone aperte, con scadenza e avanzamento), poi COSA È SUCCESSO (la
 * timeline delle ultime settimane, coi brief a fare da sintesi settimanale).
 *
 * È SOLA LETTURA, per scelta: le milestone si creano e si chiudono dal
 * dettaglio progetto, i ticket dalla loro pagina. Una roadmap che è anche un
 * pannello di controllo smette di essere leggibile a colpo d'occhio, ed è a
 * colpo d'occhio che serve.
 */

/**
 * I filtri sono GRUPPI, non i dieci kind singoli: nessuno vuole distinguere
 * "milestone in scadenza" da "milestone chiusa" in una barra di filtri, e dieci
 * chip occuperebbero più spazio del contenuto che filtrano. Ogni gruppo si
 * espande nei kind che il server conosce.
 */
const FILTER_GROUPS = [
  { id: "tickets", kinds: ["ticket_opened", "ticket_done"] },
  { id: "pr", kinds: ["pr_opened", "pr_merged", "pr_closed"] },
  { id: "milestones", kinds: ["milestone_due", "milestone_closed"] },
  { id: "reports", kinds: ["report_day"] },
  { id: "decisions", kinds: ["decision"] },
  { id: "briefs", kinds: ["brief"] },
] as const satisfies readonly { id: string; kinds: readonly ProjectTimelineKind[] }[];

type FilterGroupId = (typeof FILTER_GROUPS)[number]["id"];

export function ProjectRoadmapPage() {
  const { t } = useTranslation();
  const { projectId } = route.useParams();

  const { data: project } = useSuspenseQuery(projectQueryOptions(projectId));
  const { data: milestones } = useSuspenseQuery(milestonesQueryOptions(project.id));

  // Nessun gruppo selezionato = NESSUN filtro (tutta la timeline), non "niente":
  // è la stessa convenzione della rotta, dove `kinds` assente vale "tutti".
  const [selected, setSelected] = useState<Set<FilterGroupId>>(new Set());
  const kinds: ProjectTimelineKind[] = FILTER_GROUPS.filter((group) =>
    selected.has(group.id),
  ).flatMap((group) => [...group.kinds]);

  const {
    data: timeline,
    isPending,
    isError,
  } = useQuery(projectTimelineQueryOptions(project.id, kinds));

  const openMilestones = milestones.filter((milestone) => milestone.status === "open");

  function toggle(id: FilterGroupId) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="page">
      <Link
        to="/projects/$projectId"
        params={{ projectId: project.id }}
        className="font-mono text-[11px] tracking-[0.14em] text-fg-faint uppercase transition-colors hover:text-fg-muted"
      >
        {t("projects:roadmap.back")}
      </Link>

      <header className="mt-3 border-b border-line pb-5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-xl font-semibold">{project.name}</h1>
          <span className="font-mono text-[12px] tracking-[0.12em] text-signal uppercase">
            {t("projects:roadmap.title")}
          </span>
        </div>
        <p className="mt-2 max-w-2xl text-[13px] text-fg-muted">
          {t("projects:roadmap.subtitle")}
        </p>
      </header>

      <section aria-label={t("projects:roadmap.milestonesTitle")} className="mt-8">
        <h2 className="font-mono text-[11px] tracking-[0.14em] text-fg-faint uppercase">
          {t("projects:roadmap.milestonesTitle")}
        </h2>
        {openMilestones.length === 0 ? (
          <p className="mt-3 font-mono text-[12px] text-fg-faint">
            {t("projects:roadmap.milestonesEmpty")}
          </p>
        ) : (
          <ul className="mt-2">
            {openMilestones.map((milestone) => (
              <MilestoneProgress key={milestone.id} milestone={milestone} />
            ))}
          </ul>
        )}
      </section>

      <section
        aria-label={t("projects:roadmap.timelineTitle")}
        className="mt-8 border-t border-line pt-6"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
          <h2 className="font-mono text-[11px] tracking-[0.14em] text-fg-faint uppercase">
            {t("projects:roadmap.timelineTitle")}
          </h2>
        </div>

        <div
          role="toolbar"
          aria-label={t("projects:roadmap.filters")}
          className="mt-3 flex flex-wrap gap-2"
        >
          {FILTER_GROUPS.map((group) => {
            const active = selected.has(group.id);
            return (
              <button
                key={group.id}
                type="button"
                aria-pressed={active}
                onClick={() => toggle(group.id)}
                className={`rounded-sm border px-2.5 py-1 font-mono text-[11px] tracking-[0.08em] uppercase transition-colors ${
                  active
                    ? "border-signal/60 bg-signal/10 text-signal"
                    : "border-line-strong text-fg-faint hover:border-ink-700 hover:text-fg-muted"
                }`}
              >
                {t(`projects:roadmap.filter.${group.id}`)}
              </button>
            );
          })}
        </div>

        <div className="mt-5">
          {isError ? (
            <p className="font-mono text-[12px] text-danger">{t("projects:roadmap.error")}</p>
          ) : isPending ? (
            <p className="font-mono text-[12px] text-fg-faint">{t("projects:roadmap.loading")}</p>
          ) : (
            <ProjectTimeline entries={timeline.entries} />
          )}
        </div>
      </section>
    </div>
  );
}
