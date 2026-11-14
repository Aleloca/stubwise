import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  useInvalidateSupport,
  useSessionPersonId,
  type SupportConversationView,
} from "../../data/queries";
import { hasModKey, shortcutLabel } from "../../platform/platform";
import { useToast } from "../../tasks-ui/Toast";
import { primaryButton, quietButton } from "../claude/conversation/parts";
import { DRAFT_SAVE_MS } from "../mail/useComposerDraft";
import { customerName } from "./format";
import {
  pendingFor,
  readDraft,
  scheduleReply,
  sendFailed,
  takeBackReply,
  usePendingReplies,
  writeDraft,
} from "./replyStore";

// La casella della risposta (shape support.md §3, §5): la stessa casella
// della Posta senza righe d'intestazione. Nulla parte senza «Invia»
// (⌘Enter), e l'invio aspetta 5 s per l'«Annulla» [A 11]. Il testo resta
// della persona che lo scrive (`replyStore`). Area 8, F3 (decisione del
// maintainer): nessuna bozza di Claude, né pronta né chiesta.

export function ReplyComposer({
  conv,
  footer,
  onSent,
  bodyRef,
}: {
  conv: SupportConversationView;
  /** Sotto la casella: una riga di contesto. */
  footer?: ReactNode;
  /** Partito davvero (dopo i 5 s): il fuoco va al messaggio inviato. */
  onSent: () => void;
  bodyRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const { t } = useTranslation();
  const me = useSessionPersonId();
  const toast = useToast();
  const invalidate = useInvalidateSupport();
  usePendingReplies();
  const body = readDraft(me, conv.code);
  const setBody = (text: string) => writeDraft(me, conv.code, text);

  const [saved, setSaved] = useState(body !== "");
  const timer = useRef<number | null>(null);
  useEffect(() => () => void (timer.current && window.clearTimeout(timer.current)), []);

  const edit = (text: string) => {
    setBody(text);
    setSaved(false);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setSaved(true), DRAFT_SAVE_MS);
  };

  const name = customerName(conv, t);

  // Un invio alla volta (I1): finché il precedente è nella finestra
  // dell'«Annulla», «Invia» è fermo e dice perché.
  const waiting = pendingFor(me, conv.code) !== null;
  const canSend = body.trim() !== "" && !waiting;
  const sendReason = waiting
    ? t("support.reply.waitPrevious")
    : body.trim() === ""
      ? t("support.reply.emptyReason")
      : null;
  const send = () => {
    if (!canSend) return;
    const text = body.trim();
    const scheduled = scheduleReply(conv.code, text, async () => {
      await invalidate();
      onSent();
    });
    if (!scheduled) return;
    setSaved(false);
    const personId = me;
    toast.show(t("support.reply.sentTo", { name }), {
      action: {
        label: t("support.reply.undo"),
        run: () => {
          if (takeBackReply(personId, conv.code)) {
            requestAnimationFrame(() => bodyRef.current?.focus());
          }
        },
      },
    });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!hasModKey(e) || e.altKey) return;
    if (e.key === "Enter") {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <form
        aria-label={t("support.reply.to", { name })}
        data-support-composer={conv.code}
        onSubmit={(e) => e.preventDefault()}
        onKeyDown={onKeyDown}
        className="compose-enter flex min-w-0 flex-col rounded-lg border border-rule-strong bg-surface"
      >
        <p className="flex h-8 items-center border-b border-rule px-3 text-xs font-semibold text-ink-muted">
          {t("support.reply.to", { name })} · {t("support.reply.inMcp")}
        </p>
        <textarea
          ref={bodyRef}
          aria-label={t("support.reply.message")}
          value={body}
          onChange={(e) => edit(e.target.value)}
          rows={4}
          className="max-h-[50vh] min-h-[112px] resize-none bg-transparent px-3 py-2.5 text-md text-ink outline-none placeholder:text-ink-faint"
          placeholder={t("support.reply.placeholder", { name })}
        />
        {sendFailed(me, conv.code) && (
          <p role="alert" className="border-t border-rule px-3 py-2 text-sm text-critical">
            {t("support.reply.notSentBack")}
          </p>
        )}
        <div className="flex min-h-12 flex-wrap items-center gap-1 border-t border-rule px-2 py-2">
          <span className="ml-auto flex items-center gap-1">
            {saved && body !== "" && (
              <span role="status" className="px-1 text-xs text-ink-faint">
                {t("support.reply.saved")}
              </span>
            )}
            {body !== "" && (
              <button type="button" className={quietButton} onClick={() => edit("")}>
                {t("support.reply.discard")}
              </button>
            )}
            <button
              type="button"
              className={primaryButton}
              disabled={!canSend}
              title={
                canSend
                  ? `${t("support.reply.send")} (${shortcutLabel(["mod", "Enter"])})`
                  : (sendReason ?? undefined)
              }
              onClick={send}
            >
              {t("support.reply.send")}
            </button>
          </span>
        </div>
      </form>
      {footer}
    </div>
  );
}
