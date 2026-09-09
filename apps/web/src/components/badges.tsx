import type {
  BacklogItemStatus,
  BacklogRisk,
  GitProviderKind,
  MailSignal,
  PrState,
  TicketPriority,
  TicketSource,
  TicketStatus,
  TicketType,
  WorkState,
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
  review: "badges:type.review",
};

const TYPE_CLASS: Record<TicketType, string> = {
  bug: "text-danger border-danger/30",
  feature: "text-ok border-ok/30",
  task: "text-fg-muted border-line-strong",
  feedback: "text-sky-400 border-sky-400/30",
  review: "text-purple-400 border-purple-400/30",
};

/**
 * Il segnale che la classificazione della posta ha riconosciuto (fase 6):
 * stessa forma dei badge di dominio qui sopra, colore come unico elemento
 * distintivo. Usato dalla card `google.proposal` (`inbox-item.tsx`) e dalla
 * pagina Posta (`routes/mail.tsx`) — un solo componente per le due superfici.
 */
export const SIGNAL_LABEL_KEYS: Record<MailSignal, string> = {
  decision: "badges:signal.decision",
  request: "badges:signal.request",
  deadline: "badges:signal.deadline",
  blocker: "badges:signal.blocker",
  none: "badges:signal.none",
};

const SIGNAL_CLASS: Record<MailSignal, string> = {
  decision: "text-sky-400 border-sky-400/30",
  request: "text-fg-muted border-line-strong",
  deadline: "text-signal border-signal-dim/40",
  blocker: "text-danger border-danger/30",
  none: "text-fg-faint border-line-strong",
};

export function SignalBadge({ signal }: { signal: MailSignal }) {
  const { t } = useTranslation();
  return (
    <span className={`${badgeBase} border px-2 py-0.5 ${SIGNAL_CLASS[signal]}`}>
      {t(SIGNAL_LABEL_KEYS[signal])}
    </span>
  );
}

export const SOURCE_LABEL_KEYS: Record<TicketSource, string> = {
  manual: "badges:source.manual",
  sdk_error: "badges:source.sdk_error",
  sdk_feedback: "badges:source.sdk_feedback",
  api: "badges:source.api",
  slack: "badges:source.slack",
  webhook: "badges:source.webhook",
  widget: "badges:source.widget",
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

/*
 * Badge del dominio backlog di discovery: stesse convenzioni dei ticket (chip
 * mono, colore come segnale). Le mappe `*_LABEL_KEYS` espongono la chiave i18n
 * per ogni valore così i select dei filtri le traducono col proprio `t`.
 * L'urgenza riusa {@link PriorityBadge} (stessa scala di priority dei ticket);
 * qui vivono solo i badge specifici del backlog: stato, rischio ed effort.
 */

export const BACKLOG_STATUS_LABEL_KEYS: Record<BacklogItemStatus, string> = {
  new: "badges:backlogStatus.new",
  refining: "badges:backlogStatus.refining",
  ready: "badges:backlogStatus.ready",
  converted: "badges:backlogStatus.converted",
  archived: "badges:backlogStatus.archived",
};

/** Colore-stato del backlog: pallino del badge di stato. */
const BACKLOG_STATUS_DOT: Record<BacklogItemStatus, string> = {
  new: "bg-signal",
  refining: "bg-sky-400",
  ready: "bg-ok",
  converted: "bg-violet-400",
  archived: "bg-fg-faint",
};

export function BacklogStatusBadge({ status }: { status: BacklogItemStatus }) {
  const { t } = useTranslation();
  return (
    <span className={`${badgeBase} border border-line bg-ink-800/60 px-2 py-0.5 text-fg-muted`}>
      <span aria-hidden className={`size-1.5 rounded-full ${BACKLOG_STATUS_DOT[status]}`} />
      {t(BACKLOG_STATUS_LABEL_KEYS[status])}
    </span>
  );
}

export const BACKLOG_RISK_LABEL_KEYS: Record<BacklogRisk, string> = {
  low: "badges:backlogRisk.low",
  medium: "badges:backlogRisk.medium",
  high: "badges:backlogRisk.high",
};

const BACKLOG_RISK_CLASS: Record<BacklogRisk, string> = {
  low: "text-fg-muted border-line-strong",
  medium: "text-signal border-signal-dim/40",
  high: "text-danger border-danger/30",
};

/** Livello di rischio stimato di una voce del backlog: chip colorato per livello. */
export function BacklogRiskBadge({ risk }: { risk: BacklogRisk }) {
  const { t } = useTranslation();
  return (
    <span className={`${badgeBase} border px-2 py-0.5 ${BACKLOG_RISK_CLASS[risk]}`}>
      {t(BACKLOG_RISK_LABEL_KEYS[risk])}
    </span>
  );
}

/**
 * Stima di effort (1–5) di una voce del backlog: chip "E{n}" con l'etichetta
 * scalare (Banale…Molto grande) nel title. Riusa le label `badges:effort.*`
 * condivise col triage dei ticket.
 */
export function BacklogEffortBadge({ effort }: { effort: number }) {
  const { t } = useTranslation();
  const label = t(`badges:effort.${effort}`);
  return (
    <span
      className={`${badgeBase} border border-line-strong px-2 py-0.5 text-fg-muted`}
      title={t("badges:effortTitle", { label, value: effort })}
    >
      E{effort}
    </span>
  );
}

/** Chiave i18n dell'etichetta di ogni stato PR per-repo (Fase 3, fix multi-repo). */
export const PR_STATE_LABEL_KEYS: Record<PrState, string> = {
  open: "badges:prState.open",
  merged: "badges:prState.merged",
  closed_unmerged: "badges:prState.closed_unmerged",
};

const PR_STATE_CLASS: Record<PrState, string> = {
  open: "text-signal border-signal-dim/40",
  merged: "text-ok border-ok/30",
  closed_unmerged: "text-danger border-danger/30",
};

/** Stato della PR aperta dal fix su un repo del ticket: chip colorato per stato. */
export function PrStateBadge({ state }: { state: PrState }) {
  const { t } = useTranslation();
  return (
    <span className={`${badgeBase} border px-2 py-0.5 ${PR_STATE_CLASS[state]}`}>
      {t(PR_STATE_LABEL_KEYS[state])}
    </span>
  );
}

/**
 * Vocabolario "in parole" dello stato di un job AI (fase 7, Task 8): lo
 * stesso `WorkState` che `workStateFor` (`@stubwise/shared`) già usava solo
 * nell'app mobile — qui il web lo adotta, invece di mostrare i nomi interni
 * della coda (`triaging`, `pr_opened`…). Le chiavi i18n sono PORTATE da
 * `apps/mobile/src/i18n/{en,it}.json` (`work.status.*`), stesso testo, stessi
 * nomi di chiave: un domani un cambio di vocabolario si fa in un posto,
 * verificato dalla parità di `apps/web/src/i18n/parity.test.ts`.
 *
 * `Record` esaustivo sull'enum, non uno `switch`: uno `WorkState` nuovo (cioè
 * un `AiJobStatus` nuovo, dato che `workStateFor` è totale) fa fallire la
 * COMPILAZIONE qui invece di scivolare in un fallback silenzioso.
 *
 * I chiamanti passano già `workStateFor(job.status)`: questo file non importa
 * `AiJobStatus` apposta, la classificazione resta un'unica funzione pura in
 * `@stubwise/shared`, non ridichiarata qui.
 */
export const WORK_STATE_LABEL_KEYS: Record<WorkState, string> = {
  proposed: "workState:proposed",
  planning: "workState:planning",
  working: "workState:working",
  held: "workState:held",
  waiting_answer: "workState:waitingAnswer",
  waiting_approval: "workState:waitingApproval",
  pr_ready: "workState:prReady",
  done: "workState:done",
  failed: "workState:failed",
  skipped: "workState:skipped",
  rejected: "workState:rejected",
};

/** Colore-testo per stato del lavoro. */
export const WORK_STATE_TEXT_CLASS: Record<WorkState, string> = {
  proposed: "text-fg-muted",
  planning: "text-sky-400",
  working: "text-sky-400",
  held: "text-signal",
  waiting_answer: "text-signal",
  waiting_approval: "text-signal",
  pr_ready: "text-ok",
  done: "text-ok",
  failed: "text-danger",
  skipped: "text-fg-faint",
  rejected: "text-fg-faint",
};

/** Colore-stato per il pallino della rotaia della timeline (`ai-job-timeline.tsx`). */
export const WORK_STATE_DOT_CLASS: Record<WorkState, string> = {
  proposed: "bg-fg-faint",
  planning: "bg-sky-400 animate-blink",
  working: "bg-sky-400 animate-blink",
  held: "bg-signal",
  // In attesa della risposta a una domanda: il job è vivo e riparte da solo
  // appena qualcuno risponde — il pallino PULSA, a differenza degli altri
  // stati d'attesa (fermi finché qualcuno non agisce).
  waiting_answer: "bg-signal animate-blink",
  waiting_approval: "bg-signal",
  pr_ready: "bg-ok",
  done: "bg-ok",
  failed: "bg-danger",
  skipped: "bg-fg-faint",
  // PR chiusa senza merge: esito terminale negativo, ma non un errore di
  // sistema come "failed" → neutro spento.
  rejected: "bg-fg-faint",
};
