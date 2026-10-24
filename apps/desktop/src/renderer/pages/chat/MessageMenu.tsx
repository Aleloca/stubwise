import { useState } from "react";
import { useTranslation } from "react-i18next";
import { itemClass, MenuGroup } from "../../tasks-ui/Menu";
import { MenuButton } from "../tasks/controls";
import { Glyph } from "../claude/conversation/parts";

// La barra che compare al passaggio (o al fuoco) su un messaggio, in alto a
// destra: 3 reazioni rapide, «Reply in thread», «⋯». Il menu «⋯» ha tutto:
// Reply in thread · Add reaction · Copy link · Mark unread from here ·
// Create task · Create request · Edit e Delete (solo i propri). A 1024px le
// reazioni rapide lasciano il posto (query del contenitore del flusso).

export interface MessageActions {
  replyHref: string;
  /** «Reply in thread»: il pannello si apre con il fuoco nella casella. */
  onReply?: () => void;
  onQuickReact: (emoji: string) => void;
  onAddReaction: () => void;
  onCopyLink: () => void;
  onMarkUnread: () => void;
  onCreateTask: () => void;
  onCreateRequest: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

const toolButton =
  "grid size-7 place-items-center rounded-md text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/8 hover:text-ink";

export const ReplyGlyph = () => (
  <Glyph size={14}>
    <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
  </Glyph>
);
const MoreGlyph = () => (
  <Glyph size={14}>
    <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" strokeWidth={2.2} />
  </Glyph>
);

export function MessageMenu({
  actions,
  quick,
  canReact,
  canWrite,
  own,
  member,
}: {
  actions: MessageActions;
  /** Le 3 reazioni rapide (le più usate da chi guarda). */
  quick: readonly string[];
  canReact: boolean;
  /** Il canale si scrive (membro, non archiviato): rispondere, modificare, eliminare. */
  canWrite: boolean;
  /** Il messaggio è di chi guarda. */
  own: boolean;
  /** Chi guarda è membro (ha una lettura da spostare). */
  member: boolean;
}) {
  const { t } = useTranslation();
  // Nella metà bassa della finestra il menu si apre sopra: sotto lo taglierebbe il flusso.
  const [placement, setPlacement] = useState<"below" | "above">("below");
  const measure = (el: HTMLElement) =>
    setPlacement(el.getBoundingClientRect().top > window.innerHeight / 2 ? "above" : "below");
  return (
    <div
      onPointerEnter={(e) => measure(e.currentTarget)}
      onFocusCapture={(e) => measure(e.currentTarget)}
      role="toolbar"
      aria-label={t("chat.actions.toolbar")}
      data-message-toolbar
      className="absolute -top-4 right-2 z-20 flex items-center gap-0.5 rounded-md border border-rule-strong bg-surface p-0.5 opacity-0 shadow-[0_4px_16px_-4px_oklch(0_0_0/0.35)] transition-opacity duration-[var(--duration-fast)] ease-out group-focus-within/message:opacity-100 group-hover/message:opacity-100 has-[[aria-expanded=true]]:opacity-100"
    >
      {canReact && (
        <span className="flex items-center gap-0.5 @max-[760px]:hidden">
          {quick.slice(0, 3).map((emoji) => (
            <button
              key={emoji}
              type="button"
              className={`${toolButton} text-md leading-none`}
              aria-label={t("chat.actions.quickReact", { emoji })}
              title={t("chat.actions.quickReact", { emoji })}
              onClick={() => actions.onQuickReact(emoji)}
            >
              {emoji}
            </button>
          ))}
        </span>
      )}
      <a
        href={actions.replyHref}
        onClick={() => actions.onReply?.()}
        className={toolButton}
        aria-label={t("chat.actions.reply")}
        title={t("chat.actions.reply")}
      >
        <ReplyGlyph />
      </a>
      <MenuButton
        menuLabel={t("chat.actions.menu")}
        ariaLabel={t("chat.actions.more")}
        title={t("chat.actions.more")}
        align="right"
        placement={placement}
        className={toolButton}
        label={<MoreGlyph />}
      >
        {(close) => {
          const item = (label: string, run: () => void, extra = "") => (
            <button
              type="button"
              role="menuitem"
              className={`${itemClass} ${extra}`}
              onClick={() => {
                close();
                run();
              }}
            >
              {label}
            </button>
          );
          return (
            <>
              <MenuGroup>
                <a
                  role="menuitem"
                  href={actions.replyHref}
                  className={itemClass}
                  onClick={() => {
                    close();
                    actions.onReply?.();
                  }}
                >
                  {t("chat.actions.reply")}
                </a>
                {canReact && item(t("chat.actions.react"), actions.onAddReaction)}
                {item(t("chat.actions.copyLink"), actions.onCopyLink)}
                {member && item(t("chat.actions.markUnread"), actions.onMarkUnread)}
              </MenuGroup>
              <MenuGroup>
                {item(t("chat.actions.createTask"), actions.onCreateTask)}
                {item(t("chat.actions.createRequest"), actions.onCreateRequest)}
              </MenuGroup>
              {own && canWrite && (
                <MenuGroup>
                  {item(t("chat.actions.edit"), actions.onEdit)}
                  {item(t("chat.actions.delete"), actions.onDelete, "text-critical")}
                </MenuGroup>
              )}
            </>
          );
        }}
      </MenuButton>
    </div>
  );
}
