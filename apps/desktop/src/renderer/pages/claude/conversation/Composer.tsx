import { useEffect, useId, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { AiBlockLine } from "../../../components/InstanceBlock";
import {
  useAiBlock,
  useProjects,
  useSetConversationContext,
  useStorageAllowsUploads,
} from "../../../data/queries";
import type { ConversationStream } from "../../../data/queries";
import type { Attachment, ConversationDetail } from "../../../data/types";
import { MenuGroup, RadioItem } from "../../../tasks-ui/Menu";
import { Chevron, MenuButton } from "../../tasks/controls";
import { AttachmentChip } from "./AttachmentChip";
import { useCommandSuggestions } from "./CommandMenu";
import { flatten, SuggestionMenu, useMentionSuggestions, type Suggestion } from "./MentionMenu";
import { picksWithKey, useComposerField } from "./useComposerField";
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

export { triggerAt } from "./useComposerField";

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
  const composer = useComposerField({
    text,
    onText: setText,
    maxLines: MAX_LINES,
    allowSlash: true,
  });
  const { field, trigger, menuOpen, update, place } = composer;
  const fileInput = useRef<HTMLInputElement>(null);
  const menuId = useId();
  const hintId = useId();
  const setContext = useSetConversationContext();

  const contextProjectId =
    detail.kind === "free" ? detail.contextProjectId : (detail.projectId ?? null);
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
  const activeIndex = composer.activeIndex(options.length);

  const working = detail.canInterrupt;
  const reconnecting = connection === "reconnecting";
  const hasContent = text.trim().length > 0 || attachments.length > 0;
  // Area 9b: «Chiedi a Claude» si ferma solo per il budget del mese (la pausa
  // della coda non la tocca): Send spento con la frase, il testo resta [EF 5].
  const free = detail.kind === "free";
  const block = useAiBlock(null).data ?? null;
  const budget = free && block?.reason === "monthly_budget";
  // I caricamenti spenti: la graffetta è spenta; un file incollato lo dice per 4 s.
  const uploadsOff = useStorageAllowsUploads().data === false;
  const [uploadNotice, setUploadNotice] = useState(false);
  useEffect(() => {
    if (!uploadNotice) return;
    const timer = setTimeout(() => setUploadNotice(false), 4000);
    return () => clearTimeout(timer);
  }, [uploadNotice]);

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

  const pick = (s: Suggestion) => {
    if (!trigger) return;
    composer.insert(s, trigger.char !== "/" ? { insert: s.insert } : null);
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
  };

  const submit = () => {
    if (!hasContent || reconnecting || budget) return;
    onSend(
      text.trim(),
      attachments.map((a) => a.attachment),
    );
    composer.reset();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (picksWithKey(e, menuOpen, options)) {
      e.preventDefault();
      pick(options[activeIndex]!);
      return;
    }
    if (composer.handleKey(e, options)) return;
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.length === 0) return;
    e.preventDefault();
    if (uploadsOff) {
      setUploadNotice(true);
      return;
    }
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
      <div className={`relative w-full max-w-[720px] min-w-0 ${compact ? "mx-auto" : ""}`}>
        {budget && block && (
          <div className="pb-2">
            <AiBlockLine block={block} projectCode="" chat />
          </div>
        )}
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
            onSelect={(e) => composer.setCaret(e.currentTarget.selectionStart)}
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
              className={`${quietButton} disabled:opacity-40`}
              aria-label={t("claude.conversation.attachments.add")}
              title={
                uploadsOff
                  ? t("instanceEffects.storage.attach")
                  : t("claude.conversation.attachments.add")
              }
              disabled={uploadsOff}
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
                    composer.reset();
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
                  disabled={!hasContent || reconnecting || budget}
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
          {uploadNotice
            ? t("instanceEffects.storage.attach")
            : reconnecting
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
