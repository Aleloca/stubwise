import { Fragment, useCallback, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  useAnswerChatClaudeQuestion,
  useCancelChatProposal,
  useCompleteEditedChatProposal,
  useConfirmChatProposal,
  useDeleteChatMessage,
  useEditChatProposal,
  usePeople,
  useRetryClaudeReply,
  useStopClaudeReply,
} from "../../data/queries";
import type { ChatMessageView, ConversationEvent } from "../../data/types";
import { Markdown } from "../../tasks-ui/Markdown";
import { itemClass, MenuGroup } from "../../tasks-ui/Menu";
import { useToast } from "../../tasks-ui/Toast";
import { ActionRows } from "../claude/conversation/ActionRows";
import { HiddenCode, refKey, useCitationIndex, UsedLine } from "../claude/conversation/citations";
import { CODE_IN_TEXT } from "../claude/conversation/flow";
import { quietButton } from "../claude/conversation/parts";
import { ProposalCardView, routeOfCode } from "../claude/conversation/ProposalCard";
import { QuestionCardView } from "../claude/conversation/QuestionCard";
import { MenuButton } from "../tasks/controls";
import { hm } from "./flow";
import { ChatAvatar, useMessageDecorator } from "./MessageItem";

// Una risposta di @Claude nel thread: la resa della conversazione nel suo
// formato da pannello. Avatar CL con l'anello tratteggiato (pulsa mentre
// scrive), «Claude · called by Giulia Ferri · 10:42» — chi ha chiamato
// sempre in parole —, righe d'azione in un gruppo chiuso, il testo che
// cresce, le citazioni, le schede proposta e domanda. Fermare, rifare,
// eliminare, confermare e rispondere sono solo di chi ha chiamato (il
// livello dati lo controlla comunque). Per chi legge i codici che non vede
// sono tenui e senza nome (R-E9): il livello dati ha già tolto i nomi.

type Ev<K extends ConversationEvent["type"]> = Extract<ConversationEvent, { type: K }>;

/** Le righe d'azione consecutive diventano un gruppo; il resto resta com'è. */
type Block =
  | { kind: "actions"; actions: Ev<"action">[] }
  | { kind: "proposal"; event: Ev<"proposal"> }
  | { kind: "question"; event: Ev<"question"> };

function blocksOf(events: readonly ConversationEvent[]): Block[] {
  const out: Block[] = [];
  for (const e of events) {
    if (e.type === "action") {
      const last = out.at(-1);
      if (last?.kind === "actions") last.actions.push(e);
      else out.push({ kind: "actions", actions: [e] });
    } else if (e.type === "proposal") out.push({ kind: "proposal", event: e });
    else if (e.type === "question") out.push({ kind: "question", event: e });
  }
  return out;
}

const MoreGlyph = () => (
  <svg viewBox="0 0 16 16" width={14} height={14} aria-hidden="true" fill="currentColor">
    <circle cx="3.5" cy="8" r="1.2" />
    <circle cx="8" cy="8" r="1.2" />
    <circle cx="12.5" cy="8" r="1.2" />
  </svg>
);

export function ClaudeReply({
  message: m,
  viewerId,
  canWrite,
  mentionNames,
  onCopyLink,
}: {
  message: ChatMessageView;
  viewerId: string;
  /** Membro di un canale non archiviato. */
  canWrite: boolean;
  mentionNames: readonly string[];
  onCopyLink: () => void;
}) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const people = usePeople().data;
  const claude = people?.find((p) => p.isClaude);
  const callerName = people?.find((p) => p.id === m.calledById)?.name ?? "";
  const index = useCitationIndex();
  const stop = useStopClaudeReply();
  const retry = useRetryClaudeReply();
  const remove = useDeleteChatMessage();
  const answer = useAnswerChatClaudeQuestion();
  const confirm = useConfirmChatProposal();
  const cancel = useCancelChatProposal();
  const edit = useEditChatProposal();
  const complete = useCompleteEditedChatProposal();
  const [confirming, setConfirming] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);

  const mine = m.calledById === viewerId;
  const run = m.claudeRun;
  const state = run?.state ?? "done";
  const live = state === "working" || state === "waiting";
  const deleted = m.deletedAt !== null;

  // I codici che chi guarda non vede: quelli citati e quelli delle righe e delle schede.
  const hidden = useMemo(() => {
    const out = new Set(m.hiddenCodes ?? []);
    for (const ref of m.citations) {
      const view = index.byRef.get(refKey(ref));
      if (view && !view.visible && view.code) out.add(view.code);
    }
    return out;
  }, [m.hiddenCodes, m.citations, index]);
  const decorate = useMessageDecorator(mentionNames, hidden);
  /** Riassunti e domande: codice + nome se lo vede, tenue se no. */
  const linked = useCallback((text: string) => <>{decorate(text, "s")}</>, [decorate]);
  /** Le righe d'azione sono bottoni: niente link dentro, solo il codice tenue se non lo vede. */
  const plain = useCallback(
    (text: string): ReactNode => {
      const re = new RegExp(CODE_IN_TEXT.source, "g");
      const out: ReactNode[] = [];
      let last = 0;
      for (let match = re.exec(text); match; match = re.exec(text)) {
        if (!hidden.has(match[0])) continue;
        out.push(<Fragment key={`t${last}`}>{text.slice(last, match.index)}</Fragment>);
        out.push(<HiddenCode key={`c${match.index}`} code={match[0]} />);
        last = match.index + match[0].length;
      }
      out.push(<Fragment key="end">{text.slice(last)}</Fragment>);
      return out;
    },
    [hidden],
  );
  const renderCode = useCallback(
    (code: string) =>
      hidden.has(code) ? (
        <HiddenCode code={code} />
      ) : (
        <a
          href={routeOfCode(code)}
          className="num font-semibold text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink"
        >
          {code}
        </a>
      ),
    [hidden],
  );

  const inText = new Set(m.text.match(new RegExp(CODE_IN_TEXT.source, "g")) ?? []);
  // «Used: …»: ciò che Claude ha letto e il testo non nomina già (come nella conversazione).
  const used = m.citations.filter((ref) => {
    const v = index.byRef.get(refKey(ref));
    return v !== undefined && v.visible && !(v.code && inText.has(v.code)) && v.kind !== "person";
  });
  const actions = (m.claudeEvents ?? []).filter((e): e is Ev<"action"> => e.type === "action");
  const blocks = blocksOf(m.claudeEvents ?? []);
  const empty = m.text === "" && blocks.length === 0;

  const time = (
    <time className="num" dateTime={m.createdAt}>
      {hm(m.createdAt, i18n.language)}
    </time>
  );

  return (
    <article
      id={`message-${m.id}`}
      data-message={m.id}
      data-claude-reply={state}
      aria-label={t("chat.claude.calledBy", { name: callerName })}
      className="group/message relative mt-2 flex min-w-0 gap-2.5 rounded-md px-2 pt-1.5 pb-1 transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/4 focus-within:bg-ink/4"
    >
      <div className="flex w-6 shrink-0 justify-center">
        {!deleted && (
          <span className={state === "working" ? "rail-pulse" : undefined}>
            <ChatAvatar person={claude} size={24} />
          </span>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {deleted ? (
          <p className="py-0.5 text-sm text-ink-faint" data-deleted>
            {t("chat.message.deleted")}
          </p>
        ) : (
          <>
            <p className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-sm">
              <span className="font-semibold text-ink">{claude?.name ?? "Claude"}</span>
              <span aria-hidden="true" className="text-ink-faint">
                ·
              </span>
              <span className="min-w-0 text-ink-muted" data-called-by>
                {t("chat.claude.calledBy", { name: callerName })}
              </span>
              <span aria-hidden="true" className="text-ink-faint">
                ·
              </span>
              <span className="text-xs text-ink-muted">{time}</span>
              {state === "working" && empty && (
                <span className="text-xs text-ink-muted">· {t("chat.claude.thinking")}</span>
              )}
              {mine && live && (
                <button
                  type="button"
                  className="ml-auto rounded-md px-1.5 text-sm font-medium text-ink-muted underline decoration-ink/30 underline-offset-2 hover:text-ink hover:decoration-ink disabled:opacity-60"
                  disabled={stop.isPending}
                  onClick={() =>
                    stop.mutate(m.id, { onError: () => toast.error(t("chat.claude.stopFailed")) })
                  }
                >
                  {t("chat.claude.stop")}
                </button>
              )}
            </p>
            {actions.length > 0 && (
              // Un solo gruppo, chiuso: anche le righe di una ripresa dopo la domanda.
              <ActionRows actions={actions} compact renderText={plain} />
            )}
            {m.text && (
              <div className="min-w-0">
                <Markdown
                  source={m.text}
                  decorate={decorate}
                  codeLabel={t("claude.conversation.codeBlock")}
                  tableLabel={t("claude.conversation.table")}
                />
              </div>
            )}
            {used.length > 0 && <UsedLine refs={used} />}
            {blocks.map((b) => {
              if (b.kind === "question") {
                const e = b.event;
                if (e.answer === null && !live) {
                  return (
                    <p key={e.id} className="text-sm text-ink-muted">
                      <span className="text-ink">{linked(e.text)}</span>{" "}
                      {t("chat.claude.questionClosed")}
                    </p>
                  );
                }
                return (
                  <QuestionCardView
                    key={e.id}
                    event={e}
                    canAnswer={mine && state === "waiting" && canWrite}
                    pending={answer.isPending}
                    onAnswer={(payload) =>
                      answer.mutateAsync({
                        messageId: m.id,
                        questionId: e.questionId,
                        answer: payload,
                      })
                    }
                    title={
                      mine ? t("chat.claude.asksYou") : t("chat.claude.asks", { name: callerName })
                    }
                    note={
                      mine
                        ? t("chat.claude.cantAct")
                        : t("chat.claude.waitingFor", { name: callerName })
                    }
                    renderText={linked}
                  />
                );
              }
              if (b.kind === "proposal") {
                const e = b.event;
                const target = { messageId: m.id, proposalId: e.proposalId };
                return (
                  <ProposalCardView
                    key={e.id}
                    event={e}
                    viewerId={viewerId}
                    canAct={canWrite}
                    cantActNote={t("chat.claude.cantAct")}
                    renderText={linked}
                    renderCode={renderCode}
                    ops={{
                      confirm: (actionIndexes) =>
                        confirm.mutateAsync({
                          ...target,
                          ...(actionIndexes ? { actionIndexes } : {}),
                        }),
                      cancel: () => cancel.mutateAsync(target),
                      edit: () => edit.mutateAsync(target),
                      complete: (code) => complete.mutateAsync({ ...target, resultCodes: [code] }),
                      busy:
                        confirm.isPending ||
                        cancel.isPending ||
                        edit.isPending ||
                        complete.isPending,
                    }}
                  />
                );
              }
              return null;
            })}
            {state === "stopped" && (
              <p className="text-sm text-ink-muted" data-claude-stopped>
                {t("chat.claude.stopped", { name: callerName })}
              </p>
            )}
            {state === "failed" && (
              <p className="flex flex-wrap items-baseline gap-x-2 text-sm" role="status">
                <span className="text-critical">
                  {t("chat.claude.failed", {
                    reason: t(`chat.claude.reasons.${run?.errorCode ?? "other"}`),
                  })}
                </span>
                {mine && !run?.retried && canWrite && (
                  <button
                    type="button"
                    disabled={retry.isPending}
                    className="font-semibold text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink disabled:opacity-60"
                    onClick={() =>
                      retry.mutate(m.id, {
                        onError: () => toast.error(t("chat.claude.tryAgainFailed")),
                      })
                    }
                  >
                    {t("chat.claude.tryAgain")}
                  </button>
                )}
              </p>
            )}
            {confirming && (
              <p role="alert" className="flex flex-wrap items-center gap-2 pt-1 text-sm text-ink">
                {deleteFailed ? t("chat.message.deleteFailed") : t("chat.claude.deleteConfirm")}
                <button
                  type="button"
                  className="inline-flex h-7 items-center rounded-md bg-critical px-3 text-sm font-semibold text-ground transition-opacity duration-[var(--duration-fast)] ease-out hover:opacity-90"
                  onClick={() => {
                    setDeleteFailed(false);
                    remove.mutateAsync(m.id).then(
                      () => setConfirming(false),
                      () => setDeleteFailed(true),
                    );
                  }}
                >
                  {t("chat.actions.delete")}
                </button>
                <button
                  type="button"
                  className={`${quietButton} h-7`}
                  onClick={() => setConfirming(false)}
                >
                  {t("chat.message.cancel")}
                </button>
              </p>
            )}
          </>
        )}
      </div>
      {!deleted && (
        <div className="absolute -top-3 right-2 z-20 rounded-md border border-rule-strong bg-surface p-0.5 opacity-0 shadow-[0_4px_16px_-4px_oklch(0_0_0/0.35)] transition-opacity duration-[var(--duration-fast)] ease-out group-focus-within/message:opacity-100 group-hover/message:opacity-100 has-[[aria-expanded=true]]:opacity-100">
          <MenuButton
            menuLabel={t("chat.actions.menu")}
            ariaLabel={t("chat.actions.more")}
            title={t("chat.actions.more")}
            align="right"
            className="grid size-7 place-items-center rounded-md text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/8 hover:text-ink"
            label={<MoreGlyph />}
          >
            {(close) => (
              <MenuGroup>
                <button
                  type="button"
                  role="menuitem"
                  className={itemClass}
                  onClick={() => {
                    close();
                    onCopyLink();
                  }}
                >
                  {t("chat.actions.copyLink")}
                </button>
                {mine && canWrite && (
                  <button
                    type="button"
                    role="menuitem"
                    className={`${itemClass} text-critical`}
                    onClick={() => {
                      close();
                      setDeleteFailed(false);
                      setConfirming(true);
                    }}
                  >
                    {t("chat.claude.delete")}
                  </button>
                )}
              </MenuGroup>
            )}
          </MenuButton>
        </div>
      )}
    </article>
  );
}
