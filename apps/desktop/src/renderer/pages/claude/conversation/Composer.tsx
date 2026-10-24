import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { useProjects, useSetConversationContext } from "../../../data/queries";
import type { ConversationStream } from "../../../data/queries";
import type { Attachment, ConversationDetail } from "../../../data/types";
import { MenuGroup, RadioItem } from "../../../tasks-ui/Menu";
import { Chevron, MenuButton } from "../../tasks/controls";
import { AttachmentChip } from "./AttachmentChip";
import { useCommandSuggestions } from "./CommandMenu";
import { flatten, SuggestionMenu, useMentionSuggestions, type Suggestion } from "./MentionMenu";
import {
  AtGlyph,
  HashGlyph,
  PaperclipGlyph,
  primaryButton,
  quietButton,
  secondaryButton,
  SendGlyph,
  SlashGlyph,
  StopGlyph,
} from "./parts";

/** Un allegato scelto e non ancora inviato, con la miniatura se è un'immagine. */
export interface DraftAttachment {
  attachment: Attachment;
  previewUrl?: string;
}

/** Quante righe cresce il campo prima di scorrere. */
const MAX_LINES = 8;
const LINE_PX = 20;

type Trigger = { char: "/" | "#" | "@"; query: string; start: number; end: number };

/**
 * Il carattere di un menu appena prima del cursore: «/» solo all'inizio del
 * messaggio, «#» e «@» all'inizio di una parola.
 */
export function triggerAt(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  const slash = /^\/(\S{0,40})$/.exec(before);
  if (slash) return { char: "/", query: slash[1]!, start: 0, end: caret };
  const mention = /(^|\s)([#@])([^\s#@]{0,40})$/.exec(before);
  if (!mention) return null;
  const start = caret - mention[3]!.length - 1;
  return { char: mention[2] as "#" | "@", query: mention[3]!, start, end: caret };
}

/**
 * La casella in fondo alla conversazione: bordo `rule-strong`, cresce fino a
 * 8 righe. Invio manda, Maiusc+Invio va a capo. «/» (all'inizio) apre i
 * comandi, «#» gli oggetti, «@» le persone: l'oggetto scelto entra come un
 * gettone (codice + nome) che Backspace toglie intero. Allegati con la
 * graffetta, incollando immagini o trascinando sul componente.
 *
 * Mentre Claude lavora (`canInterrupt`) il bottone di destra è Stop (⌘.);
 * con del testo diventa Send — il messaggio entra nel turno — accanto a
 * «Stop and send». In riconnessione si scrive ma l'invio aspetta.
 */
export function Composer({
  detail,
  connection,
  compact,
  attachments,
  attachError,
  onAddFiles,
  onRemoveAttachment,
  onSend,
  onStop,
  onStopAndSend,
  placeholder,
}: {
  detail: ConversationDetail;
  connection: ConversationStream["connection"];
  compact: boolean;
  attachments: DraftAttachment[];
  attachError: string | null;
  onAddFiles: (files: File[]) => void;
  onRemoveAttachment: (id: string) => void;
  /** Manda il messaggio; risolve quando la scrittura è accettata (o fallisce). */
  onSend: (text: string, attachments: Attachment[]) => void;
  onStop: () => void;
  onStopAndSend: (text: string) => void;
  /** Il segnaposto della casella, se diverso da «Ask Claude…» (la continuazione). */
  placeholder?: string;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [tokens, setTokens] = useState<string[]>([]);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const menuId = useId();
  const hintId = useId();
  const setContext = useSetConversationContext();

  const contextProjectId =
    detail.kind === "free" ? detail.contextProjectId : (detail.projectId ?? null);
  const trigger = triggerAt(text, caret);
  const menuOpen = trigger !== null && dismissed !== trigger.start;
  const mentions = useMentionSuggestions(
    trigger?.char === "@" ? "people" : "objects",
    trigger?.char === "/" ? "" : (trigger?.query ?? ""),
    menuOpen && trigger?.char !== "/",
  );
  const commands = useCommandSuggestions(
    contextProjectId,
    trigger?.char === "/" ? trigger.query : "",
    menuOpen && trigger?.char === "/",
  );
  const menu = trigger?.char === "/" ? commands : mentions;
  const options = menuOpen ? flatten(menu.groups) : [];
  const activeIndex = Math.min(active, Math.max(0, options.length - 1));

  const working = detail.canInterrupt;
  const reconnecting = connection === "reconnecting";
  const hasContent = text.trim().length > 0 || attachments.length > 0;

  // Il campo cresce con il testo, fino a 8 righe.
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_LINES * LINE_PX + 16)}px`;
  }, [text]);

  // ⌘. (Ctrl+. fuori dal Mac) ferma Claude, ovunque nella finestra.
  useEffect(() => {
    if (!working) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== ".") return;
      // Solo per questa conversazione: non con un dialogo aperto, e non se
      // il fuoco è in un'altra parte della finestra (un'altra conversazione,
      // un campo del pannello accanto).
      if (document.querySelector('[aria-modal="true"]')) return;
      const root = field.current?.closest("[data-conversation]");
      const active = document.activeElement;
      const here = !active || active === document.body || (root?.contains(active) ?? false);
      if (here) {
        e.preventDefault();
        onStop();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [working, onStop]);

  const update = (next: string, at: number) => {
    setText(next);
    setCaret(at);
    setActive(0);
    // Un gettone modificato a mano non è più un gettone.
    setTokens((list) => list.filter((tok) => next.includes(tok)));
  };

  const place = (at: number) =>
    requestAnimationFrame(() => {
      field.current?.setSelectionRange(at, at);
      field.current?.focus();
    });

  const pick = (s: Suggestion) => {
    if (!trigger) return;
    const insert = `${s.insert} `;
    const next = text.slice(0, trigger.start) + insert + text.slice(trigger.end);
    const at = trigger.start + insert.length;
    update(next, at);
    if (trigger.char !== "/") setTokens((list) => [...list, s.insert]);
    // Citare un oggetto in una libera senza progetto ne fissa il contesto.
    if (
      detail.kind === "free" &&
      detail.canManage &&
      detail.contextProjectId === null &&
      s.projectId &&
      trigger.char === "#"
    ) {
      setContext.mutate({ id: detail.id, projectId: s.projectId });
    }
    place(at);
  };

  const submit = () => {
    if (!hasContent || reconnecting) return;
    onSend(
      text.trim(),
      attachments.map((a) => a.attachment),
    );
    setText("");
    setCaret(0);
    setTokens([]);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen && options.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setActive((activeIndex + step + options.length) % options.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pick(options[activeIndex]!);
        return;
      }
    }
    if (menuOpen && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setDismissed(trigger!.start);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === "Backspace") {
      const el = e.currentTarget;
      if (el.selectionStart !== el.selectionEnd) return;
      const before = text.slice(0, el.selectionStart);
      const token = tokens.find((tok) => {
        const trimmed = before.endsWith(`${tok} `) ? `${tok} ` : before.endsWith(tok) ? tok : null;
        if (!trimmed) return false;
        const at = before.length - trimmed.length;
        return at === 0 || /\s/.test(before[at - 1]!);
      });
      if (token) {
        e.preventDefault();
        const length = before.endsWith(`${token} `) ? token.length + 1 : token.length;
        const at = before.length - length;
        update(text.slice(0, at) + text.slice(el.selectionStart), at);
        setTokens((list) => list.filter((tok) => tok !== token));
        place(at);
      }
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.length === 0) return;
    e.preventDefault();
    onAddFiles(files);
  };

  const insertTrigger = (char: "/" | "#" | "@") => {
    const el = field.current;
    const at = el?.selectionStart ?? text.length;
    if (char === "/") {
      if (text.trim()) return;
      update("/", 1);
      place(1);
      return;
    }
    const pad = at > 0 && !/\s/.test(text[at - 1]!) ? " " : "";
    const next = text.slice(0, at) + pad + char + text.slice(at);
    update(next, at + pad.length + 1);
    place(at + pad.length + 1);
  };

  const hintKey = working
    ? detail.kind === "free"
      ? "claude.conversation.composer.absorbFree"
      : "claude.conversation.composer.absorb"
    : null;

  return (
    <div className={compact ? "px-4 pt-2 pb-3" : "px-8 pt-2 pb-5"}>
      <div className="relative mx-auto w-full max-w-[720px] min-w-0">
        {menuOpen && (
          <SuggestionMenu
            id={menuId}
            label={t(
              `claude.conversation.menus.label.${trigger!.char === "/" ? "commands" : trigger!.char === "#" ? "objects" : "people"}`,
            )}
            groups={menu.groups}
            active={activeIndex}
            onPick={pick}
            empty={
              menu.loading
                ? t("claude.conversation.menus.loading")
                : t("claude.conversation.menus.empty")
            }
            note={
              trigger!.char === "/" && contextProjectId === null
                ? t("claude.conversation.menus.setProject")
                : null
            }
          />
        )}
        <div className="flex min-w-0 flex-col rounded-lg border border-rule-strong bg-surface transition-colors duration-[var(--duration-fast)] ease-out focus-within:border-ink/45">
          {attachments.length > 0 && (
            <ul
              aria-label={t("claude.conversation.attachments.list")}
              className="flex flex-wrap gap-1.5 px-2.5 pt-2.5"
            >
              {attachments.map((a) => (
                <li key={a.attachment.id} className="min-w-0">
                  <AttachmentChip
                    attachment={a.attachment}
                    {...(a.previewUrl ? { previewUrl: a.previewUrl } : {})}
                    onRemove={() => onRemoveAttachment(a.attachment.id)}
                  />
                </li>
              ))}
            </ul>
          )}
          {attachError && (
            <p role="alert" className="px-3 pt-2 text-sm text-critical">
              {attachError}
            </p>
          )}
          <textarea
            ref={field}
            rows={1}
            value={text}
            aria-label={t("claude.conversation.composer.label")}
            aria-describedby={hintId}
            placeholder={
              placeholder ??
              (compact
                ? t("claude.conversation.composer.placeholder")
                : t("claude.conversation.composer.placeholderHint"))
            }
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? menuId : undefined}
            aria-activedescendant={
              menuOpen && options.length > 0 ? `${menuId}-${activeIndex}` : undefined
            }
            onChange={(e) => update(e.target.value, e.target.selectionStart)}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            className="block max-h-[176px] min-h-9 w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-md text-ink outline-none placeholder:text-ink-faint focus-visible:outline-none"
          />
          <div className="flex min-w-0 items-center gap-1 px-1.5 pb-1.5">
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                onAddFiles([...(e.target.files ?? [])]);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              className={quietButton}
              aria-label={t("claude.conversation.attachments.add")}
              title={t("claude.conversation.attachments.add")}
              onClick={() => fileInput.current?.click()}
            >
              <PaperclipGlyph />
              {!compact && <span>{t("claude.conversation.attachments.attach")}</span>}
            </button>
            {detail.kind === "free" && detail.canManage && (
              <ContextChip
                conversationId={detail.id}
                projectId={detail.contextProjectId}
                onChange={(projectId) => setContext.mutate({ id: detail.id, projectId })}
              />
            )}
            {compact ? (
              <span className="flex items-center">
                {(["/", "#", "@"] as const).map((char) => (
                  <button
                    key={char}
                    type="button"
                    className="grid size-8 place-items-center rounded-md text-ink-muted hover:bg-ink/6 hover:text-ink"
                    aria-label={t(
                      `claude.conversation.composer.insert.${char === "/" ? "command" : char === "#" ? "object" : "person"}`,
                    )}
                    title={t(
                      `claude.conversation.composer.insert.${char === "/" ? "command" : char === "#" ? "object" : "person"}`,
                    )}
                    onClick={() => insertTrigger(char)}
                  >
                    {char === "/" ? <SlashGlyph /> : char === "#" ? <HashGlyph /> : <AtGlyph />}
                  </button>
                ))}
              </span>
            ) : (
              <span className="ml-1 min-w-0 truncate text-xs text-ink-faint" aria-hidden="true">
                {t("claude.conversation.composer.triggers")}
              </span>
            )}
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              {working && hasContent && (
                <button
                  type="button"
                  className={secondaryButton}
                  disabled={reconnecting || attachments.length > 0 || !text.trim()}
                  title={
                    attachments.length > 0
                      ? t("claude.conversation.composer.stopAndSendNoFiles")
                      : undefined
                  }
                  onClick={() => {
                    onStopAndSend(text.trim());
                    setText("");
                    setCaret(0);
                    setTokens([]);
                  }}
                >
                  {t("claude.conversation.composer.stopAndSend")}
                </button>
              )}
              {working && !hasContent ? (
                <button
                  type="button"
                  className={secondaryButton}
                  onClick={onStop}
                  aria-keyshortcuts="Meta+Period"
                  title={t("claude.conversation.composer.stopShortcut")}
                >
                  <StopGlyph />
                  {t("claude.conversation.composer.stop")}
                </button>
              ) : (
                <button
                  type="button"
                  className={primaryButton}
                  disabled={!hasContent || reconnecting}
                  onClick={submit}
                >
                  <SendGlyph />
                  {t("claude.conversation.composer.send")}
                </button>
              )}
            </span>
          </div>
        </div>
        <p id={hintId} className="min-h-4 pt-1.5 text-xs text-ink-muted" aria-live="polite">
          {reconnecting
            ? t("claude.conversation.composer.sendSuspended")
            : hintKey && hasContent
              ? t(hintKey)
              : ""}
        </p>
      </div>
    </div>
  );
}

/** Il progetto di contesto di una libera: decide le skill di «/». */
function ContextChip({
  conversationId,
  projectId,
  onChange,
}: {
  conversationId: string;
  projectId: string | null;
  onChange: (projectId: string | null) => void;
}) {
  const { t } = useTranslation();
  const projects = useProjects().data ?? [];
  const current = projects.find((p) => p.id === projectId);
  return (
    <MenuButton
      key={conversationId}
      placement="above"
      menuLabel={t("claude.conversation.context.menu")}
      className={`${quietButton} max-w-[220px]`}
      label={
        <>
          <span className="truncate">
            {current
              ? t("claude.conversation.context.project", { code: current.code })
              : t("claude.conversation.context.none")}
          </span>
          <Chevron />
        </>
      }
    >
      {(close) => (
        <MenuGroup label={t("claude.conversation.context.menu")}>
          <RadioItem
            checked={projectId === null}
            onSelect={() => {
              onChange(null);
              close();
            }}
          >
            {t("claude.conversation.context.noneItem")}
          </RadioItem>
          {projects.map((p) => (
            <RadioItem
              key={p.id}
              checked={p.id === projectId}
              onSelect={() => {
                onChange(p.id);
                close();
              }}
            >
              <span className="num w-10 shrink-0 text-xs font-semibold">{p.code}</span>
              <span className="truncate">{p.name}</span>
            </RadioItem>
          ))}
        </MenuGroup>
      )}
    </MenuButton>
  );
}
