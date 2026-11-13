import { Link } from "@tanstack/react-router";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import {
  useMailProposals,
  useMeetingByNote,
  useMeetingSummary,
  useTasksBornFrom,
  useTasksOfNote,
} from "../../data/queries";
import type { MeetingSummary as Summary } from "../../data/types";
import { smallSecondary } from "../task/parts";
import { useToast } from "../../tasks-ui/Toast";
import { queryState } from "../home/blocks/BlockSection";
import { dayLabel } from "../mail/format";
import { MailProposalCard } from "../mail/MailProposalCard";
import { openOnGoogle } from "../mail/mailFeatures";
import { isAppBuild } from "../../data/build";
import { GeneratedTag } from "../overview/BriefCard";
import { MeetingTaskList, SheetSection } from "./meetingParts";
import { TranscriptUnreachable } from "./MeetingPrep";

// Un evento PASSATO (shape meeting-prep.md §6, [A 1]): al posto della
// scheda, «Meeting summary» per chi c'era — membro del progetto o no, come in
// Posta: lo decide `getMeetingSummary` — con il riassunto intero come testo
// generato, la trascrizione su Google, l'email di Gemini e le proposte ancora
// aperte (conferma sul posto per chi può), poi «Tasks from this meeting» con
// lo stato di adesso, solo per i membri del progetto (R-I21). Chi non c'era
// vede solo le task nate, e nulla dice che un riassunto esista: senza task,
// per lui qui non c'è niente.

const heading = "heading-group";

export function MeetingSummary({
  eventId,
  noteId,
  projectCode,
  onOpenTask,
}: {
  /** L'evento (il dettaglio del Calendario)… */
  eventId?: string;
  /** …o la riunione per nota (F5a, Q-A = a: l'invitato senza l'evento). */
  noteId?: string;
  /** Il codice del progetto dell'evento, se chi guarda lo vede (link delle richieste). */
  projectCode: string | null;
  /** Prima di aprire una task nata (il pannello per nota si chiude). */
  onOpenTask?: () => void;
}) {
  const { t } = useTranslation();
  const byNote = noteId !== undefined;
  const summaryOfEvent = useMeetingSummary(byNote ? null : (eventId ?? null));
  const summaryOfNote = useMeetingByNote(byNote ? noteId : null);
  const bornOfEvent = useTasksBornFrom(byNote ? null : (eventId ?? null));
  const bornOfNote = useTasksOfNote(byNote ? noteId : null);
  const summary = byNote ? summaryOfNote : summaryOfEvent;
  const born = byNote ? bornOfNote : bornOfEvent;

  // Mentre legge, niente scheletro: per molti eventi passati qui non c'è
  // nulla, e uno scheletro che appare e sparisce lampeggerebbe. Resta solo
  // lo stato per chi usa un lettore di schermo.
  if (summary.isPending || born.isPending) {
    return (
      <div aria-busy="true">
        <span role="status" className="sr-only">
          {t("calendar.summary.loading")}
        </span>
      </div>
    );
  }
  const s = summary.data ?? null;
  // `null`: le task nate non sono per chi guarda (non è membro, R-I21).
  const forMe = born.data !== null;
  const tasks = born.data ?? [];
  // Né riassunto né task (riunione senza note, o io non c'ero e non è nato nulla): niente.
  if (!summary.isError && !s && !born.isError && tasks.length === 0) return null;

  return (
    <div data-meeting-summary={eventId ?? noteId} className="mt-1 flex flex-col border-t border-rule pb-1">
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
      {forMe && (s || tasks.length > 0 || born.isError) && (
        <SheetSection
          title={t("calendar.summary.tasksTitle")}
          headingClassName={heading}
          level={3}
          count={tasks.length}
          state={queryState([born])}
        >
          <MeetingTaskList
            tasks={tasks}
            projectCode={projectCode}
            eventId={eventId ?? ""}
            onOpen={onOpenTask}
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
      {s.doc === "ready" && s.docReason === "too_long" && (
        <p className="text-sm text-ink-muted">{t("mail.meeting.tooLong")}</p>
      )}
      {s.doc === "reading" && (
        <p role="status" className="text-sm text-ink-muted">
          {t("calendar.summary.reading")}
        </p>
      )}
      {s.doc === "unreachable" && (
        <div className="-mx-4">
          <TranscriptUnreachable reason={s.docReason ?? null} docUrl={s.docUrl ?? null} />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {/* Nella build app solo col link del Doc (review F5a, 8): l'avviso è del prototipo. */}
        {s.doc === "ready" && (!isAppBuild() || s.docUrl) && (
          <button
            type="button"
            onClick={() =>
              // Nella build app apre il Google Doc (F5a); nel prototipo lo dice.
              s.docUrl ? openOnGoogle(s.docUrl) : toast.show(t("calendar.summary.docsNotice"))
            }
            className="rounded-sm font-medium text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink"
          >
            {t("calendar.summary.openTranscript")}
          </button>
        )}
        {s.email?.threadId && (
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
        <div className="flex flex-col gap-2 pt-2">
          <p className="text-xs text-ink-muted">{t("calendar.summary.proposals")}</p>
          {open.map((v) => (
            <MailProposalCard key={v.proposal.id} view={v} />
          ))}
        </div>
      )}
    </section>
  );
}
