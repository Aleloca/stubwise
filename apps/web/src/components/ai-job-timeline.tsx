import { useState } from "react";
import type { AIJob, AIJobStatus } from "../lib/api";
import { formatDateTime, formatRelativeTime } from "../lib/format";

const JOB_STATUS_LABELS: Record<AIJobStatus, string> = {
  queued: "In coda",
  triaging: "Triage",
  fixing: "Fix in corso",
  pr_opened: "PR aperta",
  pr_merged: "PR mergiata",
  failed: "Fallito",
  skipped: "Saltato",
};

/** Colore del pallino di stato sulla rotaia della timeline. */
const JOB_STATUS_DOT: Record<AIJobStatus, string> = {
  queued: "bg-fg-faint",
  triaging: "bg-sky-400 animate-blink",
  fixing: "bg-sky-400 animate-blink",
  pr_opened: "bg-ok",
  pr_merged: "bg-ok",
  failed: "bg-danger",
  skipped: "bg-fg-faint",
};

const JOB_STATUS_TEXT: Record<AIJobStatus, string> = {
  queued: "text-fg-muted",
  triaging: "text-sky-400",
  fixing: "text-sky-400",
  pr_opened: "text-ok",
  pr_merged: "text-ok",
  failed: "text-danger",
  skipped: "text-fg-faint",
};

/**
 * Timeline dei job della pipeline AI di un ticket, dal tentativo più
 * recente: stato colorato, tempi, log collassabile in mono, link alla PR
 * quando è stata aperta e messaggio d'errore quando il job è fallito.
 */
export function AIJobTimeline({ jobs }: { jobs: AIJob[] }) {
  if (jobs.length === 0) {
    return (
      <p className="font-mono text-[12px] text-fg-faint">
        // nessuna attività AI per questo ticket
      </p>
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
  const [showLog, setShowLog] = useState(false);

  return (
    <li className="relative pb-4 pl-6 last:pb-0">
      {/* Rotaia verticale e pallino di stato. */}
      {!last && <span aria-hidden className="absolute top-3 left-[5px] h-full w-px bg-line" />}
      <span
        aria-hidden
        className={`absolute top-1.5 left-0 size-[11px] rounded-full border-2 border-ink-900 ${JOB_STATUS_DOT[job.status]}`}
      />

      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span
          className={`font-mono text-[12px] font-medium tracking-[0.08em] uppercase ${JOB_STATUS_TEXT[job.status]}`}
        >
          {JOB_STATUS_LABELS[job.status]}
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
            Vedi PR ↗
          </a>
        )}
      </div>

      {(job.startedAt ?? job.finishedAt) && (
        <p className="mt-1 font-mono text-[11px] text-fg-faint">
          {job.startedAt && <>Inizio {formatDateTime(job.startedAt)}</>}
          {job.startedAt && job.finishedAt && <span className="mx-1.5">·</span>}
          {job.finishedAt && <>Fine {formatDateTime(job.finishedAt)}</>}
        </p>
      )}

      {job.error && (
        <p className="mt-1.5 rounded-sm border border-danger/30 bg-danger/10 px-2.5 py-1.5 font-mono text-[12px] text-danger">
          {job.error}
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
            {showLog ? "▾ Nascondi log" : "▸ Mostra log"}
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
