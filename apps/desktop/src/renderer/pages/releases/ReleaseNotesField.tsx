import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CodeLink } from "../../components/CodeLink";
import { useSetPrReleaseNotes } from "../../data/queries";
import type { OpenPrView } from "../../data/releases";
import { placeDraft } from "../../domain/claude/intents/mailDraft";
import { useFillableField } from "../../layout/claudePanel/fillable";
import { hasModKey, shortcutLabel } from "../../platform/platform";
import { ClaudeDraftMark, useClaudeDraftMark } from "../../tasks-ui/ClaudeDraftMark";
import { Section, smallPrimary, smallSecondary } from "../task/parts";

// Le note di rilascio (area 10b, Task 10, S6b; shape `claude-drafts.md`
// §3.7): nel pannello della PR, fra «Corrections» e le azioni — le note si
// preparano prima del rilascio, accanto al bottone che rilascia [DR 9]. Chi
// può modificarle (`canEditReleaseNotes`, deciso dal livello dati) le
// scrive e le salva con «Save»: nessun salvataggio automatico, sono un dato
// condiviso [DR 10]. Per il riquadro di Claude è il campo `releaseNotes`: la
// bozza entra col segno e NON si salva da sola. Chi non può modificarle le
// legge in prosa, senza «Who?». Dopo il merge le note passano al rilascio
// (`ReleaseNotesProse`, in sola lettura), coi codici apribili per chi li
// vede (`CodeLink`, la stessa regola delle fonti del segno).

/** Quanto resta «Saved» dopo un salvataggio. */
const SAVED_MS = 2000;
/** Righe dell'area: 4 all'inizio, poi cresce fino a 12. */
const MIN_ROWS = 4;
const MAX_ROWS = 12;

const LINE_HEIGHT = 20;

export function ReleaseNotesField({ pr }: { pr: OpenPrView }) {
  const { t } = useTranslation();
  // P14: una vista senza i campi nuovi (un server più vecchio) è in sola lettura, senza note.
  const canEdit = pr.canEditReleaseNotes ?? false;
  const stored = pr.releaseNotes ?? "";
  const save = useSetPrReleaseNotes();
  const [base, setBase] = useState(stored);
  const [text, setTextState] = useState(stored);
  const textRef = useRef(stored);
  const setText = (next: string) => {
    textRef.current = next;
    setTextState(next);
  };
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [sources, setSources] = useState<readonly string[]>([]);
  const mark = useClaudeDraftMark(text);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const markId = `${id}-mark`;
  const hintId = `${id}-hint`;
  const dirty = text !== base;

  // Le note salvate altrove (o da un altro) arrivano solo se qui non c'è testo non salvato.
  useEffect(() => {
    if (textRef.current === base) setText(stored);
    setBase(stored);
    // `base` e `textRef` sono letti al cambio delle note salvate, non a ogni modifica.
  }, [stored]);

  useEffect(() => {
    if (status !== "saved") return;
    const timer = window.setTimeout(() => setStatus("idle"), SAVED_MS);
    return () => window.clearTimeout(timer);
  }, [status]);

  // L'area cresce col testo, da 4 a 12 righe, poi scorre dentro.
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    el.style.height = "auto";
    const min = MIN_ROWS * LINE_HEIGHT + 16;
    const max = MAX_ROWS * LINE_HEIGHT + 16;
    el.style.height = `${Math.min(max, Math.max(min, el.scrollHeight))}px`;
  }, [text]);

  useFillableField(
    canEdit
      ? {
          ref: { kind: "releaseNotes", prId: pr.id },
          labelKey: "claude.drafts.placed.releaseNotes",
          get: () => textRef.current,
          // Salvate, le note sono della persona: il segno è già tolto (I1).
          isDraft: () => mark.isMarked(textRef.current),
          put: (draft, how, from = []) => {
            const next = placeDraft(textRef.current, draft, how);
            setText(next);
            setSources(from);
            mark.place(next);
            setStatus("idle");
          },
          restore: (before) => {
            setText(before);
            mark.clear();
          },
          focus: () => boxRef.current?.focus(),
        }
      : null,
  );

  const title = t("releases.notes.title");

  if (!canEdit) {
    return (
      <Section title={title}>
        {stored.trim() ? (
          <p className="text-md whitespace-pre-line text-ink [overflow-wrap:anywhere]">{stored}</p>
        ) : (
          <p className="text-md text-ink-faint">{t("releases.notes.none")}</p>
        )}
      </Section>
    );
  }

  const doSave = () => {
    // Un doppio clic non fa due scritture: finché salva, «Save» non riparte.
    if (!dirty || status === "saving") return;
    const value = text;
    // I bottoni spariscono a salvataggio fatto: il fuoco resta nell'area (I2).
    boxRef.current?.focus();
    setStatus("saving");
    save.mutate(
      { prId: pr.id, text: value },
      {
        onSuccess: () => {
          setBase(value);
          mark.clear();
          setStatus("saved");
        },
        onError: () => setStatus("failed"),
      },
    );
  };
  const cancel = () => {
    if (status === "saving") return;
    setText(base);
    setStatus("idle");
    boxRef.current?.focus();
  };

  return (
    <Section title={title}>
      <div className="flex flex-col gap-1">
        <textarea
          ref={boxRef}
          aria-label={t("releases.notes.label")}
          aria-describedby={mark.shown ? `${markId} ${hintId}` : hintId}
          value={text}
          rows={MIN_ROWS}
          placeholder={t("releases.notes.placeholder")}
          onChange={(e) => {
            setText(e.target.value);
            if (status === "failed" || status === "saved") setStatus("idle");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && hasModKey(e)) {
              e.preventDefault();
              doSave();
            } else if (e.key === "Escape" && dirty) {
              e.preventDefault();
              e.stopPropagation();
              cancel();
            }
          }}
          className="w-full resize-none rounded-md border border-rule-strong bg-surface px-2.5 py-2 text-md leading-5 text-ink outline-none placeholder:text-ink-faint focus:border-ink/60"
        />
        {mark.shown && (
          <ClaudeDraftMark id={markId} action="save" sources={sources.map((code) => ({ code }))} />
        )}
        <p id={hintId} className="text-xs text-ink-muted">
          {t("releases.notes.hint")}
        </p>
      </div>
      {(dirty || status !== "idle") && (
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <span role="status" className="mr-auto text-xs">
            {status === "saving" && (
              <span className="text-ink-muted">{t("releases.notes.saving")}</span>
            )}
            {status === "saved" && (
              <span className="text-ink-muted">{t("releases.notes.saved")}</span>
            )}
          </span>
          {status === "failed" ? (
            <p role="alert" className="flex flex-wrap items-center gap-1.5 text-xs text-critical">
              {t("releases.notes.failed")} ·
              <button type="button" className={smallSecondary} onClick={doSave}>
                {t("releases.notes.saveAgain")}
              </button>
            </p>
          ) : (
            dirty && (
              <>
                <button type="button" className={smallSecondary} onClick={cancel}>
                  {t("releases.notes.cancel")}
                </button>
                <button
                  type="button"
                  className={smallPrimary}
                  title={`${t("releases.notes.save")} (${shortcutLabel(["mod", "Enter"])})`}
                  onClick={doSave}
                >
                  {t("releases.notes.save")}
                </button>
              </>
            )
          )}
        </div>
      )}
    </Section>
  );
}

const TASK_CODE = /\b[A-Z]{2,4}-\d+\b/g;

/** Una riga delle note, coi codici delle task al loro posto. */
function NoteLine({ line }: { line: string }) {
  const parts: (string | { code: string })[] = [];
  let last = 0;
  for (const m of line.matchAll(TASK_CODE)) {
    if (m.index > last) parts.push(line.slice(last, m.index));
    parts.push({ code: m[0] });
    last = m.index + m[0].length;
  }
  if (last < line.length) parts.push(line.slice(last));
  return (
    <>
      {parts.map((p, i) =>
        typeof p === "string" ? (
          <Fragment key={i}>{p}</Fragment>
        ) : (
          <CodeLink key={i} code={p.code} />
        ),
      )}
    </>
  );
}

/**
 * Le note nel dettaglio del rilascio: prosa 14px, colonna di lettura, dopo
 * «Now» e prima di «Runs». Senza note la sezione non c'è. Sola lettura:
 * nessun campo, nessun segno.
 */
export function ReleaseNotesProse({ notes }: { notes: string | null | undefined }) {
  const { t } = useTranslation();
  if (!notes?.trim()) return null;
  return (
    <section aria-labelledby="release-notes" className="flex flex-col">
      <h2 id="release-notes" className="pb-2 text-xl font-semibold text-ink">
        {t("releases.notes.title")}
      </h2>
      <div className="flex max-w-[68ch] flex-col gap-1 border-t border-rule pt-3 text-md text-ink">
        {notes.split("\n").map((line, i) => (
          <p key={i} className="min-h-5 [overflow-wrap:anywhere]">
            <NoteLine line={line} />
          </p>
        ))}
      </div>
    </section>
  );
}
