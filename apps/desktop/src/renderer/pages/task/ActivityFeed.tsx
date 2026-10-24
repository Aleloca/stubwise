import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  useActivity,
  useAddComment,
  useDecisionRequests,
  useDeleteComment,
  useEditComment,
  usePeople,
} from "../../data/queries";
import type { ActivityEntry, DecisionRequest, Person, Task } from "../../data/types";
import { can, useViewer } from "../../data/viewer";
import { formatDateTime, relativeTime } from "../../notifications/time";
import { inputClass } from "../../tasks-ui/Dialog";
import { Markdown } from "../../tasks-ui/Markdown";
import { Avatar } from "../../tasks-ui/PersonChip";
import { useToast } from "../../tasks-ui/Toast";
import { answerText } from "./DecisionSection";
import { InlineConfirm, Section, ghostButton, smallPrimary, smallSecondary } from "./parts";

type PersonOf = (id: string | null | undefined) => Person | undefined;

/**
 * L'attività della task in un solo flusso, dal più vecchio: commenti
 * (markdown, risposte sotto il commento a cui rispondono, modifica del
 * proprio, eliminazione con conferma — il testo sparisce per tutti), cambi di
 * campo in una riga compatta, risposte alle decisioni. Il campo per scrivere
 * sta in fondo, solo con `tickets.comment`.
 */
export function ActivityFeed({ task, canComment }: { task: Task; canComment: boolean }) {
  const { t } = useTranslation();
  const { data: entries, isError, refetch } = useActivity(task.id);
  const decisions = useDecisionRequests({ taskId: task.id }).data;
  const people = usePeople().data;
  const person: PersonOf = (id) => (id ? people?.find((p) => p.id === id) : undefined);
  const [replyTo, setReplyTo] = useState<string | null>(null);

  const sorted = [...(entries ?? [])].sort((a, b) => a.at.localeCompare(b.at));
  const replies = new Map<string, ActivityEntry[]>();
  for (const e of sorted) {
    if (e.kind === "comment" && e.replyToId && sorted.some((p) => p.id === e.replyToId)) {
      replies.set(e.replyToId, [...(replies.get(e.replyToId) ?? []), e]);
    }
  }
  const top = sorted.filter(
    (e) => !(e.kind === "comment" && e.replyToId && replies.get(e.replyToId)?.includes(e)),
  );

  let body: ReactNode;
  if (isError) {
    body = (
      <div role="alert" className="flex items-center gap-2 text-sm text-ink">
        {t("taskDetail.activity.error")}
        <button type="button" className={smallSecondary} onClick={() => void refetch()}>
          {t("taskUi.states.retry")}
        </button>
      </div>
    );
  } else if (!entries) {
    body = (
      <div aria-busy="true" className="skeleton-breathe flex flex-col gap-3">
        <span role="status" className="sr-only">
          {t("taskUi.states.loading")}
        </span>
        {[70, 50, 62].map((w, i) => (
          <span key={i} className="flex items-center gap-2">
            <span className="size-[22px] rounded-full bg-ink/8" />
            <span className="h-2.5 rounded-sm bg-ink/8" style={{ width: `${w}%` }} />
          </span>
        ))}
      </div>
    );
  } else {
    body = (
      <ol aria-label={t("taskDetail.activity.title")} className="flex flex-col">
        {top.length === 0 && (
          <li className="text-sm text-ink-faint">{t("taskDetail.activity.none")}</li>
        )}
        {top.map((entry) => (
          <EntryRow
            key={entry.id}
            entry={entry}
            task={task}
            person={person}
            decisions={decisions ?? []}
            replies={replies.get(entry.id) ?? []}
            canComment={canComment}
            replying={replyTo === entry.id}
            onReply={() => setReplyTo(entry.id)}
            onReplyDone={() => setReplyTo(null)}
          />
        ))}
      </ol>
    );
  }

  return (
    <Section title={t("taskDetail.activity.title")}>
      {body}
      {canComment && entries && <Composer task={task} />}
    </Section>
  );
}

function EntryRow({
  entry,
  task,
  person,
  decisions,
  replies,
  canComment,
  replying,
  onReply,
  onReplyDone,
}: {
  entry: ActivityEntry;
  task: Task;
  person: PersonOf;
  decisions: DecisionRequest[];
  replies: ActivityEntry[];
  canComment: boolean;
  replying: boolean;
  onReply: () => void;
  onReplyDone: () => void;
}) {
  if (entry.kind === "field_change") return <FieldChangeRow entry={entry} person={person} />;
  if (entry.kind === "decision") {
    return <DecisionRow entry={entry} person={person} decisions={decisions} />;
  }
  return (
    <li className="flex flex-col py-2">
      <Comment entry={entry} task={task} person={person} canComment={canComment} onReply={onReply} />
      {(replies.length > 0 || replying) && (
        <ol className="mt-1 ml-[11px] flex flex-col border-l border-rule pl-4">
          {replies.map((r) => (
            <li key={r.id} className="py-1.5">
              <Comment entry={r} task={task} person={person} canComment={canComment} />
            </li>
          ))}
          {replying && (
            <li className="py-1.5">
              <Composer task={task} replyToId={entry.id} onDone={onReplyDone} />
            </li>
          )}
        </ol>
      )}
    </li>
  );
}

function When({ at }: { at: string }) {
  const { t, i18n } = useTranslation();
  return (
    <time
      dateTime={at}
      title={formatDateTime(at, i18n.language)}
      className="num shrink-0 text-xs text-ink-faint"
    >
      {relativeTime(at, t, i18n.language)}
    </time>
  );
}

/** Il nome del campo come lo dice la cronologia (`status`, `due`…), tradotto se si conosce. */
function fieldName(field: string, t: (key: string, opts?: Record<string, unknown>) => string): string {
  return t(`taskDetail.activity.fields.${field}`, { defaultValue: field });
}

/** «Giulia Ferri · status: To do → In progress», in una riga sola, piccola. */
function FieldChangeRow({ entry, person }: { entry: ActivityEntry; person: PersonOf }) {
  const { t } = useTranslation();
  const who = person(entry.authorId)?.name ?? t("taskDetail.activity.system");
  const field = entry.field ?? "";
  let what: string;
  if (field === "description") what = t("taskDetail.activity.editedDescription");
  else if (field === "followerIds") what = t("taskDetail.activity.followers");
  else if (field === "manualStall") {
    what = entry.to
      ? t("taskDetail.activity.markedStalled", { reason: entry.to })
      : t("taskDetail.activity.unmarkedStalled");
  } else if (entry.from && entry.to) {
    what = `${fieldName(field, t)}: ${entry.from} → ${entry.to}`;
  } else if (entry.to) {
    what = t("taskDetail.activity.set", { field: fieldName(field, t), value: entry.to });
  } else {
    what = t("taskDetail.activity.cleared", { field: fieldName(field, t) });
  }
  return (
    <li data-activity="field_change" className="flex items-baseline gap-2 py-1 pl-[30px]">
      <p className="min-w-0 flex-1 text-sm text-ink-muted [overflow-wrap:anywhere]">
        <span className="font-medium text-ink">{who}</span> · {what}
      </p>
      <When at={entry.at} />
    </li>
  );
}

function DecisionRow({
  entry,
  person,
  decisions,
}: {
  entry: ActivityEntry;
  person: PersonOf;
  decisions: DecisionRequest[];
}) {
  const { t } = useTranslation();
  const request = decisions.find((d) => d.id === entry.decisionRequestId);
  const who = person(entry.authorId);
  return (
    <li data-activity="decision" className="flex gap-2 py-2">
      <Avatar person={who} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 text-sm text-ink">
            {t("taskDetail.activity.decided", { name: who?.name ?? t("taskUi.stall.someone") })}
          </span>
          <When at={entry.at} />
        </p>
        {request && (
          <>
            <p className="text-sm text-ink-muted [overflow-wrap:anywhere]">{request.question}</p>
            <p className="text-md font-medium text-ink [overflow-wrap:anywhere]">{answerText(request)}</p>
          </>
        )}
      </div>
    </li>
  );
}

function Comment({
  entry,
  task,
  person,
  canComment,
  onReply,
}: {
  entry: ActivityEntry;
  task: Task;
  person: PersonOf;
  canComment: boolean;
  onReply?: () => void;
}) {
  const { t } = useTranslation();
  const { viewer } = useViewer();
  const toast = useToast();
  const edit = useEditComment();
  const remove = useDeleteComment();
  const [draft, setDraft] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const author = person(entry.authorId);
  const mine = entry.authorId === viewer.personId;
  const canDelete = mine || can(viewer, "tickets.moderate", task.projectId);

  if (entry.deletedAt) {
    return (
      <div data-activity="comment-deleted" className="flex items-baseline gap-2 pl-[30px]">
        <p className="min-w-0 flex-1 text-sm text-ink-faint italic">
          {t("taskDetail.activity.deleted", {
            name: person(entry.deletedById)?.name ?? t("taskUi.stall.someone"),
          })}
        </p>
        <When at={entry.deletedAt} />
      </div>
    );
  }

  const save = () => {
    const body = draft?.trim();
    if (!body) return;
    edit.mutate(
      { id: entry.id, body },
      {
        onSuccess: () => setDraft(null),
        onError: () => toast.error(t("taskDetail.activity.editFailed")),
      },
    );
  };

  return (
    <div data-activity="comment" className="flex gap-2">
      <Avatar person={author} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="flex items-baseline gap-2">
          <span className="min-w-0 truncate text-sm font-semibold text-ink">
            {author?.name ?? t("taskDetail.activity.system")}
          </span>
          <When at={entry.at} />
          {entry.editedAt && (
            <span className="text-xs text-ink-faint" title={entry.editedAt}>
              {t("taskDetail.activity.edited")}
            </span>
          )}
        </p>
        {draft !== null ? (
          <div className="flex flex-col gap-1.5">
            <textarea
              autoFocus
              aria-label={t("taskDetail.activity.editLabel")}
              value={draft}
              rows={3}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setDraft(null);
                } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  save();
                }
              }}
              className={`${inputClass} resize-y`}
            />
            <div className="flex justify-end gap-1.5">
              <button type="button" className={smallSecondary} onClick={() => setDraft(null)}>
                {t("taskDetail.cancel")}
              </button>
              <button
                type="button"
                className={smallPrimary}
                disabled={!draft.trim() || edit.isPending}
                onClick={save}
              >
                {t("taskDetail.save")}
              </button>
            </div>
          </div>
        ) : (
          <Markdown source={entry.body ?? ""} />
        )}
        {confirming ? (
          <InlineConfirm
            message={t("taskDetail.activity.confirmDelete")}
            confirm={t("taskDetail.activity.deleteConfirm")}
            cancelLabel={t("taskDetail.cancel")}
            onCancel={() => setConfirming(false)}
            onConfirm={() => {
              setConfirming(false);
              remove.mutate(entry.id, {
                onError: () => toast.error(t("taskDetail.activity.deleteFailed")),
              });
            }}
          />
        ) : (
          draft === null && (
            <div className="-ml-2 flex items-center gap-0.5">
              {canComment && onReply && (
                <button type="button" className={`${ghostButton} h-6`} onClick={onReply}>
                  {t("taskDetail.activity.reply")}
                </button>
              )}
              {mine && (
                <button
                  type="button"
                  className={`${ghostButton} h-6`}
                  onClick={() => setDraft(entry.body ?? "")}
                >
                  {t("taskDetail.edit")}
                </button>
              )}
              {canDelete && (
                <button
                  type="button"
                  className={`${ghostButton} h-6`}
                  onClick={() => setConfirming(true)}
                >
                  {t("taskDetail.activity.delete")}
                </button>
              )}
            </div>
          )
        )}
      </div>
    </div>
  );
}

/** Scrivere un commento (o una risposta): markdown, ⌘/Ctrl+Invio invia. */
function Composer({
  task,
  replyToId,
  onDone,
}: {
  task: Task;
  replyToId?: string;
  onDone?: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const add = useAddComment();
  const [body, setBody] = useState("");
  const id = useId();
  const label = replyToId ? t("taskDetail.activity.replyLabel") : t("taskDetail.activity.write");
  const send = () => {
    if (!body.trim()) return;
    add.mutate(
      { taskId: task.id, body, replyToId },
      {
        onSuccess: () => {
          setBody("");
          onDone?.();
        },
        onError: () => toast.error(t("taskDetail.activity.sendFailed")),
      },
    );
  };
  return (
    <form
      className={`flex flex-col gap-1.5 ${replyToId ? "" : "pt-2"}`}
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <textarea
        id={id}
        autoFocus={!!replyToId}
        rows={replyToId ? 2 : 3}
        value={body}
        placeholder={label}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            send();
          } else if (e.key === "Escape" && replyToId) {
            e.preventDefault();
            onDone?.();
          } else if (e.key === "Escape" && body.trim()) {
            // Con una bozza, Esc non chiude il pannello: il testo si perderebbe.
            // A campo vuoto passa, e il pannello si chiude come altrove.
            e.preventDefault();
          }
        }}
        className={`${inputClass} resize-y`}
      />
      <div className="flex items-center justify-end gap-1.5">
        <span className="mr-auto text-xs text-ink-faint">{t("taskDetail.activity.markdownHint")}</span>
        {replyToId && (
          <button type="button" className={smallSecondary} onClick={onDone}>
            {t("taskDetail.cancel")}
          </button>
        )}
        <button type="submit" className={smallPrimary} disabled={!body.trim() || add.isPending}>
          {replyToId ? t("taskDetail.activity.sendReply") : t("taskDetail.activity.send")}
        </button>
      </div>
    </form>
  );
}
