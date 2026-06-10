import type {
  TicketPriority,
  TicketSource,
  TicketStatus,
  TicketType,
} from "@stubwise/shared";

/*
 * Badge del dominio ticket: chip mono in maiuscoletto, colore come unico
 * elemento distintivo, coerenti con la scala "sala controllo". I valori
 * dell'enum restano in inglese nel dominio, le etichette sono italiane.
 */

export const STATUS_LABELS: Record<TicketStatus, string> = {
  open: "Aperto",
  triaged: "Triage",
  in_progress: "In corso",
  in_review: "In review",
  done: "Fatto",
  closed: "Chiuso",
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

export const PRIORITY_LABELS: Record<TicketPriority, string> = {
  low: "Bassa",
  medium: "Media",
  high: "Alta",
  urgent: "Urgente",
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

export const TYPE_LABELS: Record<TicketType, string> = {
  bug: "Bug",
  feature: "Feature",
  task: "Task",
  feedback: "Feedback",
};

const TYPE_CLASS: Record<TicketType, string> = {
  bug: "text-danger border-danger/30",
  feature: "text-ok border-ok/30",
  task: "text-fg-muted border-line-strong",
  feedback: "text-sky-400 border-sky-400/30",
};

export const SOURCE_LABELS: Record<TicketSource, string> = {
  manual: "Manuale",
  sdk_error: "SDK",
  sdk_feedback: "SDK",
  api: "API",
};

const badgeBase =
  "inline-flex items-center gap-1.5 rounded-sm font-mono text-[11px] tracking-[0.08em] uppercase whitespace-nowrap";

export function StatusBadge({ status }: { status: TicketStatus }) {
  return (
    <span className={`${badgeBase} border border-line bg-ink-800/60 px-2 py-0.5 text-fg-muted`}>
      <span aria-hidden className={`size-1.5 rounded-full ${STATUS_DOT[status]}`} />
      {STATUS_LABELS[status]}
    </span>
  );
}

export function PriorityBadge({ priority }: { priority: TicketPriority }) {
  const ticks = PRIORITY_TICKS[priority];
  return (
    <span className={`${badgeBase} ${PRIORITY_CLASS[priority]}`} title={`Priorità: ${PRIORITY_LABELS[priority]}`}>
      <span aria-hidden className="tracking-[-0.08em]">
        {"▮".repeat(ticks)}
        <span className="opacity-25">{"▮".repeat(4 - ticks)}</span>
      </span>
      {PRIORITY_LABELS[priority]}
    </span>
  );
}

export function TypeBadge({ type }: { type: TicketType }) {
  return (
    <span className={`${badgeBase} border px-2 py-0.5 ${TYPE_CLASS[type]}`}>
      {TYPE_LABELS[type]}
    </span>
  );
}

export function SourceBadge({ source }: { source: TicketSource }) {
  return (
    <span className={`${badgeBase} text-fg-faint`} title={`Origine: ${SOURCE_LABELS[source]}`}>
      ◇ {SOURCE_LABELS[source]}
    </span>
  );
}
