import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useProject, useProjectAutomations } from "../../data/queries";
import type { ProjectAutomationRun } from "../../data/types";
import { PageEmpty, PageError, PageSkeleton } from "../../tasks-ui/PageStates";
import { rowKeys } from "../home/blocks/BlockSection";
import { AutomationRow, Templates } from "./AutomationList";
import { NewAutomationButton } from "./AutomationsPage";
import { shortDate } from "./format";
import { RunStatusWord, codeClass, useNames } from "./shared";

// La sezione «Automations» di un progetto (`#/p/AUD/automations`, shape
// automations.md [A 22], [A 23]): le esecuzioni in corso (delle automazioni
// del progetto e delle generali che vi hanno agito), le automazioni del
// progetto e le generali che vi hanno agito. Una generale che chi guarda
// non vede resta una riga d'esecuzione senza link: codice, titolo, stato.

const rowGrid =
  "grid min-h-11 grid-cols-[96px_minmax(0,1fr)_minmax(108px,auto)_56px] items-center gap-3 rounded-md px-3 py-1.5";

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section className="flex max-w-[960px] flex-col pr-8">
      <h2 className="flex items-baseline gap-2 pb-2 text-lg font-semibold text-ink">
        {title}
        {count !== undefined && count > 0 && (
          <span className="num text-md font-normal text-ink-faint">{count}</span>
        )}
      </h2>
      {children}
    </section>
  );
}

function ProjectRunRow({ run }: { run: ProjectAutomationRun }) {
  const { t, i18n } = useTranslation();
  const started = shortDate(run.startedAt, i18n.language);
  const cells = (
    <>
      <span className={`${codeClass} truncate`}>{run.code}</span>
      <span className="truncate text-md text-ink">{run.title}</span>
      <RunStatusWord status={run.status} short />
      <span className="num text-right text-xs text-ink-faint">{started}</span>
    </>
  );
  const label = t("automations.project.runLabel", {
    code: run.code,
    title: run.title,
    status: t(`automations.runStatus.full.${run.status}`),
    date: started,
  });
  return (
    <li className="border-b border-rule">
      {run.linkable ? (
        <Link
          to="/automations/$code/runs/$n"
          params={{ code: run.automationCode, n: String(run.n) }}
          data-run-row={run.code}
          aria-label={label}
          className={`${rowGrid} transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 focus-visible:bg-ink/6`}
        >
          {cells}
        </Link>
      ) : (
        // [A 23]: una generale che non vedo — l'esecuzione c'è, l'automazione no.
        <div data-run-row-plain={run.code} className={rowGrid}>
          {cells}
        </div>
      )}
    </li>
  );
}

export function ProjectAutomationsPage({ projectCode }: { projectCode: string }) {
  const { t, i18n } = useTranslation();
  const names = useNames();
  const project = useProject(projectCode).data;
  const view = useProjectAutomations(project?.id ?? null);
  const data = view.data;
  const empty = data && data.automations.length === 0 && data.runs.length === 0;

  let body: ReactNode;
  if (view.isError) {
    body = (
      <PageError message={t("automations.project.error")} onRetry={() => void view.refetch()} />
    );
  } else if (!data) {
    body = <PageSkeleton rows={4} />;
  } else if (empty && data.general.length === 0) {
    body = data.canCreate ? (
      <div className="flex flex-col gap-6 py-2">
        <p className="max-w-[60ch] text-md text-ink-muted">
          {t("automations.project.empty", { code: projectCode })}
        </p>
        <Templates projectId={project?.id} />
      </div>
    ) : (
      <PageEmpty
        title={t("automations.project.empty", { code: projectCode })}
        body={t("automations.project.emptyNoPermission", { code: projectCode })}
      />
    );
  } else {
    body = (
      <div className="flex flex-col gap-8">
        <Section title={t("automations.project.runs")} count={data.runs.length}>
          {data.runs.length > 0 ? (
            <ul
              aria-label={t("automations.project.runs")}
              onKeyDown={rowKeys("[data-run-row]")}
              className="flex flex-col border-t border-rule"
            >
              {data.runs.map((r) => (
                <ProjectRunRow key={r.id} run={r} />
              ))}
            </ul>
          ) : (
            <p className="border-t border-rule py-3 pl-3 text-md text-ink-muted">
              {t("automations.project.noRuns")}
            </p>
          )}
        </Section>
        <Section
          title={t("automations.project.own", { code: projectCode })}
          count={data.automations.length}
        >
          {data.automations.length > 0 ? (
            <ul
              aria-label={t("automations.project.own", { code: projectCode })}
              onKeyDown={rowKeys("[data-automation-row]")}
              className="flex flex-col border-t border-rule"
            >
              {data.automations.map((a) => (
                <AutomationRow key={a.id} a={a} names={names} />
              ))}
            </ul>
          ) : (
            <p className="border-t border-rule py-3 pl-3 text-md text-ink-muted">
              {data.canCreate
                ? t("automations.project.noOwn", { code: projectCode })
                : t("automations.project.emptyNoPermission", { code: projectCode })}
            </p>
          )}
        </Section>
        {data.general.length > 0 && (
          <Section title={t("automations.project.general")} count={data.general.length}>
            <ul className="flex flex-col border-t border-rule">
              {data.general.map((g) => (
                <li key={g.id} className="border-b border-rule">
                  <Link
                    to="/automations/$code"
                    params={{ code: g.code }}
                    data-general-row={g.code}
                    className="flex min-h-14 flex-col justify-center gap-0.5 rounded-md px-3 py-2 transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 focus-visible:bg-ink/6"
                  >
                    <span className="flex min-w-0 items-baseline gap-3">
                      <span className={`${codeClass} w-16 shrink-0`}>{g.code}</span>
                      <span className="truncate text-md font-medium text-ink">{g.name}</span>
                    </span>
                    <span className="pl-19 text-sm text-ink-muted">
                      {t("automations.project.lastActed", {
                        date: shortDate(g.lastActedAt, i18n.language),
                        count: g.runCount,
                      })}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    );
  }

  return (
    <section className="flex min-h-full flex-col pb-16 pl-8">
      <header className="page-header flex shrink-0 items-center gap-3 pb-5 [--page-header-pr:32px] [--page-header-pt:32px]">
        <h1 className="text-2xl font-semibold text-ink">{t("automations.project.title")}</h1>
        {data?.canCreate && project && (
          <span className="ml-auto pr-8">
            <NewAutomationButton projectId={project.id} />
          </span>
        )}
      </header>
      {body}
    </section>
  );
}
