import { Link } from "@tanstack/react-router";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { useMailProposals, useMeetingSummary, useTasksBornFrom } from "../../data/queries";
import type { MeetingSummary as Summary } from "../../data/types";
import { smallSecondary } from "../task/parts";
import { useToast } from "../../tasks-ui/Toast";
import { queryState } from "../home/blocks/BlockSection";
import { dayLabel } from "../mail/format";
import { MailProposalCard } from "../mail/MailProposalCard";
import { GeneratedTag } from "../overview/BriefCard";
import { MeetingTaskList, SheetSection, SheetSkeleton } from "./meetingParts";
import { TranscriptUnreachable } from "./MeetingPrep";

// Un evento PASSATO (shape meeting-prep.md §6, [A 1]): al posto della
// scheda, «Meeting summary» per chi c'era — membro del progetto o no, come in
// Posta: lo decide `getMeetingSummary` — con il riassunto intero come testo
// generato, la trascrizione su Google, l'email di Gemini e le proposte ancora
// aperte (conferma sul posto per chi può), poi «Tasks from this meeting» con
// lo stato di adesso, quelle che chi guarda vede. Chi non c'era vede solo le
// task nate, e nulla dice che un riassunto esista: senza task, per lui qui
// non c'è niente.

const heading = "heading-group";

export function MeetingSummary({
  eventId,
  projectCode,
}: {
  eventId: string;
  /** Il codice del progetto dell'evento, se chi guarda lo vede (link delle richieste). */
  projectCode: string | null;
}) {
  const { t } = useTranslation();
  const summary = useMeetingSummary(eventId);
  const born = useTasksBornFrom(eventId);

  if (summary.isPending || born.isPending) {
    return (
      <div className="mt-1 border-t border-rule pt-2">
        <SheetSkeleton label={t("calendar.summary.loading")} />
      </div>
    );
  }
  const s = summary.data ?? null;
  const tasks = born.data ?? [];
  // Né riassunto né task (riunione senza note, o io non c'ero e non è nato nulla): niente.
  if (!summary.isError && !s && !born.isError && tasks.length === 0) return null;

  return (
    <div data-meeting-summary={eventId} className="mt-1 flex flex-col border-t border-rule pb-1">
      {summary.isError && (
        // Un avviso neutro: dire «riassunto» a chi non c'era rivelerebbe che esiste.
        <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 pt-4">
          <p className="text-sm text-ink">{t("calendar.summary.loadFailed")}</p>
          <button type="button" className={smallSecondary} onClick={() => void summary.refetch()}>
            {t("taskUi.states.retry")}
          </button>
        </div>
      )}
      {s && <SummaryBody summary={s} />}
      {(s || tasks.length > 0 || born.isError) && (
        <SheetSection
          title={t("calendar.summary.tasksTitle")}
          headingClassName={heading}
          count={tasks.length}
          state={queryState([born])}
        >
          <MeetingTaskList
            tasks={tasks}
            projectCode={projectCode}
            eventId={eventId}
            label={t("calendar.summary.tasksTitle")}
            empty={
              s?.doc === "unreachable" ? t("calendar.prep.noTasksYet") : t("calendar.prep.noTasks")
            }
          />
        </SheetSection>
      )}
    </div>
  );
}

/**
 * Il riassunto per chi c'era: «Generated text» PRIMA del testo (si annuncia
 * prima), il riassunto intero, «Open the transcript» (avviso del prototipo)
 * e il link all'email di Gemini in Posta; poi le proposte ancora aperte
 * nate dalla trascrizione, come nella Posta.
 */
function SummaryBody({ summary: s }: { summary: Summary }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const id = useId();
  const proposals = useMailProposals(
    { sourceId: s.email?.sourceId, status: "open" },
    { enabled: !!s.email },
  );
  const open = s.email ? (proposals.data ?? []) : [];
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2 px-4 pt-4">
      <div className="flex min-h-6 items-center gap-2">
        <h3 id={id} className={heading}>
          {t("calendar.summary.title")}
        </h3>
        {s.doc === "ready" && <GeneratedTag />}
      </div>
      {s.doc === "ready" && s.summary && (
        <p className="max-w-[65ch] text-sm whitespace-pre-line text-ink">{s.summary}</p>
      )}
      {s.doc === "reading" && (
        <p role="status" className="text-sm text-ink-muted">
          {t("calendar.summary.reading")}
        </p>
      )}
      {s.doc === "unreachable" && (
        <div className="-mx-4">
          <TranscriptUnreachable />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {s.doc === "ready" && (
          <button
            type="button"
            onClick={() => toast.show(t("calendar.summary.docsNotice"))}
            className="rounded-sm font-medium text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink"
          >
            {t("calendar.summary.openTranscript")}
          </button>
        )}
        {s.email && (
          <Link
            to="/mail/$threadId"
            params={{ threadId: s.email.threadId }}
            className="num rounded-sm text-ink-muted underline decoration-ink/30 underline-offset-2 hover:text-ink hover:decoration-ink"
          >
            {t("calendar.summary.fromEmail", { date: dayLabel(s.email.at, i18n.language) })}
          </Link>
        )}
      </div>
      {open.length > 0 && (
        <div className="-mx-4 flex flex-col gap-2 pt-2">
          <p className="px-4 text-xs text-ink-muted">{t("calendar.summary.proposals")}</p>
          {open.map((v) => (
            <MailProposalCard key={v.proposal.id} view={v} />
          ))}
        </div>
      )}
    </section>
  );
}
