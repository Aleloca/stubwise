import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { CalendarEventView, Rsvp } from "../../data/types";
import { AlertGlyph, VideoGlyph } from "../mail/glyphs";
import { spanLabel, timeLabel } from "./calendarFormat";
import type { MailboxMark } from "./gridLayout";

// Il «blocco evento» (shape calendar.md §3, §5, §6): UN componente con tre
// densità — griglia oraria, riga del mese, riga d'elenco (popover dei
// sovrapposti) — e gli stessi segni di stato in tutte. La risposta di chi
// guarda la dicono FORMA e PAROLA, mai il colore: pieno (accettato o
// organizzatore), contorno (senza risposta), contorno + tinta lieve (forse),
// barrato (rifiutato). Il colore c'è solo per lo stato (salvataggio fallito).

export type Answer = "accepted" | "needsAction" | "tentative" | "declined";

/** La risposta di chi guarda: l'organizzatore (o il titolare senza invitati) è «accettato». */
export function answerOf(e: Pick<CalendarEventView, "isOrganizer" | "myResponse">): Answer {
  if (e.isOrganizer) return "accepted";
  return (e.myResponse ?? "accepted") as Rsvp;
}

/** La parola della risposta sul blocco («Not answered», «Maybe», «Declined»); niente se accettato. */
export function answerWordKey(answer: Answer): string | null {
  if (answer === "needsAction") return "calendar.answer.notAnswered";
  if (answer === "tentative") return "calendar.answer.maybe";
  if (answer === "declined") return "calendar.answer.declined";
  return null;
}

export interface ProjectRef {
  id: string;
  code: string;
  name: string;
}

/**
 * Il segno «Preparation available»: un foglio con le righe, a tratto come gli
 * altri glifi. Il nome accessibile del blocco lo dice a parole; qui il
 * tooltip «Open to prepare». Mai colore.
 */
export function PrepMark() {
  const { t } = useTranslation();
  return (
    <span
      data-prep-mark
      title={t("calendar.prep.openToPrepare")}
      className="flex shrink-0 items-center text-ink-muted"
    >
      <svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none">
        <rect x="3" y="2" width="10" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
        <path d="M5.75 5.5h4.5M5.75 8h4.5M5.75 10.5h2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    </span>
  );
}

/** Il nome accessibile completo: titolo, orario intero, progetto, risposta, salvataggio, casella. */
export function useEventName() {
  const { t, i18n } = useTranslation();
  return (e: CalendarEventView, project: ProjectRef | undefined, withMailbox: boolean): string => {
    const parts = [
      e.title,
      e.allDay
        ? t("calendar.allDayOn", { date: spanLabel(e, i18n.language) })
        : spanLabel(e, i18n.language),
    ];
    if (project) parts.push(`${project.code} ${project.name}`);
    if (e.hasPrep) parts.push(t("calendar.prep.available"));
    const word = answerWordKey(answerOf(e));
    if (word) parts.push(t(word));
    if (e.save?.state === "saving") parts.push(t("calendar.save.saving"));
    if (e.save?.state === "failed") parts.push(t("calendar.save.failed"));
    if (withMailbox && e.calendarEmail)
      parts.push(t("calendar.inMailbox", { email: e.calendarEmail }));
    return parts.join(", ");
  };
}

const SHAPE: Record<Answer, string> = {
  accepted: "bg-ink/10 border-transparent",
  needsAction: "border-rule-strong bg-ground",
  tentative: "border-rule-strong bg-ink/4",
  declined: "border-rule bg-ground",
};

/** Il filetto di una casella [A 1]: 3 px d'inchiostro, con il disegno della casella. */
export function MailboxRule({ mark }: { mark: MailboxMark }) {
  return (
    <span
      aria-hidden="true"
      data-mailbox-mark={mark}
      style={{ borderLeftStyle: mark, borderLeftWidth: 3 }}
      className="pointer-events-none absolute inset-y-1 left-0 border-ink/70"
    />
  );
}

/** Il quadratino della casella nella colonna (stesso disegno del filetto). */
export function MailboxSwatch({ mark }: { mark: MailboxMark }) {
  return (
    <span
      aria-hidden="true"
      style={{ borderStyle: mark, borderWidth: mark === "double" ? 3 : 2 }}
      className="inline-block size-2.5 shrink-0 rounded-[2px] border-ink/70"
    />
  );
}

/** Altezza di una riga di testo nel blocco (12–13 px su 16). */
export const BLOCK_LINE_PX = 16;

/**
 * Il contenuto del blocco nella griglia oraria, secondo lo spazio (le righe
 * che stanno nell'altezza del blocco): su una riga ora + titolo (15′–30′);
 * su due ora · codice · stato e il titolo; con più spazio il titolo va a
 * capo e sotto compaiono luogo o «Google Meet» (in Day anche gli invitati).
 * Le parole di stato (risposta, «continues», «Saving…», «Couldn't save»)
 * hanno la precedenza sul luogo: dicono qualcosa che il colore non dice.
 */
export function GridBlockBody({
  e,
  heightPx,
  project,
  past,
  roomy,
  continues,
  fromPrevious,
  hideCode,
  titleFirst = false,
}: {
  e: CalendarEventView;
  heightPx: number;
  /** Corsia stretta (tre affiancate): il titolo prima dell'ora, così resta leggibile. */
  titleFirst?: boolean;
  project: ProjectRef | undefined;
  past: boolean;
  roomy: boolean;
  continues: boolean;
  fromPrevious: boolean;
  hideCode: boolean;
}) {
  const { t, i18n } = useTranslation();
  const prep = e.hasPrep && <PrepMark />;
  const answer = answerOf(e);
  const word = answerWordKey(answer);
  const lines = Math.max(1, Math.floor((heightPx - 4) / BLOCK_LINE_PX));
  const code = project && !hideCode ? project.code : null;
  const failed = e.save?.state === "failed";
  const states = [
    word ? t(word) : null,
    continues ? t("calendar.block.continues") : null,
    e.save?.state === "saving" ? t("calendar.save.saving") : null,
  ].filter((x): x is string => x !== null);
  const titleClass = `min-w-0 text-[13px] leading-4 ${answer === "declined" ? "font-normal text-ink-faint line-through" : "font-semibold"} ${past && answer !== "declined" ? "text-ink-muted" : ""}`;
  const time = (
    <span className="num shrink-0 text-xs leading-4 text-ink-muted">
      {fromPrevious
        ? t("calendar.block.from", {
            day: new Intl.DateTimeFormat(i18n.language, { weekday: "short" }).format(
              new Date(e.startsAt),
            ),
            time: timeLabel(e.startsAt, i18n.language),
          })
        : timeLabel(e.startsAt, i18n.language)}
    </span>
  );
  const codeEl = code && (
    <span className="num shrink-0 text-xs leading-4 font-semibold tracking-[0.02em] text-ink">
      {code}
    </span>
  );
  const fail = failed && (
    <span className="flex shrink-0 items-center gap-1 text-xs leading-4 text-critical">
      <AlertGlyph />
      {t("calendar.save.failed")}
    </span>
  );
  if (lines === 1) {
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        {!titleFirst && time}
        <span className={`${titleClass} truncate`}>{e.title}</span>
        {prep}
        {continues && (
          <span className="shrink-0 text-xs leading-4 text-ink-muted">
            {t("calendar.block.continues")}
          </span>
        )}
        {fail}
      </span>
    );
  }
  const where = e.location ?? (e.meetUrl ? t("calendar.meet") : null);
  // Le righe sotto il titolo: prima lo stato, poi il luogo, poi gli invitati (Day).
  const extra: ReactNode[] = [];
  if (failed || states.length > 0) {
    extra.push(
      <span
        key="state"
        className="flex min-w-0 items-center gap-1.5 text-xs leading-4 text-ink-muted"
      >
        {fail}
        {states.length > 0 && <span className="truncate">{states.join(" · ")}</span>}
      </span>,
    );
  }
  if (where) {
    extra.push(
      <span
        key="where"
        className="flex min-w-0 items-center gap-1 text-xs leading-4 text-ink-muted"
      >
        {e.meetUrl && <VideoGlyph size={12} />}
        <span className="truncate">{where}</span>
      </span>,
    );
  }
  if (roomy && e.attendees.length > 0) {
    extra.push(
      <span key="guests" className="num truncate text-xs leading-4 text-ink-muted">
        {t("calendar.block.guests", { count: e.attendees.length })}
      </span>,
    );
  }
  if (lines === 2 && titleFirst) {
    return (
      <>
        <span className={`${titleClass} truncate`}>{e.title}</span>
        <span className="flex min-w-0 items-center gap-1.5">
          {time}
          {prep}
          {fail}
          {states.length > 0 && (
            <span className="truncate text-xs leading-4 text-ink-muted">{states.join(" · ")}</span>
          )}
        </span>
      </>
    );
  }
  if (lines === 2) {
    // Due righe: lo stato sale accanto all'ora, il titolo sotto.
    return (
      <>
        <span className="flex min-w-0 items-center gap-1.5">
          {time}
          {codeEl}
          {prep}
          {fail}
          {states.length > 0 && (
            <span className="truncate text-xs leading-4 text-ink-muted">{states.join(" · ")}</span>
          )}
        </span>
        <span className={`${titleClass} truncate`}>{e.title}</span>
      </>
    );
  }
  const titleLines = Math.min(2, Math.max(1, lines - 1 - extra.length));
  return (
    <>
      <span className="flex min-w-0 items-center gap-1.5">
        {time}
        {codeEl}
        {prep}
      </span>
      <span className={`${titleClass} ${titleLines === 2 ? "line-clamp-2" : "truncate"}`}>
        {e.title}
      </span>
      {extra.slice(0, Math.max(0, lines - 1 - titleLines))}
    </>
  );
}

/** Le classi della forma del blocco (griglia oraria e mese). */
export function blockShape(e: CalendarEventView): string {
  const failed = e.save?.state === "failed" ? "!border-critical" : "";
  return `${SHAPE[answerOf(e)]} ${failed}`;
}

/**
 * Una riga di elenco (popover dei sovrapposti, «+N more» del mese): ora
 * tnum, codice progetto, titolo, stato di risposta.
 */
export function EventListRow({
  e,
  project,
  name,
  onOpen,
}: {
  e: CalendarEventView;
  project: ProjectRef | undefined;
  name: string;
  onOpen: () => void;
}) {
  const { t, i18n } = useTranslation();
  const answer = answerOf(e);
  const word = answerWordKey(answer);
  return (
    <button
      type="button"
      aria-label={name}
      data-event-row={e.id}
      onClick={onOpen}
      className="flex min-h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-sm text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6"
    >
      <span className="num w-16 shrink-0 text-xs text-ink-muted">
        {e.allDay ? t("calendar.allDay") : timeLabel(e.startsAt, i18n.language)}
      </span>
      {project && (
        <span className="num shrink-0 text-xs font-semibold text-ink">{project.code}</span>
      )}
      <span
        className={`min-w-0 flex-1 truncate ${answer === "declined" ? "text-ink-faint line-through" : ""}`}
      >
        {e.title}
      </span>
      {word && <span className="shrink-0 text-xs text-ink-muted">{t(word)}</span>}
    </button>
  );
}
