import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useSuspenseQuery } from "@tanstack/react-query";
import type {
  ActivityComment,
  ActivityEvent,
  ActivityItem,
  ActivityAiJob,
} from "../lib/api";
import { activityQueryOptions } from "../lib/queries";
import { formatDateTime, formatRelativeTime } from "../lib/format";
import {
  PRIORITY_LABEL_KEYS,
  STATUS_LABEL_KEYS,
  TYPE_LABEL_KEYS,
} from "./badges";
import { FormError } from "./field";
import { Markdown } from "./markdown";

interface ActivityFeedProps {
  ticketId: string;
  /** authorId/actorId → email, per firmare commenti utente ed eventi. */
  authorEmails: Map<string, string>;
  /** Invio del nuovo commento; il rigetto lascia il testo nel campo. */
  onSubmit: (body: string) => Promise<unknown>;
  pending: boolean;
}

/**
 * Timeline cronologica unificata del ticket: commenti (utente/AI/sistema),
 * eventi di audit compatti e marker dei job AI, in ordine crescente, più il
 * composer dei commenti. Il dettaglio tecnico dei job (log/consumi/azioni)
 * resta nel pannello "AI jobs" dedicato (`AIJobTimeline`): qui il job compare
 * solo come riga di stato con link alla PR, per dare la storia cronologica
 * senza duplicare le funzionalità.
 */
export function ActivityFeed({ ticketId, authorEmails, onSubmit, pending }: ActivityFeedProps) {
  const { t } = useTranslation();
  const { data: items } = useSuspenseQuery(activityQueryOptions(ticketId));
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const body = draft.trim();
    if (!body || pending) return;
    setError(null);
    try {
      await onSubmit(body);
      setDraft("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("tickets:comments.submitFailed"));
    }
  }

  return (
    <div className="space-y-4">
      {items.length === 0 ? (
        <p className="font-mono text-[12px] text-fg-faint">{t("tickets:activity.empty")}</p>
      ) : (
        <ol className="space-y-3">
          {items.map((item) => (
            <FeedItem key={`${item.kind}-${item.id}`} item={item} authorEmails={authorEmails} />
          ))}
        </ol>
      )}

      <form onSubmit={(event) => void handleSubmit(event)} className="space-y-2">
        <label
          htmlFor="comment-body"
          className="block font-mono text-[11px] tracking-[0.14em] text-fg-muted uppercase"
        >
          {t("tickets:comments.addComment")}
        </label>
        <textarea
          id="comment-body"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={3}
          placeholder={t("tickets:comments.placeholder")}
          className="w-full rounded-sm border border-line-strong bg-ink-950/70 px-3 py-2 text-sm text-fg placeholder:text-fg-faint transition-colors hover:border-ink-700 focus-visible:border-signal-dim"
        />
        <FormError message={error} />
        <button
          type="submit"
          disabled={pending || draft.trim() === ""}
          className="rounded-sm bg-signal px-3 py-1.5 font-mono text-[12px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright active:bg-signal-dim disabled:cursor-not-allowed disabled:bg-signal-dim disabled:opacity-60"
        >
          {pending ? t("tickets:comments.submitPending") : t("tickets:comments.submit")}
        </button>
      </form>
    </div>
  );
}

function FeedItem({ item, authorEmails }: { item: ActivityItem; authorEmails: Map<string, string> }) {
  switch (item.kind) {
    case "comment":
      return <CommentItem comment={item} authorEmails={authorEmails} />;
    case "event":
      return <EventItem event={item} authorEmails={authorEmails} />;
    case "ai_job":
      return <AiJobItem job={item} />;
  }
}

/** Commento: stessa resa del vecchio comment-thread (utente/AI/sistema). */
function CommentItem({
  comment,
  authorEmails,
}: {
  comment: ActivityComment;
  authorEmails: Map<string, string>;
}) {
  const { t } = useTranslation();
  return (
    <li
      className={`rounded-sm border bg-ink-900 px-4 py-3 ${
        comment.authorType === "ai"
          ? "border-signal-dim/40 shadow-[inset_2px_0_0_0_var(--color-signal)]"
          : comment.authorType === "system"
            ? "border-line shadow-[inset_2px_0_0_0_var(--color-line-strong)]"
            : "border-line"
      }`}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {comment.authorType === "ai" ? (
          <>
            <span className="rounded-sm bg-signal px-1.5 py-px font-mono text-[10px] font-semibold tracking-[0.12em] text-ink-950 uppercase">
              AI
            </span>
            <span className="font-mono text-[12px] text-fg-muted">Stubwise</span>
          </>
        ) : comment.authorType === "system" ? (
          <span className="rounded-sm border border-line-strong px-1.5 py-px font-mono text-[10px] font-semibold tracking-[0.12em] text-fg-muted uppercase">
            {t("tickets:comments.system")}
          </span>
        ) : (
          <span className="font-mono text-[12px] text-fg-muted">
            {(comment.authorId && authorEmails.get(comment.authorId)) ??
              t("tickets:comments.removedUser")}
          </span>
        )}
        <time
          dateTime={comment.createdAt}
          title={formatDateTime(comment.createdAt)}
          className="font-mono text-[11px] text-fg-faint"
        >
          {formatRelativeTime(comment.createdAt)}
        </time>
      </div>
      <div className="mt-2">
        <Markdown source={comment.body} />
      </div>
    </li>
  );
}

/** Riga di audit compatta: testo i18n con interpolazione + timestamp. */
function EventItem({
  event,
  authorEmails,
}: {
  event: ActivityEvent;
  authorEmails: Map<string, string>;
}) {
  const { t } = useTranslation();
  const text = describeEvent(event, authorEmails, t);
  if (!text) return null;
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-1 font-mono text-[11px] text-fg-faint">
      <span aria-hidden className="text-line-strong">
        ·
      </span>
      <span className="text-fg-muted">{text}</span>
      <time
        dateTime={event.createdAt}
        title={formatDateTime(event.createdAt)}
        className="text-fg-faint"
      >
        {formatRelativeTime(event.createdAt)}
      </time>
    </li>
  );
}

type TFunc = ReturnType<typeof useTranslation>["t"];

/** Nome leggibile dell'attore: email risolta, "System" se assente. */
function actorName(actorId: string | null, authorEmails: Map<string, string>, t: TFunc): string {
  if (actorId === null) return t("tickets:activity.systemActor");
  return authorEmails.get(actorId) ?? t("tickets:comments.removedUser");
}

/** Estrae from/to grezzi dal payload jsonb (string|null). */
function fromTo(payload: Record<string, unknown> | null): {
  from: unknown;
  to: unknown;
} {
  return { from: payload?.from ?? null, to: payload?.to ?? null };
}

/** Compone il messaggio di audit di un evento mappando gli enum alle label. */
function describeEvent(
  event: ActivityEvent,
  authorEmails: Map<string, string>,
  t: TFunc,
): string {
  const actor = actorName(event.actorId, authorEmails, t);
  const { from, to } = fromTo(event.payload);

  switch (event.eventKind) {
    case "status_changed":
      return t("tickets:activity.events.status_changed", {
        actor,
        from: statusLabel(from, t),
        to: statusLabel(to, t),
      });
    case "priority_changed":
      return t("tickets:activity.events.priority_changed", {
        actor,
        from: priorityLabel(from, t),
        to: priorityLabel(to, t),
      });
    case "type_changed":
      return t("tickets:activity.events.type_changed", {
        actor,
        from: typeLabel(from, t),
        to: typeLabel(to, t),
      });
    case "assignee_changed":
      return to === null || to === undefined
        ? t("tickets:activity.events.unassigned", { actor })
        : t("tickets:activity.events.assignee_changed", {
            actor,
            user: userLabel(to, authorEmails, t),
          });
    case "labels_changed":
      return t("tickets:activity.events.labels_changed", { actor });
    case "title_changed":
      return t("tickets:activity.events.title_changed", { actor });
    case "body_changed":
      return t("tickets:activity.events.body_changed", { actor });
    // L'evento relazione porta nel payload la kind canonica (blocks/relates_to/
    // parent) e la direzione (outgoing/incoming) dal punto di vista del ticket
    // corrente. Si mappa kind+direzione alla relazione MOSTRATA (la stessa scala
    // a 5 valori di TicketRelation) e si compone il testo col numero dell'altro.
    case "relation_added":
    case "relation_removed":
      return t(`tickets:activity.events.${event.eventKind}.${relationFromPayload(event.payload)}`, {
        actor,
        number: relationNumber(event.payload),
      });
  }
}

/** Relazioni canoniche (kind) → relazione mostrata, per direzione. */
const RELATION_BY_DIRECTION: Record<string, Record<string, string>> = {
  outgoing: { blocks: "blocks", relates_to: "relates_to", parent: "parent" },
  incoming: { blocks: "blocked_by", relates_to: "relates_to", parent: "child" },
};

/**
 * Dal payload dell'evento relazione (`{ kind, direction, otherNumber }`)
 * ricava la relazione da mostrare: outgoing usa la kind, incoming la inverte
 * (blocks→blocked_by, parent→child, relates_to resta simmetrica).
 */
function relationFromPayload(payload: Record<string, unknown> | null): string {
  const kind = typeof payload?.kind === "string" ? payload.kind : "relates_to";
  const direction = payload?.direction === "incoming" ? "incoming" : "outgoing";
  return RELATION_BY_DIRECTION[direction]?.[kind] ?? "relates_to";
}

function relationNumber(payload: Record<string, unknown> | null): number | string {
  const n = payload?.otherNumber;
  return typeof n === "number" ? n : "?";
}

function statusLabel(raw: unknown, t: TFunc): string {
  const key = STATUS_LABEL_KEYS[raw as keyof typeof STATUS_LABEL_KEYS];
  return key ? t(key) : String(raw);
}

function priorityLabel(raw: unknown, t: TFunc): string {
  const key = PRIORITY_LABEL_KEYS[raw as keyof typeof PRIORITY_LABEL_KEYS];
  return key ? t(key) : String(raw);
}

function typeLabel(raw: unknown, t: TFunc): string {
  const key = TYPE_LABEL_KEYS[raw as keyof typeof TYPE_LABEL_KEYS];
  return key ? t(key) : String(raw);
}

function userLabel(raw: unknown, authorEmails: Map<string, string>, t: TFunc): string {
  if (typeof raw !== "string") return String(raw);
  return authorEmails.get(raw) ?? t("tickets:comments.removedUser");
}

/** Marker compatto di un job AI: etichetta di stato + eventuale link PR. */
function AiJobItem({ job }: { job: ActivityAiJob }) {
  const { t } = useTranslation();
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-1 font-mono text-[11px]">
      <span aria-hidden className="text-line-strong">
        ·
      </span>
      <span className={`tracking-[0.08em] uppercase ${JOB_STATUS_TEXT[job.status]}`}>
        {t(`jobStatus:labels.${job.status}`)}
      </span>
      <time
        dateTime={job.createdAt}
        title={formatDateTime(job.createdAt)}
        className="text-fg-faint"
      >
        {formatRelativeTime(job.createdAt)}
      </time>
      {job.prUrl && (
        <a
          href={job.prUrl}
          target="_blank"
          rel="noreferrer"
          className="rounded-sm border border-ok/40 px-1.5 py-px tracking-[0.08em] text-ok uppercase transition-colors hover:border-ok hover:bg-ok/10"
        >
          {t("tickets:timeline.viewPr")}
        </a>
      )}
    </li>
  );
}

/** Colore-testo per stato job (gemello di quello in ai-job-timeline). */
const JOB_STATUS_TEXT: Record<ActivityAiJob["status"], string> = {
  queued: "text-fg-muted",
  triaging: "text-sky-400",
  fixing: "text-sky-400",
  held: "text-signal",
  pr_opened: "text-ok",
  pr_merged: "text-ok",
  failed: "text-danger",
  skipped: "text-fg-faint",
  pr_closed: "text-fg-faint",
  awaiting_plan_approval: "text-signal",
};
