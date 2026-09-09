import { useState } from "react";
import { useTranslation } from "react-i18next";
import { workStateFor } from "@stubwise/shared";
import { WORK_STATE_DOT_CLASS, WORK_STATE_LABEL_KEYS, WORK_STATE_TEXT_CLASS } from "./badges";
import type { AIJob, AIJobStatus } from "../lib/api";
import { formatDateTime, formatRelativeTime } from "../lib/format";

/**
 * Stati con una nota esplicativa sotto l'etichetta. Il testo vive nel
 * catalogo i18n (`jobStatus:notes.<stato>`); qui si elencano solo gli stati
 * che la nota ce l'hanno.
 */
const JOB_STATUS_WITH_NOTE: ReadonlySet<AIJobStatus> = new Set<AIJobStatus>([
  "held",
  "awaiting_plan_approval",
  "awaiting_input",
]);

/**
 * Timeline dei job della pipeline AI di un ticket, dal tentativo più
 * recente: stato colorato, tempi, log collassabile in mono, link alla PR
 * quando è stata aperta e messaggio d'errore quando il job è fallito.
 */
export function AIJobTimeline({ jobs }: { jobs: AIJob[] }) {
  const { t } = useTranslation();

  if (jobs.length === 0) {
    return (
      <p className="font-mono text-[12px] text-fg-faint">{t("tickets:timeline.empty")}</p>
    );
  }

  return (
    <ol className="space-y-0">
      {jobs.map((job, index) => (
        <JobEntry key={job.id} job={job} last={index === jobs.length - 1} />
      ))}
    </ol>
  );
}

function JobEntry({ job, last }: { job: AIJob; last: boolean }) {
  const { t } = useTranslation();
  const [showLog, setShowLog] = useState(false);

  return (
    <li className="relative pb-4 pl-6 last:pb-0">
      {/* Rotaia verticale e pallino di stato. */}
      {!last && <span aria-hidden className="absolute top-3 left-[5px] h-full w-px bg-line" />}
      <span
        aria-hidden
        className={`absolute top-1.5 left-0 size-[11px] rounded-full border-2 border-ink-900 ${WORK_STATE_DOT_CLASS[workStateFor(job.status)]}`}
      />

      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span
          className={`font-mono text-[12px] font-medium tracking-[0.08em] uppercase ${WORK_STATE_TEXT_CLASS[workStateFor(job.status)]}`}
        >
          {t(WORK_STATE_LABEL_KEYS[workStateFor(job.status)])}
        </span>
        <time
          dateTime={job.createdAt}
          title={formatDateTime(job.createdAt)}
          className="font-mono text-[11px] text-fg-faint"
        >
          {formatRelativeTime(job.createdAt)}
        </time>
        {job.prUrl && (
          <a
            href={job.prUrl}
            target="_blank"
            rel="noreferrer"
            className="rounded-sm border border-ok/40 px-2 py-0.5 font-mono text-[11px] tracking-[0.08em] text-ok uppercase transition-colors hover:border-ok hover:bg-ok/10"
          >
            {t("tickets:timeline.viewPr")}
          </a>
        )}
        {job.providerLabel && (
          <span className="font-mono text-[11px] text-fg-faint">
            {t("tickets:timeline.provider")}: {job.providerLabel}
            {job.providerKind && (
              <>
                {" · "}
                {t(`tickets:timeline.providerKind.${job.providerKind}`)}
              </>
            )}
          </span>
        )}
      </div>

      {(job.startedAt ?? job.finishedAt) && (
        <p className="mt-1 font-mono text-[11px] text-fg-faint">
          {job.startedAt && <>{t("tickets:timeline.startedAt", { date: formatDateTime(job.startedAt) })}</>}
          {job.startedAt && job.finishedAt && <span className="mx-1.5">·</span>}
          {job.finishedAt && <>{t("tickets:timeline.finishedAt", { date: formatDateTime(job.finishedAt) })}</>}
        </p>
      )}

      {/*
        Riassunto "in breve" del fallimento (fase 7, Task 9): quando c'è, PRIMA
        del messaggio d'errore tecnico — è la lettura per chi non legge codice,
        non una sostituzione del log. Può mancare anche su un job fallito
        (generazione spenta, in errore, o non ancora arrivata: è scritta DOPO
        la notifica, best-effort): in quel caso resta solo l'errore tecnico
        sotto, come prima di questa fase.
      */}
      {job.failureSummary && (
        <div className="mt-1.5 border-l-2 border-line-strong pl-2.5">
          <p className="font-mono text-[10px] tracking-[0.08em] text-fg-faint uppercase">
            {t("tickets:timeline.failureSummary")}
          </p>
          <p className="mt-0.5 font-mono text-[12px] text-fg-muted">{job.failureSummary}</p>
        </div>
      )}

      {job.error && (
        <p className="mt-1.5 rounded-sm border border-danger/30 bg-danger/10 px-2.5 py-1.5 font-mono text-[12px] text-danger">
          {job.error}
        </p>
      )}

      {JOB_STATUS_WITH_NOTE.has(job.status) && (
        <p className="mt-1.5 font-mono text-[11px] text-fg-muted">
          {t(`jobStatus:notes.${job.status}`)}
        </p>
      )}

      {job.log && (
        <div className="mt-1.5">
          <button
            type="button"
            aria-expanded={showLog}
            onClick={() => setShowLog((current) => !current)}
            className="font-mono text-[11px] tracking-[0.12em] text-fg-faint uppercase transition-colors hover:text-fg-muted"
          >
            {showLog ? t("tickets:timeline.hideLog") : t("tickets:timeline.showLog")}
          </button>
          {showLog && (
            <pre className="mt-1.5 max-h-72 overflow-auto rounded-sm border border-line bg-ink-950/70 p-3 font-mono text-[12px] leading-relaxed text-fg-muted">
              {job.log}
            </pre>
          )}
        </div>
      )}
    </li>
  );
}
