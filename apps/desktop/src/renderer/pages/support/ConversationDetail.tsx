import { Link } from "@tanstack/react-router";
import { Fragment, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isAppBuild } from "../../data/build";
import { featureIntegrated } from "../../data/integration";
import {
  useSessionPersonId,
  useSimulateCustomerLeaves,
  useSimulateCustomerMessage,
  useSimulateTriageDone,
  useSupportConversation,
  type SupportConversationView,
} from "../../data/queries";
import { useMediaQuery } from "../../layout/useMediaQuery";
import { MenuGroup, itemClass } from "../../tasks-ui/Menu";
import { PageError, PageSkeleton } from "../../tasks-ui/PageStates";
import { useToast } from "../../tasks-ui/Toast";
import { quietButton, secondaryButton } from "../claude/conversation/parts";
import { MoreGlyph } from "../mail/glyphs";
import { dayLabel } from "../mail/format";
import { MenuButton } from "../tasks/controls";
import { typing } from "../tasks/useTaskKeys";
import { CustomerPreview } from "./CustomerPreview";
import { customerName, firstName, PREVIEW_DOCKED_QUERY, stateWord } from "./format";
import { Messages } from "./Messages";
import { ReplyComposer } from "./ReplyComposer";
import { pendingFor, usePendingReplies } from "./replyStore";
import { RequestBlock } from "./RequestBlock";
import { WhoCanLink } from "../../components/WhoCanLink";

// Il dettaglio di una conversazione (shape support.md §3, §5, §6): in testa
// cosa vuole il cliente (il blocco della richiesta), sotto la conversazione
// che lo prova. Area 8, F3 (decisione del maintainer): al cliente del widget
// il team non scrive MAI — la conversazione si legge e basta; con un esito è
// chiusa, e un messaggio nuovo del cliente apre la successiva («Continued in
// …» / «Follow-up of …»). La casella c'è solo sul canale `mcp` (i
// collaboratori interni), per chi ha `support.manage`. «Anteprima del
// cliente» (P) mostra ciò che vede lui.

/** «Continued in ACQ-S9» / «Follow-up of ACQ-S3»: il legame fra una chiusa e la successiva. */
function ContinuationLine({
  conv,
  which,
}: {
  conv: SupportConversationView;
  which: "in" | "from";
}) {
  const { t } = useTranslation();
  const other = which === "in" ? conv.continuedIn : conv.continuedFrom;
  if (!other) return null;
  return (
    <p className="text-sm text-ink-muted" data-support-continuation={which}>
      {t(which === "in" ? "support.detail.continuedIn" : "support.detail.continuedFrom")}{" "}
      <Link
        to="/p/$code/support/$conversation"
        params={{ code: conv.projectCode, conversation: other.code }}
        className="num rounded-sm font-semibold text-ink underline-offset-4 hover:underline"
      >
        {other.code}
      </Link>
    </p>
  );
}

function Header({
  conv,
  previewOpen,
  togglePreview,
  previewButton,
}: {
  conv: SupportConversationView;
  previewOpen: boolean;
  togglePreview: () => void;
  previewButton: React.RefObject<HTMLButtonElement | null>;
}) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
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
            // API per i siti (S6): chi è il cliente lo dice un token firmato, o solo il sito.
            conv.channel === "widget" && featureIntegrated("support-identity")
              ? conv.identityVerified
                ? t("support.detail.verified")
                : t("support.detail.declared")
              : null,
            conv.customer.email,
            started
              ? t("support.detail.started", { date: dayLabel(started, i18n.language) })
              : null,
          ]
            .filter(Boolean)
            .map((part) => (
              // Lo spazio fuori dalla voce: è lì che la riga può andare a capo.
              <Fragment key={part}>
                <span className="whitespace-nowrap">{part}&nbsp;·</span>{" "}
              </Fragment>
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
              </MenuGroup>
              {/* Le simulazioni del cliente sono solo del prototipo (area 8, F3). */}
              {!isAppBuild() && (
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
              )}
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
  const { t } = useTranslation();
  const me = useSessionPersonId();
  const q = useSupportConversation(code);
  const docked = useMediaQuery(PREVIEW_DOCKED_QUERY);
  const [preview, setPreview] = useState(false);
  const previewButton = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const lastRef = useRef<HTMLLIElement>(null);
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

  const footer = <p className="text-xs text-ink-muted">{t("support.reply.nextTime")}</p>;

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
          />
          <ContinuationLine conv={conv} which="from" />
          <RequestBlock conv={conv} />
          <Messages conv={conv} pending={pending} lastSentRef={lastRef} />
          <ContinuationLine conv={conv} which="in" />
          {conv.channel !== "mcp" ? null : !conv.canReplyToCollaborator ? (
            <p className="border-t border-rule pt-4 text-xs text-ink-muted">
              {t("support.reply.readOnly")}{" "}
              <WhoCanLink action="manageSupport" projectCode={conv.projectCode} />
            </p>
          ) : (
            // Agganciata in fondo alla colonna (shape support §6, il momento
            // focale): la richiesta in alto, la casella si vede anche quando
            // la conversazione è lunga.
            <div
              data-reply-dock
              className="sticky bottom-0 z-10 -mx-8 -mb-10 bg-ground px-8 pt-1 pb-6"
            >
              <ReplyComposer
                key={`${me}:${conv.code}`}
                conv={conv}
                bodyRef={bodyRef}
                footer={footer}
                onSent={() => requestAnimationFrame(() => lastRef.current?.focus())}
              />
            </div>
          )}
        </div>
      </article>
      {previewPanel}
    </div>
  );
}
