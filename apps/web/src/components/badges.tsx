import type {
  GitProviderKind,
  TicketPriority,
  TicketSource,
  TicketStatus,
  TicketType,
} from "@stubwise/shared";
import { useTranslation } from "react-i18next";

/*
 * Badge del dominio ticket: chip mono in maiuscoletto, colore come unico
 * elemento distintivo, coerenti con la scala "sala controllo". I valori
 * dell'enum restano in inglese nel dominio, le etichette passano da i18n
 * (namespace `badges`). Le mappe `*_LABEL_KEYS` espongono la chiave i18n per
 * ciascun valore così i chiamanti che costruiscono opzioni di select possono
 * tradurle con il proprio `t`.
 */

export const STATUS_LABEL_KEYS: Record<TicketStatus, string> = {
  open: "badges:status.open",
  triaged: "badges:status.triaged",
  in_progress: "badges:status.in_progress",
  in_review: "badges:status.in_review",
  done: "badges:status.done",
  closed: "badges:status.closed",
};

/** Colore-stato condiviso: pallini dei badge e accenti delle colonne board. */
export const STATUS_DOT: Record<TicketStatus, string> = {
  open: "bg-signal",
  triaged: "bg-sky-400",
  in_progress: "bg-sky-400",
  in_review: "bg-violet-400",
  done: "bg-ok",
  closed: "bg-fg-faint",
};

export const PRIORITY_LABEL_KEYS: Record<TicketPriority, string> = {
  low: "badges:priority.low",
  medium: "badges:priority.medium",
  high: "badges:priority.high",
  urgent: "badges:priority.urgent",
};

const PRIORITY_CLASS: Record<TicketPriority, string> = {
  low: "text-fg-faint",
  medium: "text-fg-muted",
  high: "text-signal",
  urgent: "text-danger",
};

/** Tacche di priorità in puro testo mono: ▮ accese su scala di 4. */
const PRIORITY_TICKS: Record<TicketPriority, number> = {
  low: 1,
  medium: 2,
  high: 3,
  urgent: 4,
};

export const TYPE_LABEL_KEYS: Record<TicketType, string> = {
  bug: "badges:type.bug",
  feature: "badges:type.feature",
  task: "badges:type.task",
  feedback: "badges:type.feedback",
};

const TYPE_CLASS: Record<TicketType, string> = {
  bug: "text-danger border-danger/30",
  feature: "text-ok border-ok/30",
  task: "text-fg-muted border-line-strong",
  feedback: "text-sky-400 border-sky-400/30",
};

export const SOURCE_LABEL_KEYS: Record<TicketSource, string> = {
  manual: "badges:source.manual",
  sdk_error: "badges:source.sdk_error",
  sdk_feedback: "badges:source.sdk_feedback",
  api: "badges:source.api",
  slack: "badges:source.slack",
  webhook: "badges:source.webhook",
};

const badgeBase =
  "inline-flex items-center gap-1.5 rounded-sm font-mono text-[11px] tracking-[0.08em] uppercase whitespace-nowrap";

export function StatusBadge({ status }: { status: TicketStatus }) {
  const { t } = useTranslation();
  return (
    <span className={`${badgeBase} border border-line bg-ink-800/60 px-2 py-0.5 text-fg-muted`}>
      <span aria-hidden className={`size-1.5 rounded-full ${STATUS_DOT[status]}`} />
      {t(STATUS_LABEL_KEYS[status])}
    </span>
  );
}

export function PriorityBadge({ priority }: { priority: TicketPriority }) {
  const { t } = useTranslation();
  const ticks = PRIORITY_TICKS[priority];
  const label = t(PRIORITY_LABEL_KEYS[priority]);
  return (
    <span
      className={`${badgeBase} ${PRIORITY_CLASS[priority]}`}
      title={t("badges:priorityTitle", { label })}
    >
      <span aria-hidden className="tracking-[-0.08em]">
        {"▮".repeat(ticks)}
        <span className="opacity-25">{"▮".repeat(4 - ticks)}</span>
      </span>
      {label}
    </span>
  );
}

export function TypeBadge({ type }: { type: TicketType }) {
  const { t } = useTranslation();
  return (
    <span className={`${badgeBase} border px-2 py-0.5 ${TYPE_CLASS[type]}`}>
      {t(TYPE_LABEL_KEYS[type])}
    </span>
  );
}

export const PROVIDER_LABELS: Record<GitProviderKind, string> = {
  bitbucket: "Bitbucket",
  github: "GitHub",
};

const PROVIDER_CLASS: Record<GitProviderKind, string> = {
  bitbucket: "text-sky-400 border-sky-400/30",
  github: "text-fg-muted border-line-strong",
};

/** Provider git di un progetto: stesso chip dei tipi ticket. */
export function ProviderBadge({ provider }: { provider: GitProviderKind }) {
  return (
    <span className={`${badgeBase} border px-2 py-0.5 ${PROVIDER_CLASS[provider]}`}>
      {PROVIDER_LABELS[provider]}
    </span>
  );
}

export function SourceBadge({ source }: { source: TicketSource }) {
  const { t } = useTranslation();
  const label = t(SOURCE_LABEL_KEYS[source]);
  return (
    <span className={`${badgeBase} text-fg-faint`} title={t("badges:sourceTitle", { label })}>
      ◇ {label}
    </span>
  );
}
