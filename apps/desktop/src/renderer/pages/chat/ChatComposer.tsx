import { useId, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { useDepartments, usePeople } from "../../data/queries";
import type { Attachment, CitationRef } from "../../data/types";
import { CheckItem, itemClass, MenuGroup, MenuNote } from "../../tasks-ui/Menu";
import { MenuButton } from "../tasks/controls";
import { AttachmentChip } from "../claude/conversation/AttachmentChip";
import type { DraftAttachment } from "../claude/conversation/Composer";
import { picksWithKey, useComposerField } from "../claude/conversation/useComposerField";
import {
  flatten,
  SuggestionMenu,
  useMentionSuggestions,
  type Suggestion,
  type SuggestionGroup,
} from "../claude/conversation/MentionMenu";
import {
  Glyph,
  PaperclipGlyph,
  primaryButton,
  quietButton,
  SendGlyph,
} from "../claude/conversation/parts";
import { readDraft, writeDraft } from "./drafts";

// La casella del canale: la stessa forma della conversazione (bordo
// `rule-strong` 8px, cresce fino a 10 righe), segnaposto «Message AUD ·
// general», suggerimento «# objects · @ people». Nessun «/» in chat. «#»
// cita un oggetto (entra come gettone codice + nome, che Backspace toglie
// intero), «@» le persone del canale prima, poi i reparti, «@channel» e
// «@Claude». Invio manda, Maiusc+Invio va a capo, ↑ nella casella vuota
// modifica il mio ultimo messaggio. La bozza resta per canale e persona.

const MAX_LINES = 10;

export interface ChatSendInput {
  text: string;
  attachments: Attachment[];
  citations: CitationRef[];
  asksReply: boolean;
  /** Solo nel thread: «Also send to …». */
  alsoInChannel: boolean;
}

/** Il testo chiama Claude: «@Claude» intero (non «@Claudette»). */
export const callsClaude = (text: string): boolean => /@Claude(?![\p{L}\p{N}_])/u.test(text);

/** Le voci di «@»: persone (quelle del canale prima), reparti presenti nel canale, @channel, @Claude. */
function usePeopleSuggestions(
  q: string,
  enabled: boolean,
  memberIds: readonly string[],
  viewerId: string,
): { groups: SuggestionGroup[]; loading: boolean } {
  const { t } = useTranslation();
  const base = useMentionSuggestions("people", q, enabled);
  const people = usePeople().data;
  const departments = useDepartments().data;
  const needle = q.trim().toLowerCase();
  const matches = (s: string) => !needle || s.toLowerCase().includes(needle);
  // Chi scrive non menziona se stesso.
  const personItems = base.groups.flatMap((g) => g.items).filter((s) => s.personId !== viewerId);
  const inChannel = (s: Suggestion) => (s.personId ? memberIds.includes(s.personId) : false);
  const sorted = [...personItems.filter(inChannel), ...personItems.filter((s) => !inChannel(s))];
  const departmentItems: Suggestion[] = (departments ?? []).flatMap((d) => {
    const count = memberIds.filter((id) =>
      people?.find((p) => p.id === id)?.departmentIds.includes(d.id),
    ).length;
    if (count === 0 || !matches(d.name)) return [];
    return [
      {
        id: `department:${d.id}`,
        group: "department",
        code: null,
        label: `@${d.name}`,
        detail: t("chat.composer.inChannel", { count }),
        insert: `@${d.name}`,
      },
    ];
  });
  const special: Suggestion[] = [
    {
      id: "channel",
      group: "special",
      code: null,
      label: "@channel",
      detail: t("chat.composer.channelMention"),
      insert: "@channel",
    },
    {
      id: "claude",
      group: "special",
      code: null,
      label: "@Claude",
      detail: t("chat.composer.claudeMention"),
      insert: "@Claude",
    },
  ].filter((s) => matches(s.label.slice(1)));
  const groups: SuggestionGroup[] = [
    { label: t("chat.composer.groups.people"), items: sorted },
    { label: t("chat.composer.groups.departments"), items: departmentItems },
    { label: t("chat.composer.groups.everyone"), items: special },
  ].filter((g) => g.items.length > 0);
  return { groups, loading: base.loading };
}

export function ChatComposer({
  channelId,
  channelLabel,
  viewerId,
  memberIds,
  attachments,
  attachError,
  onAddFiles,
  onRemoveAttachment,
  onSend,
  onEditLast,
  draftKey = channelId,
  placeholder,
  alsoSendTo,
  compact = false,
}: {
  channelId: string;
  /** «AUD · general»: il segnaposto e il nome del campo. */
  channelLabel: string;
  viewerId: string;
  memberIds: readonly string[];
  attachments: DraftAttachment[];
  attachError: string | null;
  onAddFiles: (files: File[]) => void;
  onRemoveAttachment: (id: string) => void;
  onSend: (input: ChatSendInput) => void;
  /** ↑ nella casella vuota: modifica il mio ultimo messaggio (se c'è). */
  onEditLast: () => boolean;
  /** Dove sta la bozza (di base il canale; il thread ha la sua). */
  draftKey?: string;
  /** Il segnaposto e il nome del campo, se non «Message AUD · general». */
  placeholder?: string;
  /** Nel thread: il canale di «Also send to …» (spenta di default e dopo ogni invio). */
  alsoSendTo?: string;
  /** Nel pannello del thread: margini stretti. */
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const [text, setTextState] = useState(() => readDraft(viewerId, draftKey));
  const [asksReply, setAsksReply] = useState(false);
  const [alsoInChannel, setAlsoInChannel] = useState(false);
  const alsoId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const menuId = useId();
  const hintId = useId();

  const setText = (next: string) => {
    setTextState(next);
    writeDraft(viewerId, draftKey, next);
  };
  // Nessun «/» in chat: solo «#» e «@».
  const composer = useComposerField({
    text,
    onText: setText,
    maxLines: MAX_LINES,
    allowSlash: false,
  });
  const { field, trigger, menuOpen, tokens } = composer;
  const objects = useMentionSuggestions(
    "objects",
    trigger?.query ?? "",
    menuOpen && trigger?.char === "#",
  );
  const persons = usePeopleSuggestions(
    trigger?.query ?? "",
    menuOpen && trigger?.char === "@",
    memberIds,
    viewerId,
  );
  const menu = trigger?.char === "@" ? persons : objects;
  const options = menuOpen ? flatten(menu.groups) : [];
  const activeIndex = composer.activeIndex(options.length);
  const hasContent = text.trim().length > 0 || attachments.length > 0;

  const pick = (s: Suggestion) => {
    if (!trigger) return;
    composer.insert(s, trigger.char === "#" && s.ref ? { insert: s.insert, ref: s.ref } : null);
  };

  const submit = () => {
    if (!hasContent) return;
    onSend({
      text: text.trim(),
      attachments: attachments.map((a) => a.attachment),
      citations: tokens.flatMap((tok) => (tok.ref && text.includes(tok.insert) ? [tok.ref] : [])),
      asksReply,
      alsoInChannel: alsoSendTo !== undefined && alsoInChannel,
    });
    composer.reset();
    setAsksReply(false);
    setAlsoInChannel(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (picksWithKey(e, menuOpen, options)) {
      e.preventDefault();
      pick(options[activeIndex]!);
      return;
    }
    if (composer.handleKey(e, options)) return;
    if (e.key === "ArrowUp" && !text && attachments.length === 0) {
      if (onEditLast()) e.preventDefault();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.length === 0) return;
    e.preventDefault();
    onAddFiles(files);
  };

  return (
    <div
      className={compact ? "px-3 pt-2 pb-3" : "px-8 pt-2 pb-5 @max-[620px]:px-4"}
      data-chat-composer
    >
      <div className="relative w-full max-w-[760px] min-w-0">
        {menuOpen && (
          <SuggestionMenu
            id={menuId}
            label={t(
              trigger!.char === "#"
                ? "claude.conversation.menus.label.objects"
                : "claude.conversation.menus.label.people",
            )}
            groups={menu.groups}
            active={activeIndex}
            onPick={pick}
            empty={
              menu.loading
                ? t("claude.conversation.menus.loading")
                : t("claude.conversation.menus.empty")
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
            aria-label={placeholder ?? t("chat.composer.label", { name: channelLabel })}
            aria-describedby={hintId}
            placeholder={placeholder ?? t("chat.composer.label", { name: channelLabel })}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? menuId : undefined}
            aria-activedescendant={
              menuOpen && options.length > 0 ? `${menuId}-${activeIndex}` : undefined
            }
            onChange={(e) => composer.update(e.target.value, e.target.selectionStart)}
            onSelect={(e) => composer.setCaret(e.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            className="block max-h-[216px] min-h-9 w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-md text-ink outline-none placeholder:text-ink-faint focus-visible:outline-none"
          />
          {alsoSendTo !== undefined && (
            <label
              htmlFor={alsoId}
              className="flex min-w-0 cursor-pointer items-center gap-2 px-3 pt-0.5 pb-1 text-sm text-ink-muted hover:text-ink"
            >
              <input
                id={alsoId}
                type="checkbox"
                data-also-in-channel
                checked={alsoInChannel}
                onChange={(e) => setAlsoInChannel(e.target.checked)}
                className="size-3.5 shrink-0 accent-ink"
              />
              <span className="min-w-0 truncate">
                {t("chat.composer.alsoSend", { name: alsoSendTo })}
              </span>
            </label>
          )}
          <div className="flex min-w-0 items-center gap-1 px-1.5 pb-1.5">
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              data-chat-file-input
              onChange={(e) => {
                onAddFiles([...(e.target.files ?? [])]);
                e.target.value = "";
              }}
            />
            <MenuButton
              placement="above"
              menuLabel={t("chat.composer.attachMenu")}
              ariaLabel={t("chat.composer.attach")}
              title={t("chat.composer.attach")}
              className={quietButton}
              label={<PaperclipGlyph />}
            >
              {(close) => (
                <MenuGroup>
                  <button
                    type="button"
                    role="menuitem"
                    className={itemClass}
                    onClick={() => {
                      close();
                      fileInput.current?.click();
                    }}
                  >
                    {t("chat.composer.upload")}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    aria-disabled="true"
                    className={`${itemClass} cursor-default flex-col items-start gap-0 opacity-60 hover:bg-transparent`}
                    onClick={(e) => e.preventDefault()}
                  >
                    <span>{t("chat.composer.drive")}</span>
                    <span className="text-xs text-ink-muted">{t("chat.composer.driveSoon")}</span>
                  </button>
                </MenuGroup>
              )}
            </MenuButton>
            <MenuButton
              placement="above"
              menuLabel={t("chat.composer.options")}
              ariaLabel={t("chat.composer.options")}
              title={t("chat.composer.options")}
              className={quietButton}
              label={<OptionsGlyph />}
            >
              {() => (
                <MenuGroup>
                  <CheckItem checked={asksReply} onToggle={() => setAsksReply((v) => !v)}>
                    {t("chat.composer.askReply")}
                  </CheckItem>
                  <MenuNote>{t("chat.composer.askReplyNote")}</MenuNote>
                </MenuGroup>
              )}
            </MenuButton>
            <span className="ml-1 min-w-0 truncate text-xs text-ink-faint" aria-hidden="true">
              {t("chat.composer.triggers")}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                className={primaryButton}
                disabled={!hasContent}
                onClick={submit}
              >
                <SendGlyph />
                {t("chat.composer.send")}
              </button>
            </span>
          </div>
        </div>
        <p id={hintId} className="min-h-4 pt-1.5 text-xs text-ink-muted" aria-live="polite">
          {callsClaude(text)
            ? t("chat.composer.claudeWarning", { name: channelLabel })
            : asksReply
              ? t("chat.composer.asksReplyOn")
              : ""}
        </p>
      </div>
    </div>
  );
}

const OptionsGlyph = () => (
  <Glyph size={14}>
    <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" strokeWidth={2.2} />
  </Glyph>
);
