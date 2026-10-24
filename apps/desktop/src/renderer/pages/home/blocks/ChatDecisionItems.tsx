import { Link, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import {
  useAnswerChatClaudeQuestionNow,
  useDismissChatQuestionNow,
  usePeople,
  useReachChatMessage,
} from "../../../data/queries";
import type { ChatClaudeQuestion, ChatQuestion, Person } from "../../../data/types";
import { relativeTime } from "../../../notifications/time";
import { Avatar } from "../../../tasks-ui/PersonChip";
import { useToast } from "../../../tasks-ui/Toast";
import { ghostButton, smallSecondary } from "../../task/parts";
import { requestReplyFocus } from "../../chat/drafts";
import { deferAnswer } from "../pendingAnswers";
import { ClaudeAnswers, QuestionText } from "./ClaudeDecisionItem";

// Le domande della Chat in «Decide», nella forma delle richieste di
// decisione: chi chiede con l'ora, la domanda, il canale come oggetto
// citato, le azioni sul posto. Una domanda di una persona non si risponde
// da qui — la risposta è un messaggio, e il suo posto è il thread: «Reply»
// apre il thread con la casella a fuoco, «Ignore» la toglie per chi guarda.
// Quella di @Claude a chi l'ha chiamato (R-G4) sì: è la stessa scheda del
// thread, e rispondere in un posto chiude l'altro.

const rowClass = "flex flex-col gap-2 border-b border-rule py-3 pr-3 pl-4";
const objectClass =
  "flex min-w-0 items-baseline gap-2 self-start rounded-sm text-left text-sm text-ink-muted hover:text-ink";

/** Chi chiede e quando, come in una richiesta di decisione. */
function Asker({
  person,
  heading,
  at,
}: {
  person: Person | undefined;
  heading: string;
  at: string;
}) {
  const { t, i18n } = useTranslation();
  return (
    <div className="flex items-center gap-2 text-sm text-ink-muted">
      <Avatar person={person} />
      <span className="min-w-0 truncate">{heading}</span>
      <span aria-hidden="true" className="text-ink-faint">
        ·
      </span>
      <span className="num shrink-0 text-ink-faint">{relativeTime(at, t, i18n.language)}</span>
    </div>
  );
}

/**
 * Il canale come oggetto citato: il codice del progetto in cifre tabellari e
 * il nome («AUD · general»), un generale col suo «#», un DM coi nomi.
 */
function ChannelName({ label }: { label: string }) {
  const [code, ...rest] = label.split(" · ");
  if (rest.length === 0) return <span className="min-w-0 truncate">{label}</span>;
  return (
    <>
      <span className="num shrink-0 text-xs font-semibold tracking-[0.02em] text-ink">{code}</span>
      <span className="min-w-0 truncate">{rest.join(" · ")}</span>
    </>
  );
}

const threadSearch = (q: { rootId: string; messageId: string }) => ({
  thread: q.rootId,
  message: q.messageId,
});

/**
 * Apre il thread sul messaggio, dopo averlo riletto: eliminato o non più
 * leggibile, un avviso e si resta qui (nessun testo, R-G5). Con `focus` il
 * fuoco va nella casella del thread («Reply»).
 */
function useGoToThread(q: { channelId: string; rootId: string; messageId: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const reach = useReachChatMessage();
  return async (focus: boolean) => {
    if (!(await reach(q.messageId))) {
      toast.error(t("home.decide.chat.unavailable"));
      return;
    }
    if (focus) requestReplyFocus(q.rootId);
    void navigate({
      to: "/chat/$channelId",
      params: { channelId: q.channelId },
      search: threadSearch(q),
    } as never);
  };
}

/** Il canale come link al thread: il clic semplice rilegge prima (`useGoToThread`). */
function ThreadLink({
  q,
  go,
}: {
  q: { channelId: string; rootId: string; messageId: string; channelLabel: string };
  go: (focus: boolean) => Promise<void>;
}) {
  const { t } = useTranslation();
  return (
    <Link
      to="/chat/$channelId"
      params={{ channelId: q.channelId } as never}
      search={threadSearch(q) as never}
      aria-label={t("home.decide.chat.openThread", { channel: q.channelLabel })}
      className={objectClass}
      onClick={(e) => {
        // Un clic con modificatore resta del browser.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        void go(false);
      }}
    >
      <ChannelName label={q.channelLabel} />
    </Link>
  );
}

/** Una domanda di una persona rivolta a chi guarda: «Reply» e «Ignore». */
export function ChatQuestionItem({ question: q }: { question: ChatQuestion }) {
  const { t } = useTranslation();
  const toast = useToast();
  const go = useGoToThread(q);
  const dismissNow = useDismissChatQuestionNow();
  const { data: people } = usePeople();
  const asker = people?.find((p) => p.id === q.askedById);
  const name = asker?.name ?? t("taskUi.stall.someone");

  const ignore = () => {
    const cancel = deferAnswer(
      q.id,
      () => dismissNow(q.messageId),
      (error) => {
        // Chiusa nel frattempo (risposta durante l'«Undo», messaggio eliminato):
        // la domanda non c'è più, che è ciò che si voleva. Nessun avviso.
        if ((error as Error | null)?.message === "not_found") return;
        toast.error(t("home.decide.chat.ignoreFailed"));
      },
    );
    toast.show(t("home.decide.chat.ignored"), {
      action: { label: t("home.decide.undo"), run: cancel },
    });
  };

  return (
    <div data-chat-question={q.id} className={rowClass}>
      <Asker person={asker} heading={t("home.decide.chat.asksYou", { name })} at={q.createdAt} />
      <QuestionText text={q.text} />
      <ThreadLink q={q} go={go} />
      <div
        role="group"
        aria-label={t("home.decide.chat.actions", { name, channel: q.channelLabel })}
        className="flex flex-wrap gap-2"
      >
        <button type="button" className={smallSecondary} onClick={() => void go(true)}>
          {t("home.decide.chat.reply")}
        </button>
        <button type="button" className={ghostButton} onClick={ignore}>
          {t("home.decide.chat.ignore")}
        </button>
      </div>
    </div>
  );
}

/** La domanda di @Claude a chi l'ha chiamato in un thread (R-G4), con le opzioni sul posto. */
export function ChatClaudeQuestionItem({ question: q }: { question: ChatClaudeQuestion }) {
  const { t } = useTranslation();
  const toast = useToast();
  const answerNow = useAnswerChatClaudeQuestionNow();
  const go = useGoToThread(q);
  const { data: people } = usePeople();
  const claude = people?.find((p) => p.isClaude);
  const channel = q.channelLabel;

  const answer = (value: { optionIndex: number | null; text: string | null }) => {
    const cancel = deferAnswer(
      q.id,
      () => answerNow(q.messageId, q.questionId, value),
      (error) => {
        const byId = (error as { byId?: string | null } | null)?.byId;
        if ((error as Error | null)?.message === "already_answered") {
          const who = people?.find((p) => p.id === byId)?.name ?? t("taskUi.stall.someone");
          toast.show(t("home.decide.claude.alreadyAnswered", { name: who }));
        } else toast.error(t("home.decide.chat.answerFailed", { channel }));
      },
    );
    toast.show(t("home.decide.chat.answered", { channel }), {
      action: { label: t("home.decide.undo"), run: cancel },
    });
  };

  return (
    <div data-chat-claude-question={q.id} className={rowClass}>
      <Asker person={claude} heading={t("home.decide.claude.asks")} at={q.createdAt} />
      <QuestionText text={q.text} />
      <ThreadLink q={q} go={go} />
      <ClaudeAnswers question={q.text} options={q.options} onAnswer={answer} />
    </div>
  );
}
