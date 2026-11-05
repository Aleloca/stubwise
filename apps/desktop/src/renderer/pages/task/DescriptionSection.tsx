import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Task } from "../../data/types";
import { placeDraft } from "../../domain/claude/intents/mailDraft";
import { useFillableField } from "../../layout/claudePanel/fillable";
import { ClaudeDraftMark, useClaudeDraftMark } from "../../tasks-ui/ClaudeDraftMark";
import { inputClass } from "../../tasks-ui/Dialog";
import { Markdown } from "../../tasks-ui/Markdown";
import { useInlineUpdate } from "../tasks/pickers";
import { Section, ghostButton, smallPrimary, smallSecondary } from "./parts";

/**
 * La descrizione: markdown in sola lettura; con `tickets.edit` «Edit» la
 * apre in un campo di testo (⌘/Ctrl+Invio salva, Esc annulla).
 *
 * Area 10b (Task 10, D1; shape `claude-drafts.md` §3.6): per chi può
 * modificare è il campo `taskDescription` del riquadro di Claude. Mettere la
 * bozza apre il modo modifica col testo di Claude e il segno, senza prendere
 * il fuoco [DR 8]: la task non cambia finché la persona non preme «Save»
 * (`updateTask` a mano, nessun `via`). Esc butta la bozza.
 */
export function DescriptionSection({ task, canEdit }: { task: Task; canEdit: boolean }) {
  const { t } = useTranslation();
  const change = useInlineUpdate();
  const [draft, setDraftState] = useState<string | null>(null);
  /** Il testo del campo adesso, letto dal riquadro senza aspettare il render. */
  const draftRef = useRef<string | null>(null);
  const descriptionRef = useRef(task.description);
  descriptionRef.current = task.description;
  const setDraft = (text: string | null) => {
    draftRef.current = text;
    setDraftState(text);
  };
  // Aperta da Claude: niente fuoco nel campo, la sezione scorre a vista e un annuncio.
  const [byClaude, setByClaude] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  /** Il campo era già aperto prima della bozza (per «Undo»). */
  const editingBefore = useRef(false);
  const mark = useClaudeDraftMark(draft ?? "");
  /** Da dove l'ha scritta Claude (la richiesta, la conversazione di supporto). */
  const [sources, setSources] = useState<readonly string[]>([]);
  const markId = `${useId()}-mark`;

  const close = () => {
    setDraft(null);
    setByClaude(false);
  };
  // Chiusa dalla persona (Save, Cancel, Esc): il campo sparisce col fuoco
  // dentro, che torna su «Edit» — mai sul body (I2).
  const editRef = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  const closeByPerson = () => {
    refocus.current = true;
    close();
  };
  useLayoutEffect(() => {
    if (draft !== null || !refocus.current) return;
    refocus.current = false;
    editRef.current?.focus();
  }, [draft]);
  const save = () => {
    if (draft !== null && draft !== task.description) change(task, { description: draft });
    closeByPerson();
  };
  const title = t("taskDetail.description.title");

  useEffect(() => {
    if (byClaude) sectionRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [byClaude]);

  useFillableField(
    canEdit
      ? {
          ref: { kind: "taskDescription", taskId: task.id },
          labelKey: "claude.drafts.placed.taskDescription",
          get: () => draftRef.current ?? descriptionRef.current,
          // Solo nel campo aperto: salvata, la descrizione è della persona (I1).
          isDraft: () => draftRef.current !== null && mark.isMarked(draftRef.current),
          put: (text, how, from = []) => {
            editingBefore.current = draftRef.current !== null;
            setSources(from);
            const next = placeDraft(draftRef.current ?? descriptionRef.current, text, how);
            setDraft(next);
            mark.place(next);
            setByClaude(true);
          },
          restore: (text) => {
            mark.clear();
            if (editingBefore.current) setDraft(text);
            else close();
          },
          focus: () => boxRef.current?.focus(),
        }
      : null,
  );

  if (draft !== null) {
    return (
      <Section title={title} sectionRef={sectionRef}>
        {/* Cresce col testo da 6 a 12 righe: una bozza di Claude si legge
            senza scorrere dentro il campo (Impeccable 10). */}
        <textarea
          ref={boxRef}
          autoFocus={!byClaude}
          aria-label={title}
          aria-describedby={mark.shown ? markId : undefined}
          value={draft}
          rows={6}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              closeByPerson();
            } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              save();
            }
          }}
          className={`${inputClass} max-h-[254px] min-h-[134px] resize-y leading-5 [field-sizing:content]`}
        />
        {mark.shown && (
          <ClaudeDraftMark id={markId} action="save" sources={sources.map((code) => ({ code }))} />
        )}
        {byClaude && mark.shown && (
          <p role="status" className="sr-only">
            {t("claude.drafts.descriptionReady", { code: task.code })}
          </p>
        )}
        <div className="flex items-center gap-1.5">
          <span className="mr-auto text-xs text-ink-faint">{t("taskDetail.description.hint")}</span>
          <button type="button" className={smallSecondary} onClick={closeByPerson}>
            {t("taskDetail.cancel")}
          </button>
          <button type="button" className={smallPrimary} onClick={save}>
            {t("taskDetail.save")}
          </button>
        </div>
      </Section>
    );
  }

  const edit = canEdit && (
    <button
      ref={editRef}
      type="button"
      className={ghostButton}
      aria-label={t("taskDetail.description.edit")}
      onClick={() => setDraft(task.description)}
    >
      {task.description.trim() ? t("taskDetail.edit") : t("taskDetail.add")}
    </button>
  );

  if (!task.description.trim()) {
    return <Section title={title} empty={t("taskDetail.description.none")} action={edit} />;
  }
  return (
    <Section title={title} action={edit}>
      <Markdown source={task.description} />
    </Section>
  );
}
