import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  useInvalidateSupport,
  useSessionPersonId,
  useSupportClaudeDraft,
  type SupportConversationView,
} from "../../data/queries";
import { placeDraft } from "../../domain/claude/intents/mailDraft";
import { hasModKey, shortcutLabel } from "../../platform/platform";
import { useToast } from "../../tasks-ui/Toast";
import {
  primaryButton,
  quietButton,
  secondaryButton,
  StopGlyph,
} from "../claude/conversation/parts";
import { ClaudeMark } from "../mail/ClaudeDraftButton";
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

// La casella della risposta al cliente (shape support.md §3, §5): la stessa
// casella della Posta senza righe d'intestazione. La bozza già pronta di
// Claude NON riempie la casella [A 9]: «Usa la bozza» la mette nel corpo;
// «Bozza di Claude» (⌘J) la rigenera a pezzi nel corpo, con Stop. Nulla
// parte senza «Invia al cliente» (⌘Enter), e l'invio aspetta 5 s per
// l'«Annulla» [A 11]. Il testo resta della persona che lo scrive (`replyStore`).

type Ask = "prepared" | "regenerate" | null;

export function ReplyComposer({
  conv,
  footer,
  onSent,
  bodyRef,
}: {
  conv: SupportConversationView;
  /** Sotto la casella: l'ultima volta che il cliente ha visto la conversazione, l'email. */
  footer?: ReactNode;
  /** Partito davvero (dopo i 5 s): il fuoco va al messaggio inviato. */
  onSent: () => void;
  bodyRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const { t } = useTranslation();
  const me = useSessionPersonId();
  const toast = useToast();
  const invalidate = useInvalidateSupport();
  const claude = useSupportClaudeDraft();
  usePendingReplies();
  const body = readDraft(me, conv.code);
  const setBody = (text: string) => writeDraft(me, conv.code, text);
  const id = useId();

  const [saved, setSaved] = useState(body !== "");
  const [showPrepared, setShowPrepared] = useState(false);
  const [ask, setAsk] = useState<Ask>(null);
  const [placedFrom, setPlacedFrom] = useState<string | null>(null);
  const before = useRef<{ body: string; how: "replace" | "below" }>({ body: "", how: "replace" });
  const timer = useRef<number | null>(null);
  useEffect(() => () => void (timer.current && window.clearTimeout(timer.current)), []);

  const edit = (text: string) => {
    setBody(text);
    setSaved(false);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setSaved(true), DRAFT_SAVE_MS);
  };

  // La bozza rigenerata, finita o fermata, entra nel corpo una volta.
  const settled = claude.state.status === "done" || claude.state.status === "stopped";
  const settledText = settled ? (claude.state as { text: string }).text : null;
  useEffect(() => {
    if (settledText === null) return;
    const text = placeDraft(before.current.body, settledText, before.current.how);
    edit(text);
    setPlacedFrom(text);
    requestAnimationFrame(() => bodyRef.current?.focus());
  }, [settledText]);

  const writing = claude.state.status === "writing";
  const streaming = writing
    ? placeDraft(before.current.body, (claude.state as { text: string }).text, before.current.how)
    : null;
  const name = customerName(conv, t);
  const requestCode = conv.request?.code ?? null;

  const regenerate = (how: "replace" | "below") => {
    setAsk(null);
    before.current = { body, how };
    setPlacedFrom(null);
    claude.start(conv.code);
  };
  const usePrepared = (how: "replace" | "below") => {
    setAsk(null);
    const text = placeDraft(body, conv.claudeDraft ?? "", how);
    edit(text);
    setPlacedFrom(text);
    setShowPrepared(false);
    requestAnimationFrame(() => bodyRef.current?.focus());
  };
  const choose = (source: "prepared" | "regenerate") => {
    if (writing) return;
    if (body.trim()) setAsk(source);
    else if (source === "prepared") usePrepared("replace");
    else regenerate("replace");
  };

  // Un invio alla volta (I1): finché il precedente è nella finestra
  // dell'«Annulla», «Invia» è fermo e dice perché.
  const waiting = pendingFor(me, conv.code) !== null;
  const canSend = body.trim() !== "" && !writing && !waiting;
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
    setPlacedFrom(null);
    claude.reset();
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
    } else if (e.key.toLowerCase() === "j" && !e.shiftKey) {
      e.preventDefault();
      choose("regenerate");
    } else if (e.key === ".") {
      e.preventDefault();
      claude.stop();
    }
  };

  const edited = placedFrom !== null && body !== placedFrom;
  const draftNote = requestCode
    ? t("support.reply.draftByWith", { code: requestCode })
    : t("support.reply.draftBy");

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
          {t("support.reply.to", { name })} ·{" "}
          {t(conv.channel === "widget" ? "support.reply.inWidget" : "support.reply.inMcp")}
        </p>
        {conv.claudeDraft && placedFrom === null && !writing && (
          <div className="flex flex-col gap-1 border-b border-rule px-3 py-2 text-xs">
            <p className="flex flex-wrap items-center gap-1.5 text-ink-muted">
              <ClaudeMark />
              <span className="font-medium text-ink">{t("support.reply.prepared")}</span>·
              <button
                type="button"
                onClick={() => choose("prepared")}
                className="rounded-sm font-semibold text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink"
              >
                {t("support.reply.useDraft")}
              </button>
              ·
              <button
                type="button"
                aria-expanded={showPrepared}
                aria-controls={`${id}-prepared`}
                onClick={() => setShowPrepared((s) => !s)}
                className="rounded-sm underline decoration-ink/30 underline-offset-2 hover:text-ink"
              >
                {showPrepared ? t("support.reply.hide") : t("support.reply.show")}
              </button>
            </p>
            {showPrepared && (
              <p
                id={`${id}-prepared`}
                className="max-w-[72ch] pl-[22px] text-sm whitespace-pre-wrap text-ink-muted [overflow-wrap:anywhere]"
              >
                {conv.claudeDraft}
              </p>
            )}
          </div>
        )}
        {writing ? (
          <div
            role="textbox"
            tabIndex={0}
            aria-label={t("support.reply.message")}
            aria-readonly="true"
            aria-busy="true"
            aria-multiline="true"
            className="max-h-[50vh] min-h-[112px] overflow-y-auto px-3 py-2.5 text-md whitespace-pre-wrap text-ink outline-none [overflow-wrap:anywhere]"
          >
            {streaming}
            <span
              aria-hidden="true"
              className="stream-caret ml-0.5 inline-block h-4 w-[2px] translate-y-[3px] rounded-[1px] bg-ink"
            />
          </div>
        ) : (
          <textarea
            ref={bodyRef}
            aria-label={t("support.reply.message")}
            value={body}
            onChange={(e) => edit(e.target.value)}
            rows={4}
            className="max-h-[50vh] min-h-[112px] resize-none bg-transparent px-3 py-2.5 text-md text-ink outline-none placeholder:text-ink-faint"
            placeholder={t("support.reply.placeholder", { name })}
          />
        )}
        {ask && (
          <div
            role="group"
            aria-label={t("support.reply.replaceAsk")}
            className="flex flex-wrap items-center gap-2 border-t border-rule px-3 py-2 text-sm"
          >
            <span className="text-ink">{t("support.reply.replaceAsk")}</span>
            <button
              type="button"
              className={secondaryButton}
              onClick={() => (ask === "prepared" ? usePrepared("replace") : regenerate("replace"))}
            >
              {t("support.reply.replace")}
            </button>
            <button
              type="button"
              className={secondaryButton}
              onClick={() => (ask === "prepared" ? usePrepared("below") : regenerate("below"))}
            >
              {t("support.reply.addBelow")}
            </button>
            <button type="button" className={quietButton} onClick={() => setAsk(null)}>
              {t("support.reply.cancel")}
            </button>
          </div>
        )}
        {sendFailed(me, conv.code) && (
          <p role="alert" className="border-t border-rule px-3 py-2 text-sm text-critical">
            {t("support.reply.notSentBack")}
          </p>
        )}
        {claude.state.status === "failed" && (
          <p
            role="alert"
            className="flex flex-wrap items-center gap-2 border-t border-rule px-3 py-2 text-sm text-ink"
          >
            {t("support.reply.draftFailed")}
            <button type="button" className={secondaryButton} onClick={() => choose("regenerate")}>
              {t("support.reply.tryAgain")}
            </button>
          </p>
        )}
        {placedFrom !== null && !writing && (
          <p role="status" className="border-t border-rule px-3 py-1.5 text-xs text-ink-muted">
            {edited ? t("support.reply.editedFrom") : draftNote}
          </p>
        )}
        <div className="flex min-h-12 flex-wrap items-center gap-1 border-t border-rule px-2 py-2">
          {writing ? (
            <button
              type="button"
              className={secondaryButton}
              onClick={claude.stop}
              title={`${t("support.reply.stop")} (${shortcutLabel(["mod", "."])})`}
            >
              <StopGlyph />
              {t("support.reply.stop")}
            </button>
          ) : (
            <button
              type="button"
              className={quietButton}
              onClick={() => choose("regenerate")}
              title={`${t("support.reply.claudeDraft")} (${shortcutLabel(["mod", "J"])})`}
            >
              <ClaudeMark />
              {t("support.reply.claudeDraft")}
            </button>
          )}
          <span className="ml-auto flex items-center gap-1">
            {saved && body !== "" && (
              <span role="status" className="px-1 text-xs text-ink-faint">
                {t("support.reply.saved")}
              </span>
            )}
            {body !== "" && !writing && (
              <button
                type="button"
                className={quietButton}
                onClick={() => {
                  edit("");
                  setPlacedFrom(null);
                }}
              >
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
