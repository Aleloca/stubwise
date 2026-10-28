import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useEmailDraftFor,
  useFollowConversation,
  useInvalidateSupport,
  useLoadMailDraft,
  useSaveMailDraft,
  useSessionPersonId,
  useSimulateCustomerLeaves,
  useSimulateCustomerMessage,
  useSimulateTriageDone,
  useSupportConversation,
  type SupportConversationView,
} from "../../data/queries";
import { now } from "../../data/dates";
import { useMediaQuery } from "../../layout/useMediaQuery";
import { MenuGroup, MenuNote, itemClass } from "../../tasks-ui/Menu";
import { PageError, PageSkeleton } from "../../tasks-ui/PageStates";
import { useToast } from "../../tasks-ui/Toast";
import { quietButton, secondaryButton } from "../claude/conversation/parts";
import { openGoogleAccount } from "../drive/GoogleAccountCard";
import { requestCompose } from "../mail/composeRequest";
import { MoreGlyph } from "../mail/glyphs";
import { dayLabel } from "../mail/format";
import { ago } from "../releases/format";
import { MenuButton } from "../tasks/controls";
import { typing } from "../tasks/useTaskKeys";
import { CustomerPreview } from "./CustomerPreview";
import { customerName, firstName, PREVIEW_DOCKED_QUERY, stateWord } from "./format";
import { Messages } from "./Messages";
import { ReplyComposer } from "./ReplyComposer";
import { pendingFor, retryReply, takeBackReply, usePendingReplies } from "./replyStore";
import { RequestBlock } from "./RequestBlock";

// Il dettaglio di una conversazione (shape support.md §3, §5, §6): in testa
// cosa vuole il cliente (il blocco della richiesta), sotto la conversazione
// che lo prova, in fondo la casella — solo per chi ha `support.reply` e mai
// durante il triage (R-K15). «Anteprima del cliente» (P) mostra ciò che vede
// lui; «Scrivigli anche per email» apre la Posta con una bozza nello slot
// della conversazione (R-K14), che parte solo da «Invia» di una persona.

/** Dopo quanti minuti senza il cliente si dice che non è più sul sito [A 12]. */
const AWAY_MINUTES = 30;

/** «Scrivigli anche per email»: la bozza nella Posta (la sua, se c'era già), poi la Posta. */
function useWriteByEmail() {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const emailDraft = useEmailDraftFor();
  const load = useLoadMailDraft();
  const save = useSaveMailDraft();
  return async (code: string) => {
    try {
      const { draft } = await emailDraft.mutateAsync(code);
      const slot = draft.slot!;
      // Una bozza già scritta per questo cliente non si sovrascrive.
      const saved = await load(null, "new", slot);
      if (!saved.to.length && !saved.subject.trim() && !saved.body.trim()) {
        await save.mutateAsync({
          threadId: null,
          mode: "new",
          replyToMessageId: null,
          to: draft.to,
          cc: [],
          subject: draft.subject,
          body: draft.body,
          attachments: [],
          slot,
        });
      }
      requestCompose({ threadId: null, mode: "new", focus: "body", slot });
      void navigate({ to: "/mail", search: { compose: slot } as never });
    } catch {
      toast.error(t("support.reply.emailError"));
    }
  };
}

/** Il cliente non è più sul sito: da quando, se è passato abbastanza. */
function awaySince(conv: SupportConversationView, nowIso: string): string | null {
  if (conv.channel !== "widget") return null;
  const lastCustomer = [...conv.messages].reverse().find((m) => m.from === "customer")?.at;
  const since = conv.leftAt ?? lastCustomer;
  if (!since) return null;
  return (Date.parse(nowIso) - Date.parse(since)) / 60_000 >= AWAY_MINUTES ? since : null;
}

function Header({
  conv,
  previewOpen,
  togglePreview,
  previewButton,
  writeByEmail,
}: {
  conv: SupportConversationView;
  previewOpen: boolean;
  togglePreview: () => void;
  previewButton: React.RefObject<HTMLButtonElement | null>;
  writeByEmail: () => void;
}) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const follow = useFollowConversation();
  const message = useSimulateCustomerMessage();
  const leaves = useSimulateCustomerLeaves();
  const triage = useSimulateTriageDone();
  const started = conv.messages[0]?.at;
  const failed = () => toast.error(t("support.detail.actionFailed"));
  const copyLink = () => {
    const url = `${window.location.origin}${window.location.pathname}#/p/${conv.projectCode}/support/${conv.code}`;
    void navigator.clipboard?.writeText(url).then(
      () => toast.show(t("support.detail.linkCopied")),
      () => toast.error(t("support.detail.linkError")),
    );
  };
  return (
    <header className="flex flex-wrap items-start gap-x-4 gap-y-2">
      <div className="flex min-w-0 flex-1 basis-[320px] flex-col gap-1">
        <h2 className="flex flex-wrap items-baseline gap-x-2 text-xl leading-[26px] font-semibold text-ink [overflow-wrap:anywhere]">
          <span className="num shrink-0">{conv.code}</span>
          <span className="min-w-0">{customerName(conv, t)}</span>
        </h2>
        {/* Ogni voce resta intera col suo «·»: una riga non comincia mai col punto. */}
        <p className="text-sm text-ink-muted">
          {[
            conv.channel === "widget"
              ? conv.widgetName
                ? t("support.detail.widgetChannel", { name: conv.widgetName })
                : t("support.channel.widget")
              : t("support.channel.mcp"),
            conv.customer.email,
            started
              ? t("support.detail.started", { date: dayLabel(started, i18n.language) })
              : null,
          ]
            .filter(Boolean)
            .map((part) => (
              <span key={part} className="whitespace-nowrap">
                {part}&nbsp;·{" "}
              </span>
            ))}
          <span className="font-medium whitespace-nowrap text-ink">{stateWord(conv.state, t)}</span>
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          ref={previewButton}
          type="button"
          aria-pressed={previewOpen}
          onClick={togglePreview}
          title={`${t("support.detail.preview")} (P)`}
          className={`${secondaryButton} aria-pressed:bg-ink/10`}
        >
          {t("support.detail.preview")}
        </button>
        <button
          type="button"
          aria-pressed={conv.following}
          disabled={follow.isPending}
          onClick={() =>
            follow.mutate({ code: conv.code, on: !conv.following }, { onError: failed })
          }
          className={quietButton}
        >
          {conv.following ? t("support.detail.following") : t("support.detail.follow")}
        </button>
        <MenuButton
          menuLabel={t("support.detail.more")}
          ariaLabel={t("support.detail.more")}
          align="right"
          className={`${quietButton} aria-expanded:bg-ink/10`}
          label={<MoreGlyph />}
        >
          {(close) => (
            <>
              <MenuGroup>
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className={itemClass}
                  onClick={() => (close(), copyLink())}
                >
                  {t("support.detail.copyLink")}
                </button>
                {conv.emailBlocked === null && (
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    className={itemClass}
                    onClick={() => (close(), writeByEmail())}
                  >
                    {t("support.detail.writeEmail")}
                  </button>
                )}
                {(conv.emailBlocked === "no_email" || conv.emailBlocked === "no_mailbox") && (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      tabIndex={-1}
                      aria-disabled="true"
                      className={`${itemClass} text-ink-faint hover:bg-transparent`}
                    >
                      {t("support.detail.writeEmail")}
                    </button>
                    <MenuNote>
                      {conv.emailBlocked === "no_email"
                        ? t("support.reply.noEmail")
                        : t("support.reply.noMailbox")}
                    </MenuNote>
                  </>
                )}
              </MenuGroup>
              <MenuGroup label={t("support.detail.prototype")}>
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className={itemClass}
                  onClick={() => {
                    close();
                    message.mutate(
                      { code: conv.code, body: t("support.detail.simulatedText") },
                      { onError: failed },
                    );
                  }}
                >
                  {t("support.detail.simulateMessage")}
                </button>
                {conv.state === "triage" && (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      tabIndex={-1}
                      className={itemClass}
                      onClick={() => (close(), leaves.mutate(conv.code, { onError: failed }))}
                    >
                      {t("support.detail.simulateLeaves")}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      tabIndex={-1}
                      className={itemClass}
                      onClick={() => (close(), triage.mutate(conv.code, { onError: failed }))}
                    >
                      {t("support.detail.simulateTriage")}
                    </button>
                  </>
                )}
              </MenuGroup>
            </>
          )}
        </MenuButton>
      </div>
    </header>
  );
}

export function ConversationDetail({
  code,
  back,
  notFound,
}: {
  code: string;
  /** Nella finestra stretta: «← Conversations» in testa. */
  back?: React.ReactNode;
  notFound: React.ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const me = useSessionPersonId();
  const q = useSupportConversation(code);
  const docked = useMediaQuery(PREVIEW_DOCKED_QUERY);
  const [preview, setPreview] = useState(false);
  const previewButton = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const lastRef = useRef<HTMLLIElement>(null);
  const writeByEmail = useWriteByEmail();
  const invalidate = useInvalidateSupport();
  usePendingReplies();
  const conv = q.data;

  const closePreview = () => {
    setPreview(false);
    requestAnimationFrame(() => previewButton.current?.focus());
  };

  // Tastiera (shape §6, [A 20]): R la casella, P l'anteprima, Esc chiude
  // l'anteprima e poi lascia la casella.
  const keys = useRef({ conv, preview });
  keys.current = { conv, preview };
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        if (keys.current.preview) {
          e.preventDefault();
          closePreview();
        } else if (document.activeElement === bodyRef.current) {
          bodyRef.current?.blur();
        }
        return;
      }
      if (typing(e.target) || document.querySelector('[role="dialog"], [role="menu"]')) return;
      const key = e.key.toLowerCase();
      if (key === "r" && bodyRef.current) {
        e.preventDefault();
        bodyRef.current.focus();
      } else if (key === "p" && keys.current.conv) {
        e.preventDefault();
        if (keys.current.preview) closePreview();
        else setPreview(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (q.isError) {
    return <PageError message={t("support.detail.error")} onRetry={() => void q.refetch()} />;
  }
  if (q.isPending) {
    return (
      <div className="px-8 pt-6">
        <PageSkeleton rows={6} />
      </div>
    );
  }
  if (!conv) return <>{notFound}</>;

  const name = firstName(conv, t);
  const pending = pendingFor(me, conv.code);
  const away = awaySince(conv, now());
  const previewPanel = preview && (
    <CustomerPreview
      key={conv.code}
      code={conv.code}
      name={name}
      usName={conv.widgetName ?? conv.projectCode}
      docked={docked}
      onClose={closePreview}
    />
  );
  if (preview && !docked) return <div className="flex min-h-0 flex-1">{previewPanel}</div>;

  const footer =
    conv.channel === "mcp" ? (
      <p className="text-xs text-ink-muted">{t("support.reply.nextTime")}</p>
    ) : (
      <div className="flex flex-col gap-1 text-xs text-ink-muted">
        {away && <p>{t("support.reply.lastSeen", { name, time: ago(away, t, i18n.language) })}</p>}
        {conv.emailBlocked === null && (
          <p>
            <button
              type="button"
              onClick={() => void writeByEmail(conv.code)}
              className="rounded-sm font-semibold text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink"
            >
              {t("support.detail.writeEmail")}
            </button>
          </p>
        )}
        {conv.emailBlocked === "no_mailbox" && (
          <p>
            {t("support.reply.noMailbox")} ·{" "}
            <button
              type="button"
              onClick={() => openGoogleAccount()}
              className="rounded-sm font-semibold text-ink underline decoration-ink/30 underline-offset-2"
            >
              {t("support.reply.connect")}
            </button>
          </p>
        )}
      </div>
    );

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <article
        aria-label={`${conv.code} ${customerName(conv, t)}`}
        data-support-detail={conv.code}
        className="min-h-0 min-w-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex w-full max-w-[760px] flex-col gap-6 px-8 pt-6 pb-10">
          {back}
          <Header
            conv={conv}
            previewOpen={preview}
            togglePreview={() => (preview ? closePreview() : setPreview(true))}
            previewButton={previewButton}
            writeByEmail={() => void writeByEmail(conv.code)}
          />
          <RequestBlock conv={conv} />
          <Messages
            conv={conv}
            pending={pending}
            lastSentRef={lastRef}
            onRetry={() =>
              retryReply(me, conv.code, () => {
                void invalidate();
                requestAnimationFrame(() => lastRef.current?.focus());
              })
            }
            onEdit={() => {
              takeBackReply(me, conv.code);
              requestAnimationFrame(() => bodyRef.current?.focus());
            }}
          />
          {!conv.canReply ? (
            <p className="border-t border-rule pt-4 text-xs text-ink-muted">
              {t("support.reply.readOnly")}
            </p>
          ) : conv.replyClosed === "triage" ? (
            <p className="border-t border-rule pt-4 text-xs text-ink-muted">
              {t("support.reply.triage")}
            </p>
          ) : (
            <ReplyComposer
              key={`${me}:${conv.code}`}
              conv={conv}
              bodyRef={bodyRef}
              footer={footer}
              onSent={() => requestAnimationFrame(() => lastRef.current?.focus())}
            />
          )}
        </div>
      </article>
      {previewPanel}
    </div>
  );
}
