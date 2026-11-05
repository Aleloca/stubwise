import { forwardRef, useId, useImperativeHandle, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { useProductMentionCandidates } from "../../../data/queries";
import {
  SuggestionMenu,
  flatten,
  type Suggestion,
  type SuggestionGroup,
} from "../../claude/conversation/MentionMenu";
import { picksWithKey, useComposerField } from "../../claude/conversation/useComposerField";

// La casella di un commento o di una risposta (shape
// product-comments-history.md §3.1, §3.2): il campo multilinea con le
// @menzioni (`SuggestionMenu` di `MentionMenu.tsx`, coi candidati di
// `useProductMentionCandidates`: chi legge i Docs del progetto, mai Claude
// né chi scrive). ⌘Invio invia, Invio va a capo. Vuota, l'invio è spento
// con «Write something first»; in corso «Posting…» e spento (un doppio clic
// non scrive due volte); un errore resta in riga con «Retry» e il testo
// resta nella casella. Sotto, chi riceverà un avviso.

export interface CommentComposerHandle {
  focus(): void;
}

export const CommentComposer = forwardRef<
  CommentComposerHandle,
  {
    projectId: string;
    projectCode: string;
    /** Il segnaposto, che è anche il nome del campo. */
    placeholder: string;
    /** Il testo del bottone d'invio. */
    sendLabel: string;
    /** La risposta: una riga che si allarga al fuoco, con l'invio solo quando serve. */
    compact?: boolean;
    autoFocus?: boolean;
    /** Invia; la promessa dice com'è andata (il testo si svuota solo se è andata). */
    onSubmit: (body: string) => Promise<unknown>;
    onCancel?: () => void;
  }
>(function CommentComposer(
  { projectId, projectCode, placeholder, sendLabel, compact = false, autoFocus = false, onSubmit, onCancel },
  ref,
) {
  const { t, i18n } = useTranslation();
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [focused, setFocused] = useState(autoFocus);
  const inFlight = useRef(false);
  const composer = useComposerField({ text, onText: setText, maxLines: 8, allowSlash: false });
  const { field, trigger, tokens } = composer;
  const mentioning = composer.menuOpen && trigger?.char === "@";
  const candidates = useProductMentionCandidates(projectId, mentioning ? trigger.query : "");
  const menuId = useId();
  const hintId = useId();

  useImperativeHandle(ref, () => ({ focus: () => field.current?.focus() }), [field]);

  const groups: SuggestionGroup[] =
    mentioning && candidates.data && candidates.data.length > 0
      ? [
          {
            label: t("productDocs.comments.people", { code: projectCode }),
            items: candidates.data.map<Suggestion>((p) => ({
              id: `person:${p.id}`,
              group: "person",
              code: null,
              label: p.name,
              detail: null,
              insert: `@${p.name}`,
              personId: p.id,
            })),
          },
        ]
      : [];
  const options = mentioning ? flatten(groups) : [];
  const activeIndex = composer.activeIndex(options.length);

  const pick = (s: Suggestion) => composer.insert(s, { insert: s.insert });

  // Chi riceverà un avviso: le persone scelte dal menu, ancora nel testo.
  const named = [...new Set(tokens.filter((tok) => text.includes(tok.insert)).map((tok) => tok.insert.slice(1)))];
  const notified =
    named.length > 0
      ? t("productDocs.comments.notified", {
          count: named.length,
          names: new Intl.ListFormat(i18n.language, { type: "conjunction" }).format(named),
        })
      : null;

  const empty = text.trim() === "";
  const submit = () => {
    if (empty || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setFailed(false);
    onSubmit(text.trim()).then(
      () => {
        inFlight.current = false;
        setPending(false);
        composer.reset();
      },
      () => {
        inFlight.current = false;
        setPending(false);
        setFailed(true);
      },
    );
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (picksWithKey(e, mentioning, options)) {
      e.preventDefault();
      pick(options[activeIndex]!);
      return;
    }
    if (composer.handleKey(e, options)) return;
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === "Escape" && onCancel && empty) {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  };

  const open = !compact || focused || !empty || pending || failed;

  return (
    <div className="relative flex flex-col gap-2">
      {mentioning && (
        <SuggestionMenu
          id={menuId}
          header={t("productDocs.comments.people", { code: projectCode })}
          label={t("productDocs.comments.people", { code: projectCode })}
          groups={groups}
          active={activeIndex}
          onPick={pick}
          empty={
            candidates.isPending
              ? t("claude.conversation.menus.loading")
              : t("productDocs.comments.nobody", { q: trigger.query })
          }
        />
      )}
      <textarea
        ref={field}
        rows={compact && !open ? 1 : 2}
        value={text}
        autoFocus={autoFocus}
        aria-label={placeholder}
        placeholder={placeholder}
        aria-describedby={notified ? hintId : undefined}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={mentioning}
        aria-controls={mentioning ? menuId : undefined}
        aria-activedescendant={mentioning && options.length > 0 ? `${menuId}-${activeIndex}` : undefined}
        onChange={(e) => composer.update(e.target.value, e.target.selectionStart)}
        onSelect={(e) => composer.setCaret(e.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className="w-full resize-none rounded-md border border-rule-strong bg-surface px-2.5 py-1.5 text-md leading-5 text-ink placeholder:text-ink-faint focus:border-ink/45 focus:outline-none"
      />
      {notified && (
        <p id={hintId} className="text-xs text-ink-faint">
          {notified}
        </p>
      )}
      {failed && (
        <p role="alert" className="flex flex-wrap items-center gap-x-1.5 text-xs text-critical">
          <span>{t("productDocs.comments.postFailed")}</span>
          <span aria-hidden="true">·</span>
          <button type="button" onClick={submit} className="font-medium underline underline-offset-2">
            {t("productDocs.comments.retry")}
          </button>
        </p>
      )}
      {open && (
        <div className="flex items-center justify-end gap-1">
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex h-7 items-center rounded-md px-2 text-sm font-medium text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink"
            >
              {t("productDocs.comments.cancel")}
            </button>
          )}
          <button
            type="button"
            onClick={submit}
            disabled={empty || pending}
            aria-keyshortcuts="Meta+Enter"
            title={empty ? t("productDocs.comments.writeFirst") : `${sendLabel} · ⌘↩`}
            className="inline-flex h-7 items-center rounded-md bg-ink px-2.5 text-sm font-medium text-surface transition-opacity duration-[var(--duration-fast)] ease-out hover:opacity-90 disabled:cursor-default disabled:opacity-40"
          >
            {pending ? t("productDocs.comments.posting") : sendLabel}
          </button>
        </div>
      )}
    </div>
  );
});
