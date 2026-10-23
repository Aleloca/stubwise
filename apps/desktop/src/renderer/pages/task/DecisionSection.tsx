import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useAnswerDecision,
  useDecisionRequests,
  usePeople,
  useWithdrawDecision,
} from "../../data/queries";
import type { DecisionRequest, Person, Task } from "../../data/types";
import { useViewer } from "../../data/viewer";
import { formatDate, relativeTime } from "../../notifications/time";
import { inputClass } from "../../tasks-ui/Dialog";
import { Avatar } from "../../tasks-ui/PersonChip";
import { useToast } from "../../tasks-ui/Toast";
import { AskDecisionDialog } from "./AskDecisionDialog";
import { Section, ghostButton, smallPrimary, smallSecondary } from "./parts";

const isOpen = (d: DecisionRequest) => d.answer === null && d.withdrawnAt === null;

/** La risposta detta a parole: l'opzione scelta o il testo libero. */
export function answerText(d: DecisionRequest): string {
  if (!d.answer) return "";
  return d.answer.optionIndex !== null ? (d.options[d.answer.optionIndex] ?? "") : (d.answer.text ?? "");
}

/**
 * Le richieste di decisione della task: aperte in cima (chi deve decidere,
 * la domanda, le opzioni), poi quelle chiuse in una riga ciascuna. Chi è
 * interpellato risponde qui; chi ha chiesto può ritirarla. Con
 * `tickets.comment` si chiede una decisione a un membro del progetto.
 */
export function DecisionSection({ task, canComment }: { task: Task; canComment: boolean }) {
  const { t } = useTranslation();
  const [asking, setAsking] = useState(false);
  const { data: requests } = useDecisionRequests({ taskId: task.id });
  const people = usePeople().data;
  const open = (requests ?? []).filter(isOpen).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const closed = (requests ?? [])
    .filter((d) => !isOpen(d))
    .sort((a, b) => closedAt(b).localeCompare(closedAt(a)));
  const person = (id: string) => people?.find((p) => p.id === id);

  const action = canComment && (
    <button type="button" className={ghostButton} onClick={() => setAsking(true)}>
      {t("taskDetail.decisions.ask")}
    </button>
  );
  const dialog = asking && <AskDecisionDialog task={task} onClose={() => setAsking(false)} />;

  if (!requests || requests.length === 0) {
    return (
      <>
        <Section
          title={t("taskDetail.decisions.title")}
          empty={requests ? t("taskDetail.decisions.none") : undefined}
          action={action}
        />
        {dialog}
      </>
    );
  }

  return (
    <>
      <Section title={t("taskDetail.decisions.title")} count={open.length} action={action}>
        {open.length > 0 && (
          <ul className="flex flex-col gap-2">
            {open.map((d) => (
              <OpenDecision key={d.id} request={d} task={task} person={person} />
            ))}
          </ul>
        )}
        {closed.length > 0 && (
          <ul aria-label={t("taskDetail.decisions.closed")} className="flex flex-col">
            {closed.map((d) => (
              <ClosedDecision key={d.id} request={d} person={person} />
            ))}
          </ul>
        )}
      </Section>
      {dialog}
    </>
  );
}

function closedAt(d: DecisionRequest): string {
  return d.answer?.at ?? d.withdrawnAt ?? d.createdAt;
}

function OpenDecision({
  request,
  task,
  person,
}: {
  request: DecisionRequest;
  task: Task;
  person: (id: string) => Person | undefined;
}) {
  const { t, i18n } = useTranslation();
  const { viewer } = useViewer();
  const toast = useToast();
  const withdraw = useWithdrawDecision();
  const of = person(request.askedOfId);
  const by = person(request.askedById);
  const mine = request.askedOfId === viewer.personId;
  const askedByMe = request.askedById === viewer.personId;
  const firstName = of?.name.split(/\s+/)[0] ?? t("taskUi.stall.someone");
  return (
    <li
      data-decision={request.id}
      className={`flex flex-col gap-2 rounded-lg border px-3 py-2.5 ${mine ? "border-ink/40" : "border-rule"}`}
    >
      <div className="flex items-start gap-2">
        <Avatar person={of} />
        <div className="flex min-w-0 flex-1 flex-col">
          <p className="text-sm font-semibold text-ink">
            {mine
              ? t("taskDetail.decisions.youDecide")
              : t("taskDetail.decisions.decides", { name: of?.name ?? firstName })}
          </p>
          <p className="text-xs text-ink-muted">
            {t("taskDetail.decisions.askedBy", {
              name: by?.name ?? t("taskUi.stall.someone"),
              when: relativeTime(request.createdAt, t, i18n.language),
            })}
          </p>
        </div>
      </div>
      <p className="text-md text-ink [overflow-wrap:anywhere]">{request.question}</p>
      {mine ? (
        <AnswerForm request={request} />
      ) : (
        request.options.length > 0 && (
          <ul aria-label={t("taskDetail.decisions.options")} className="flex flex-col gap-0.5 pl-1">
            {request.options.map((o, i) => (
              <li key={i} className="flex gap-2 text-sm text-ink-muted">
                <span aria-hidden="true" className="text-ink-faint">
                  ·
                </span>
                {o}
              </li>
            ))}
          </ul>
        )
      )}
      {askedByMe && (
        <div className="flex justify-end">
          <button
            type="button"
            className={smallSecondary}
            disabled={withdraw.isPending}
            onClick={() =>
              withdraw.mutate(request.id, {
                onSuccess: () => toast.show(t("taskDetail.decisions.withdrawn", { code: task.code })),
                onError: () => toast.error(t("taskDetail.decisions.withdrawFailed")),
              })
            }
          >
            {t("taskDetail.decisions.withdraw")}
          </button>
        </div>
      )}
    </li>
  );
}

const OTHER = -1;

/** La risposta di chi è interpellato: una delle opzioni o «Other…» a testo libero. */
function AnswerForm({ request }: { request: DecisionRequest }) {
  const { t } = useTranslation();
  const toast = useToast();
  const answer = useAnswerDecision();
  const name = useId();
  const otherId = useId();
  const hasOptions = request.options.length > 0;
  const [choice, setChoice] = useState<number | null>(hasOptions ? null : OTHER);
  const [text, setText] = useState("");
  const ready = choice !== null && (choice !== OTHER || text.trim().length > 0);
  const submit = () => {
    if (!ready) return;
    answer.mutate(
      {
        id: request.id,
        answer: choice === OTHER ? { text: text.trim() } : { optionIndex: choice! },
      },
      { onError: () => toast.error(t("taskDetail.decisions.answerFailed")) },
    );
  };
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {hasOptions && (
        <fieldset className="flex flex-col gap-0.5">
          <legend className="sr-only">{t("taskDetail.decisions.options")}</legend>
          {request.options.map((o, i) => (
            <label
              key={i}
              className="flex min-h-8 cursor-pointer items-center gap-2.5 rounded-md px-2 text-sm text-ink hover:bg-ink/6"
            >
              <input
                type="radio"
                name={name}
                checked={choice === i}
                onChange={() => setChoice(i)}
                className="size-3.5 shrink-0"
              />
              <span className="[overflow-wrap:anywhere]">{o}</span>
            </label>
          ))}
          <label className="flex min-h-8 cursor-pointer items-center gap-2.5 rounded-md px-2 text-sm text-ink hover:bg-ink/6">
            <input
              type="radio"
              name={name}
              checked={choice === OTHER}
              onChange={() => setChoice(OTHER)}
              className="size-3.5 shrink-0"
            />
            {t("taskDetail.decisions.other")}
          </label>
        </fieldset>
      )}
      {choice === OTHER && (
        <>
          <label htmlFor={otherId} className="sr-only">
            {t("taskDetail.decisions.yourAnswer")}
          </label>
          <textarea
            id={otherId}
            rows={2}
            value={text}
            placeholder={t("taskDetail.decisions.yourAnswer")}
            onChange={(e) => setText(e.target.value)}
            className={`${inputClass} resize-y`}
          />
        </>
      )}
      <div className="flex justify-end">
        <button type="submit" className={smallPrimary} disabled={!ready || answer.isPending}>
          {t("taskDetail.decisions.answer")}
        </button>
      </div>
    </form>
  );
}

function ClosedDecision({
  request,
  person,
}: {
  request: DecisionRequest;
  person: (id: string) => Person | undefined;
}) {
  const { t, i18n } = useTranslation();
  const of = person(request.askedOfId)?.name ?? t("taskUi.stall.someone");
  const line = request.answer
    ? request.answer.optionIndex !== null
      ? t("taskDetail.decisions.chose", { name: of, answer: answerText(request) })
      : t("taskDetail.decisions.answered", { name: of, answer: answerText(request) })
    : t("taskDetail.decisions.withdrawnBy", {
        name: person(request.askedById)?.name ?? t("taskUi.stall.someone"),
      });
  return (
    <li className="flex flex-col gap-0.5 border-t border-rule py-2 first:border-t-0 first:pt-0.5">
      <p className="text-sm text-ink-muted [overflow-wrap:anywhere]">{request.question}</p>
      <p className="flex items-baseline gap-2 text-sm text-ink">
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{line}</span>
        <span className="num shrink-0 text-xs text-ink-faint">
          {formatDate(closedAt(request), i18n.language)}
        </span>
      </p>
    </li>
  );
}
