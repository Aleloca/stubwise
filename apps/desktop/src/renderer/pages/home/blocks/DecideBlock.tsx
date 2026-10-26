import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useAnswerDecisionNow,
  useChatClaudeQuestions,
  useChatQuestions,
  useClaudeDecisions,
  useDecisionRequests,
  useMailProposalDecisions,
  usePeople,
  useProjects,
  useRequestsToConvert,
  useSessionPersonId,
  useTasks,
} from "../../../data/queries";
import type {
  ChatClaudeQuestion,
  ChatQuestion,
  ClaudeDecision,
  DecisionRequest,
  MailProposalView,
  Person,
  Project,
  ProjectRequest,
  Task,
} from "../../../data/types";
import { relativeTime } from "../../../notifications/time";
import { inputClass } from "../../../tasks-ui/Dialog";
import { Avatar } from "../../../tasks-ui/PersonChip";
import { useToast } from "../../../tasks-ui/Toast";
import { NewTaskDialog } from "../../task/NewTaskDialog";
import { ghostButton, smallPrimary, smallSecondary } from "../../task/parts";
import { deferAnswer, usePendingAnswers } from "../pendingAnswers";
import { BlockSection, Capped, queryState, useOpenTask } from "./BlockSection";
import { ChatClaudeQuestionItem, ChatQuestionItem } from "./ChatDecisionItems";
import { ClaudeDecisionItem } from "./ClaudeDecisionItem";
import { MailDecisionItem } from "./MailDecisionItem";

type Item =
  | { kind: "decision"; id: string; decision: DecisionRequest; task: Task | undefined }
  | { kind: "claude"; id: string; claude: ClaudeDecision }
  | { kind: "chat"; id: string; question: ChatQuestion }
  | { kind: "chatClaude"; id: string; question: ChatClaudeQuestion }
  | { kind: "mail"; id: string; view: MailProposalView }
  | { kind: "request"; id: string; request: ProjectRequest; project: Project | undefined };

/**
 * «Decide»: ciò che aspetta una mia decisione, risolvibile sul posto. Le
 * richieste di decisione rivolte a me (le opzioni come bottoni, più
 * «Other…» a testo libero) e le domande e i piani di Claude che aspettano
 * me (gli stessi della conversazione, nella stessa forma), dalla più
 * vecchia, insieme alle domande della Chat rivolte a me («Reply» apre il
 * thread, «Ignore» la toglie), a quelle di @Claude a chi l'ha chiamato e
 * alle proposte della posta che vedo (la scheda della Posta, area 6);
 * poi le richieste nuove nei progetti dove posso creare task, con
 * «Turn into task». Una risposta
 * chiude subito la voce (collassa in 200 ms) e parte dopo la finestra
 * dell'«Undo»; se non riesce, la voce torna e un messaggio lo dice.
 */
export function DecideBlock() {
  const { t } = useTranslation();
  const me = useSessionPersonId();
  const decisions = useDecisionRequests({ askedOfId: me, open: true });
  const claude = useClaudeDecisions();
  const chatQuestions = useChatQuestions();
  const chatClaude = useChatClaudeQuestions();
  const mail = useMailProposalDecisions();
  const tasks = useTasks();
  const requests = useRequestsToConvert();
  const projects = useProjects();
  const people = usePeople();
  const pending = usePendingAnswers();
  const [converting, setConverting] = useState<string | null>(null);
  const toast = useToast();
  const openTask = useOpenTask();

  // Persone e Claude insieme, dalla domanda più vecchia.
  const asked: { at: string; item: Item }[] = [
    ...(decisions.data ?? []).map((d) => ({
      at: d.createdAt,
      item: {
        kind: "decision",
        id: d.id,
        decision: d,
        task: tasks.data?.find((x) => x.id === d.taskId),
      } satisfies Item,
    })),
    ...(claude.data ?? []).map((c) => ({
      at: c.at,
      item: { kind: "claude", id: c.id, claude: c } satisfies Item,
    })),
    ...(chatQuestions.data ?? []).map((q) => ({
      at: q.createdAt,
      item: { kind: "chat", id: q.id, question: q } satisfies Item,
    })),
    ...(chatClaude.data ?? []).map((q) => ({
      at: q.createdAt,
      item: { kind: "chatClaude", id: q.id, question: q } satisfies Item,
    })),
    // Le proposte della posta che aspettano me, per data di nascita come le altre.
    ...(mail.data ?? []).map((v) => ({
      at: v.proposal.createdAt,
      item: { kind: "mail", id: v.proposal.id, view: v } satisfies Item,
    })),
  ];
  const items: Item[] = [
    ...asked.sort((a, b) => a.at.localeCompare(b.at)).map((a) => a.item),
    ...(requests.data ?? [])
      .filter((r) => r.status === "new")
      .map(
        (r): Item => ({
          kind: "request",
          id: r.id,
          request: r,
          project: projects.data?.find((p) => p.id === r.projectId),
        }),
      ),
  ];
  const visible = items.filter((i) => !pending.has(i.id));
  const state = queryState(
    [decisions, claude, chatQuestions, chatClaude, mail, tasks, requests, projects],
    {
      when: visible.length === 0,
      text: t("home.decide.empty"),
      body: t("home.decide.emptyBody"),
    },
  );
  const person = (id: string) => people.data?.find((p) => p.id === id);

  return (
    <BlockSection title={t("home.blocks.decide")} count={visible.length} state={state}>
      <Capped
        items={items}
        closing={(item) => pending.has(item.id)}
        render={(item) =>
          item.kind === "mail" ? (
            <Collapsible key={item.id} closed={pending.has(item.id)}>
              <MailDecisionItem view={item.view} />
            </Collapsible>
          ) : item.kind === "chat" ? (
            <Collapsible key={item.id} closed={pending.has(item.id)}>
              <ChatQuestionItem question={item.question} />
            </Collapsible>
          ) : item.kind === "chatClaude" ? (
            <Collapsible key={item.id} closed={pending.has(item.id)}>
              <ChatClaudeQuestionItem question={item.question} />
            </Collapsible>
          ) : item.kind === "claude" ? (
            <Collapsible key={item.id} closed={pending.has(item.id)}>
              <ClaudeDecisionItem decision={item.claude} onOpenTask={openTask} />
            </Collapsible>
          ) : item.kind === "decision" ? (
            <Collapsible key={item.id} closed={pending.has(item.id)}>
              <DecisionItem
                decision={item.decision}
                task={item.task}
                asker={person(item.decision.askedById)}
                onOpenTask={openTask}
              />
            </Collapsible>
          ) : (
            <Collapsible key={item.id} closed={false}>
              <RequestItem
                request={item.request}
                project={item.project}
                requester={person(item.request.requesterIds[0] ?? "")}
                onConvert={() => setConverting(item.request.id)}
              />
            </Collapsible>
          )
        }
      />
      {converting && (
        <NewTaskDialog
          fromRequestId={converting}
          onClose={() => setConverting(null)}
          onCreated={(task) => {
            setConverting(null);
            toast.show(t("home.decide.created", { code: task.code }));
            openTask(task.code);
          }}
        />
      )}
    </BlockSection>
  );
}

/**
 * Una voce che si chiude: l'altezza collassa (righe di griglia da 1fr a 0)
 * e svanisce, entro `--duration` (0 con movimento ridotto). Chiusa è fuori
 * dall'albero accessibile e dal fuoco.
 */
function Collapsible({ closed, children }: { closed: boolean; children: React.ReactNode }) {
  return (
    <li
      aria-hidden={closed || undefined}
      inert={closed}
      data-closed={closed || undefined}
      className={`grid transition-[grid-template-rows,opacity] duration-[var(--duration)] ease-[var(--ease)] ${closed ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100"}`}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </li>
  );
}

function DecisionItem({
  decision,
  task,
  asker,
  onOpenTask,
}: {
  decision: DecisionRequest;
  task: Task | undefined;
  asker: Person | undefined;
  onOpenTask: (code: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const answerNow = useAnswerDecisionNow();
  // Senza opzioni si risponde solo a parole: il campo è già aperto.
  const free = decision.options.length === 0;
  const [other, setOther] = useState(free);
  const [text, setText] = useState("");
  const textId = useId();
  const code = task?.code ?? "";

  const respond = (value: { optionIndex: number } | { text: string }) => {
    const cancel = deferAnswer(
      decision.id,
      () => answerNow(decision.id, value),
      () => toast.error(t("home.decide.answerFailed", { code })),
    );
    toast.show(t("home.decide.answered", { code }), {
      action: { label: t("home.decide.undo"), run: cancel },
    });
  };

  return (
    <div
      data-decision={decision.id}
      className="flex flex-col gap-2 border-b border-rule py-3 pr-3 pl-4"
    >
      <div className="flex items-center gap-2 text-sm text-ink-muted">
        <Avatar person={asker} />
        <span className="min-w-0 truncate">
          {t("home.decide.asks", { name: asker?.name ?? t("taskUi.stall.someone") })}
        </span>
        <span aria-hidden="true" className="text-ink-faint">
          ·
        </span>
        <span className="num shrink-0 text-ink-faint">
          {relativeTime(decision.createdAt, t, i18n.language)}
        </span>
      </div>
      <p
        title={decision.question}
        className="line-clamp-2 max-w-[72ch] text-lg font-medium text-ink [overflow-wrap:anywhere]"
      >
        {decision.question}
      </p>
      {task && (
        <button
          type="button"
          onClick={() => onOpenTask(task.code)}
          className="flex min-w-0 items-baseline gap-2 self-start rounded-sm text-left text-sm text-ink-muted hover:text-ink"
        >
          <span className="num shrink-0 text-xs font-semibold tracking-[0.02em] text-ink">
            {task.code}
          </span>
          <span className="min-w-0 truncate">{task.title}</span>
        </button>
      )}
      {other ? (
        <form
          className="flex max-w-[72ch] flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) respond({ text: text.trim() });
          }}
        >
          <label htmlFor={textId} className="sr-only">
            {t("home.decide.yourAnswer")}
          </label>
          <textarea
            id={textId}
            rows={2}
            autoFocus={!free}
            value={text}
            placeholder={t("home.decide.yourAnswer")}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && !free) {
                e.stopPropagation();
                setOther(false);
              }
            }}
            className={`${inputClass} resize-y`}
          />
          <div className="flex gap-2">
            <button type="submit" className={smallPrimary} disabled={!text.trim()}>
              {t("home.decide.send")}
            </button>
            {!free && (
              <button type="button" className={ghostButton} onClick={() => setOther(false)}>
                {t("home.decide.cancel")}
              </button>
            )}
          </div>
        </form>
      ) : (
        <div
          role="group"
          aria-label={t("home.decide.options", { question: decision.question })}
          className="flex flex-wrap gap-2"
        >
          {decision.options.map((o, i) => (
            <button
              key={i}
              type="button"
              className={`${smallSecondary} h-auto min-h-7 max-w-full py-1 text-left [overflow-wrap:anywhere]`}
              onClick={() => respond({ optionIndex: i })}
            >
              {o}
            </button>
          ))}
          <button type="button" className={ghostButton} onClick={() => setOther(true)}>
            {t("home.decide.other")}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Una richiesta da trasformare: progetto e titolo (che apre la richiesta
 * nel suo progetto), chi l'ha chiesta o quante volte, «Turn into task».
 * In «Decide» porta l'etichetta «Request», perché sta fra le decisioni.
 */
export function RequestItem({
  request,
  project,
  requester,
  onConvert,
  labelled = true,
}: {
  request: ProjectRequest;
  project: Project | undefined;
  requester: Person | undefined;
  onConvert: () => void;
  labelled?: boolean;
}) {
  const { t } = useTranslation();
  const times = request.requesterIds.length;
  return (
    <div
      data-request={request.id}
      className="flex items-center gap-3 border-b border-rule py-2.5 pr-3 pl-4"
    >
      {labelled && (
        <span className="w-16 shrink-0 text-xs text-ink-muted">{t("home.decide.request")}</span>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-baseline gap-2">
          {/* Il codice della richiesta porta già quello del progetto (STW-R3). */}
          <span className="num shrink-0 text-xs font-semibold tracking-[0.02em] text-ink">
            {request.code}
          </span>
          {project ? (
            <Link
              to="/p/$code/$section"
              params={{ code: project.code, section: "requests" }}
              search={{ request: request.id }}
              aria-label={t("home.decide.openRequest", { title: request.title })}
              title={request.title}
              className="min-w-0 truncate text-md text-ink hover:underline hover:underline-offset-4"
            >
              {request.title}
            </Link>
          ) : (
            <span className="min-w-0 truncate text-md text-ink">{request.title}</span>
          )}
        </span>
        <span className="text-xs text-ink-muted">
          {times > 1
            ? t("home.decide.requestedTimes", { count: times })
            : t("home.decide.requestedBy", { name: requester?.name ?? t("taskUi.stall.someone") })}
        </span>
      </div>
      <button
        type="button"
        aria-label={t("home.decide.turnIntoTaskLabel", { title: request.title })}
        className={smallSecondary}
        onClick={onConvert}
      >
        {t("home.decide.turnIntoTask")}
      </button>
    </div>
  );
}
