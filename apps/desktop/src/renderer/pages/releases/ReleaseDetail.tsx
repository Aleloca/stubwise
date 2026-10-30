import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useEnvironments,
  usePeople,
  useRelease,
  useSimulateRunOutcome,
  useSimulateSeenOnServer,
} from "../../data/queries";
import type { ReleaseView, RunView } from "../../data/releases";
import { formatDate } from "../../notifications/time";
import { PageError } from "../../tasks-ui/PageStates";
import { useToast } from "../../tasks-ui/Toast";
import { PrototypeBox } from "../automations/shared";
import { ChevronGlyph } from "../preferences/glyphs";
import { smallPrimary, smallSecondary } from "../task/parts";
import { FixDialog, useExplain } from "./FixDialog";
import { clock, duration, mergedBy, nowSentence, platformOf, prCode, shortSha } from "./format";
import { ExternalGlyph, ReleaseGlyph } from "./glyphs";
import { RunLog } from "./RunLog";
import { WhoCanLink } from "../../components/WhoCanLink";

// Il dettaglio di un rilascio (`#/p/AUD/releases/AUD-V3`, shape releases.md
// §6): testata, «Now» (l'unico fondo della pagina: dove è fallito, in una
// frase, e le azioni), i «Simula» del prototipo, le run con il passo fallito
// e il log. La frase viene prima, il log dopo. Nessun «Deploy», nessun
// «Riprova»: la riga-confine lo dice dove lo si cercherebbe ([R 1]).

const linkClass =
  "inline-flex items-center gap-1 rounded-sm text-sm text-ink underline-offset-4 hover:underline";

function NowBox({ release }: { release: ReleaseView }) {
  const { t, i18n } = useTranslation();
  const [fixing, setFixing] = useState(false);
  const explain = useExplain();
  const environments = useEnvironments(release.projectId).data;
  const s = release.status;
  const run = release.runs.find((x) => x.status === "failed");
  const fixTask = release.fixTask?.open ? release.fixTask : null;
  const noPipeline =
    release.runs.length === 0 && (s.kind === "in_production" || s.kind === "not_in_production");
  // Il server della repository in produzione lo dice la vista (R-L2).
  const production = release.productionServer ?? null;

  return (
    <section
      aria-label={t("releases.now.label")}
      className="flex flex-col gap-3 rounded-lg border border-rule bg-ink/4 px-5 py-4"
    >
      <div className="flex items-start gap-2.5">
        <span className="pt-0.5">
          <ReleaseGlyph kind={s.kind} />
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <p aria-live="polite" className="text-lg font-semibold text-ink [overflow-wrap:anywhere]">
            {nowSentence(release, t, i18n.language)}
          </p>
          {s.kind === "not_in_production" && production?.serverCode && production.reportedSha && (
            <p className="num text-sm text-ink-muted">
              {t("releases.now.stillRuns", {
                server: production.serverCode,
                sha: shortSha(production.reportedSha),
              })}
            </p>
          )}
          {noPipeline && <p className="text-xs text-ink-muted">{t("releases.now.noPipeline")}</p>}
        </div>
      </div>

      {s.kind === "failed" && fixTask && (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-md text-ink">{t("releases.now.fixingIn", { task: fixTask.code })}</p>
          <Link
            to="."
            search={((prev: Record<string, unknown>) => ({ ...prev, task: fixTask.code })) as never}
            className={smallSecondary}
          >
            {t("releases.now.openTask", { task: fixTask.code })}
          </Link>
        </div>
      )}
      {s.kind === "failed" && !fixTask && (
        <div className="flex flex-wrap items-center gap-2">
          {release.canFix && (
            <button type="button" className={smallPrimary} onClick={() => setFixing(true)}>
              {t("releases.fix.button")}
            </button>
          )}
          <button
            type="button"
            className={smallSecondary}
            disabled={explain.pending}
            onClick={() => void explain.run(release)}
          >
            {t("releases.explain.button")}
          </button>
          {run && (
            <a href={run.url} target="_blank" rel="noreferrer" className={`${linkClass} ml-1`}>
              {t("releases.now.openRun", { platform: platformOf(run.url) })}
              <ExternalGlyph />
            </a>
          )}
        </div>
      )}
      {s.kind === "failed" && fixTask && (
        <div>
          <button
            type="button"
            className={smallSecondary}
            disabled={explain.pending}
            onClick={() => void explain.run(release)}
          >
            {t("releases.explain.button")}
          </button>
        </div>
      )}
      {s.kind === "failed" && !release.canFix && !fixTask && (
        <p className="text-sm text-ink-muted">
          {t("releases.fix.noPermission", { code: release.projectCode })}{" "}
          <WhoCanLink action="createTasks" projectId={release.projectId} projectCode={release.projectCode} />
        </p>
      )}
      {s.kind === "failed" && <p className="text-xs text-ink-muted">{t("releases.boundary")}</p>}
      {s.kind === "unavailable" &&
        (environments?.canManage ? (
          <Link
            to="/p/$code/$section"
            params={{ code: release.projectCode, section: "releases" }}
            hash="environments"
            data-setup-environments
            className={`${linkClass} self-start`}
          >
            {t("releases.now.setUpEnvironments")}
          </Link>
        ) : (
          <p className="text-sm text-ink-muted">
            {t("releases.now.environmentsNoPermission", { code: release.projectCode })}{" "}
            <WhoCanLink
              action="manageEnvironments"
              projectId={release.projectId}
              projectCode={release.projectCode}
            />
          </p>
        ))}
      {fixing && <FixDialog release={release} onClose={() => setFixing(false)} />}
    </section>
  );
}

function Simulate({ release }: { release: ReleaseView }) {
  const { t } = useTranslation();
  const outcome = useSimulateRunOutcome();
  const seen = useSimulateSeenOnServer();
  const toast = useToast();
  const server = release.productionServer?.serverCode;
  const running = release.runs.filter((x) => x.status === "running");
  const canSeen = release.status.kind === "not_in_production" && !!server;
  if (running.length === 0 && !canSeen) return null;
  const fail = () => toast.error(t("releases.simulate.error"));
  return (
    <PrototypeBox label={t("releases.simulate.label")}>
      <p className="text-sm text-ink-muted">{t("releases.simulate.intro")}</p>
      {running.map((r) => (
        <div key={r.id} className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-ink">
            {t("releases.simulate.outcome", { run: r.name })}
          </span>
          <button
            type="button"
            className={smallSecondary}
            onClick={() =>
              outcome.mutate(
                { code: release.code, runId: r.id, outcome: "success" },
                { onError: fail },
              )
            }
          >
            {t("releases.simulate.success")}
          </button>
          <button
            type="button"
            className={smallSecondary}
            onClick={() =>
              outcome.mutate(
                { code: release.code, runId: r.id, outcome: "failed" },
                { onError: fail },
              )
            }
          >
            {t("releases.simulate.failure")}
          </button>
        </div>
      ))}
      {canSeen && (
        <button
          type="button"
          className={`${smallSecondary} self-start`}
          onClick={() => seen.mutate(release.code, { onError: fail })}
        >
          {t("releases.simulate.seen", { server })}
        </button>
      )}
    </PrototypeBox>
  );
}

function RunItem({ run, projectCode }: { run: RunView; projectCode: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(run.status === "failed");
  const kind =
    run.status === "failed" ? "failed" : run.status === "running" ? "running" : "succeeded";
  return (
    <li data-run={run.name} className="border-b border-rule">
      <div className="flex min-h-11 items-center gap-3 px-1">
        <button
          type="button"
          aria-expanded={open}
          aria-label={t("releases.run.label", {
            name: run.name,
            status: t(`releases.run.status.${run.status}`),
            duration: duration(run, t),
          })}
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-left transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6"
        >
          <ChevronGlyph open={open} />
          <ReleaseGlyph kind={kind} />
          <span className="min-w-0 truncate text-md text-ink">{run.name}</span>
          <span className="text-sm text-ink-muted">{t(`releases.run.status.${run.status}`)}</span>
          <span className="num ml-auto text-sm text-ink-muted">{duration(run, t)}</span>
        </button>
        <a href={run.url} target="_blank" rel="noreferrer" className={`${linkClass} shrink-0 pr-2`}>
          {t("releases.openOn", { platform: platformOf(run.url) })}
          <ExternalGlyph />
        </a>
      </div>
      {open && (
        <div className="run-open flex flex-col gap-3 pb-4 pl-9">
          {run.failedStep && (
            <p className="text-md text-ink">
              {t("releases.run.failedStep")}{" "}
              <strong className="font-semibold">{run.failedStep}</strong>
            </p>
          )}
          {run.log !== null ? (
            <RunLog runName={run.name} log={run.log} url={run.url} />
          ) : run.logHidden ? (
            <p className="text-sm text-ink-muted">
              {t("releases.log.hidden", { code: projectCode })}
            </p>
          ) : (
            <p className="text-sm text-ink-muted">{t("releases.log.none")}</p>
          )}
        </div>
      )}
    </li>
  );
}

function NotVisible() {
  const { t } = useTranslation();
  return (
    <section className="flex flex-col items-start gap-2 p-8">
      <h1 className="text-2xl font-semibold text-ink">{t("releases.notVisible")}</h1>
    </section>
  );
}

export function ReleaseDetail({ projectCode, code }: { projectCode: string; code: string }) {
  const { t, i18n } = useTranslation();
  const people = usePeople().data;
  const q = useRelease(code);
  const toast = useToast();
  if (q.isError) {
    return (
      <section className="p-8">
        <PageError message={t("releases.detail.error")} onRetry={() => void q.refetch()} />
      </section>
    );
  }
  if (q.data === undefined) {
    return (
      <section aria-busy="true" className="flex max-w-[960px] flex-col gap-4 p-8 skeleton-breathe">
        <span role="status" className="sr-only">
          {t("taskUi.states.loading")}
        </span>
        <span className="h-3 w-32 rounded-sm bg-ink/8" />
        <span className="h-7 w-2/3 rounded-sm bg-ink/8" />
        <span className="h-24 rounded-lg bg-ink/6" />
        <span className="h-11 rounded-sm bg-ink/6" />
        <span className="h-11 rounded-sm bg-ink/6" />
      </section>
    );
  }
  const release = q.data;
  // R-G5: inesistente, invisibile o di un altro progetto rispondono uguale.
  if (!release || release.projectCode !== projectCode) return <NotVisible />;
  const person = (id: string | null) =>
    id ? (people?.find((p) => p.id === id)?.name ?? null) : null;
  const copyLink = () => {
    const url = `${window.location.origin}${window.location.pathname}#/p/${projectCode}/releases/${release.code}`;
    void navigator.clipboard?.writeText(url).then(
      () => toast.show(t("releases.detail.linkCopied")),
      () => toast.error(t("releases.detail.linkError")),
    );
  };

  return (
    <section className="@container flex min-h-full flex-col pb-16 pl-8">
      <div className="flex w-full max-w-[960px] flex-col gap-6 pr-8">
        <header className="page-header flex flex-col gap-1.5 pb-1 [--page-header-pr:32px] [--page-header-pt:32px]">
          <p className="flex items-center gap-1.5 text-xs text-ink-muted">
            <span className="num font-semibold text-ink">{release.code}</span>
            <span aria-hidden="true">·</span>
            <Link
              to="/p/$code/$section"
              params={{ code: projectCode, section: "releases" }}
              className="rounded-sm underline-offset-4 hover:text-ink hover:underline"
            >
              {t("releases.title")}
            </Link>
            <button
              type="button"
              onClick={copyLink}
              className="ml-auto rounded-md px-2 py-1 text-sm text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink"
            >
              {t("releases.detail.copyLink")}
            </button>
          </p>
          <h1 className="text-2xl font-semibold text-ink [overflow-wrap:anywhere]">
            {release.title}
          </h1>
          <p className="text-md text-ink-muted">
            {t("releases.detail.merged", {
              who: mergedBy(release, t, person),
              date: formatDate(release.mergedAt, i18n.language),
              time: clock(release.mergedAt, i18n.language),
            })}
            {" · "}
            <span className="num font-semibold text-ink">{prCode(release.pr)}</span>
            {" · "}
            <span className="num">{shortSha(release.mergeSha)}</span>
          </p>
        </header>
        <NowBox release={release} />
        <Simulate release={release} />
        <section aria-labelledby="release-runs" className="flex flex-col">
          <h2
            id="release-runs"
            className="flex items-baseline gap-2 pb-2 text-xl font-semibold text-ink"
          >
            {t("releases.detail.runs")}
            {release.runs.length > 0 && (
              <span className="num text-md font-normal text-ink-faint">{release.runs.length}</span>
            )}
          </h2>
          {release.runs.length === 0 ? (
            <p className="border-t border-rule py-3 text-md text-ink-muted">
              {t("releases.detail.noRuns")}
            </p>
          ) : (
            <ul
              aria-label={t("releases.detail.runs")}
              className="flex flex-col border-t border-rule"
            >
              {release.runs.map((r) => (
                <RunItem key={r.id} run={r} projectCode={projectCode} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </section>
  );
}
