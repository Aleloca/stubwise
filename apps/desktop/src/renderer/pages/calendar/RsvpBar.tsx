import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useRespondEvent } from "../../data/queries";
import type { CalendarEventDetail, CalendarScope, Rsvp } from "../../data/types";
import { inputClass } from "../../tasks-ui/Dialog";
import { SeriesScopeDialog } from "./SeriesScopeDialog";

// La barra di risposta (shape calendar.md §6, punto 4): «Going?» + Yes ·
// Maybe · No con stato premuto e «Add a note» (una riga). Solo per chi è
// invitato e non organizza. La risposta è ottimistica: il bottone si preme
// subito, il salvataggio dice «Saving…» e si annuncia. In una serie chiede
// «This event / All events».

const CHOICES: { rsvp: Rsvp; key: string }[] = [
  { rsvp: "accepted", key: "calendar.answer.yes" },
  { rsvp: "tentative", key: "calendar.answer.maybeShort" },
  { rsvp: "declined", key: "calendar.answer.no" },
];

export function RsvpBar({
  event,
  barRef,
  announce,
  dateLabel,
}: {
  event: CalendarEventDetail;
  barRef?: React.Ref<HTMLDivElement>;
  announce: (message: string) => void;
  dateLabel: string;
}) {
  const { t } = useTranslation();
  const respond = useRespondEvent();
  const [optimistic, setOptimistic] = useState<Rsvp | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [asking, setAsking] = useState<Rsvp | null>(null);
  const noteId = useId();
  const current = optimistic ?? event.myResponse;

  const send = (rsvp: Rsvp, scope: CalendarScope) => {
    setOptimistic(rsvp);
    const word = t(CHOICES.find((c) => c.rsvp === rsvp)!.key);
    announce(t("calendar.answer.sending", { answer: word }));
    respond.mutate(
      { id: event.id, rsvp, note: note.trim() || undefined, scope },
      { onSettled: () => setOptimistic(null) },
    );
  };
  const choose = (rsvp: Rsvp) => {
    if (event.seriesId) setAsking(rsvp);
    else send(rsvp, "one");
  };

  return (
    <div ref={barRef} tabIndex={-1} data-rsvp-bar className="flex flex-col gap-2 outline-none">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-ink">{t("calendar.answer.going")}</span>
        <div
          role="group"
          aria-label={t("calendar.answer.going")}
          className="flex h-8 items-center rounded-md border border-rule-strong p-0.5"
        >
          {CHOICES.map((c) => (
            <button
              key={c.rsvp}
              type="button"
              aria-pressed={current === c.rsvp}
              onClick={() => choose(c.rsvp)}
              className={`h-full rounded-[4px] px-3 text-sm transition-colors duration-[var(--duration-fast)] ease-out ${current === c.rsvp ? "bg-ink font-semibold text-ground" : "text-ink hover:bg-ink/6"}`}
            >
              {t(c.key)}
            </button>
          ))}
        </div>
        {event.save?.state === "saving" && (
          <span className="text-xs text-ink-muted">{t("calendar.save.saving")}</span>
        )}
        {!noteOpen && (
          <button
            type="button"
            onClick={() => setNoteOpen(true)}
            className="rounded-sm text-sm font-medium text-ink-muted underline decoration-ink/30 underline-offset-2 transition-colors duration-[var(--duration-fast)] ease-out hover:text-ink"
          >
            {t("calendar.answer.addNote")}
          </button>
        )}
      </div>
      {noteOpen && (
        <div className="flex flex-col gap-1">
          <label htmlFor={noteId} className="sr-only">
            {t("calendar.answer.addNote")}
          </label>
          <input
            id={noteId}
            autoFocus
            value={note}
            maxLength={200}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              // Invio manda la nota con la risposta già scelta (o «Sì», se non ce n'è una).
              if (e.key !== "Enter") return;
              e.preventDefault();
              choose(current && current !== "needsAction" ? current : "accepted");
            }}
            placeholder={t("calendar.answer.notePlaceholder")}
            className={inputClass}
          />
          <span className="text-xs text-ink-faint">{t("calendar.answer.noteHint")}</span>
        </div>
      )}
      {asking && (
        <SeriesScopeDialog
          action="answer"
          dateLabel={dateLabel}
          onCancel={() => setAsking(null)}
          onConfirm={(scope) => {
            const rsvp = asking;
            setAsking(null);
            send(rsvp, scope);
          }}
        />
      )}
    </div>
  );
}
