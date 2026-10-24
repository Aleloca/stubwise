import { useTranslation } from "react-i18next";
import type { ProjectRequest, RequestStatus } from "../../data/types";

// I segni di una richiesta: lo stato e l'urgenza. Lo stato di una richiesta
// non è uno stato di task (non ha famiglia): ha i suoi cinque segni,
// distinti per FORMA, con il nome scritto accanto.

const STATUS_TONE: Record<RequestStatus, string> = {
  new: "text-ink",
  refining: "text-ink",
  ready: "text-ink",
  converted: "text-positive",
  archived: "text-ink-faint",
};

/**
 * Nuova: cerchio col punto al centro. In rifinitura: cerchio tratteggiato
 * (il tratteggio è il segno di Claude al lavoro). Pronta: cerchio pieno.
 * Trasformata: cerchio con la freccia (è diventata una task). Archiviata:
 * la scatola.
 */
export function RequestStatusSign({ status }: { status: RequestStatus }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-request-sign={status}
      className={`shrink-0 ${STATUS_TONE[status]}`}
    >
      {status === "new" && (
        <>
          <circle cx="8" cy="8" r="6" />
          <circle cx="8" cy="8" r="2" fill="currentColor" stroke="none" />
        </>
      )}
      {status === "refining" && <circle cx="8" cy="8" r="6" strokeDasharray="2.6 2.1" />}
      {status === "ready" && <circle cx="8" cy="8" r="6" fill="currentColor" />}
      {status === "converted" && (
        <>
          <circle cx="8" cy="8" r="6" />
          <path d="M5.25 8h5.25M8.5 5.75 10.75 8 8.5 10.25" />
        </>
      )}
      {status === "archived" && (
        <>
          <rect x="2.5" y="3.5" width="11" height="3" rx="0.75" />
          <path d="M3.5 6.5v5.25c0 .41.34.75.75.75h7.5c.41 0 .75-.34.75-.75V6.5M6.5 9h3" />
        </>
      )}
    </svg>
  );
}

/** Lo stato di una richiesta: segno + nome. `compact` lascia il segno, col nome per i lettori di schermo. */
export function RequestStatusLabel({
  status,
  compact = false,
  nameClassName = "",
}: {
  status: RequestStatus;
  compact?: boolean;
  nameClassName?: string;
}) {
  const { t } = useTranslation();
  const name = t(`requests.status.${status}`);
  return (
    <span
      data-request-status={status}
      title={t("requests.statusLabel", { name })}
      className="flex min-w-0 items-center gap-1.5 text-sm text-ink-muted"
    >
      <RequestStatusSign status={status} />
      <span className={compact ? "sr-only" : `truncate ${nameClassName}`}>{name}</span>
    </span>
  );
}

const LEVEL: Record<ProjectRequest["urgency"], number> = { low: 1, medium: 2, high: 3 };

/** L'urgenza: tre barre crescenti, piene quante il livello, e la parola accanto. */
export function UrgencyMark({
  urgency,
  nameClassName = "",
}: {
  urgency: ProjectRequest["urgency"];
  nameClassName?: string;
}) {
  const { t } = useTranslation();
  const name = t(`requests.urgency.${urgency}`);
  const level = LEVEL[urgency];
  return (
    <span
      data-urgency={urgency}
      title={t("requests.urgency.aria", { name })}
      className="flex min-w-0 items-center gap-1.5 text-sm text-ink-muted"
    >
      <svg viewBox="0 0 12 12" width={12} height={12} aria-hidden="true" focusable="false" className="shrink-0">
        {[0, 1, 2].map((i) => (
          <rect
            key={i}
            x={i * 4.25}
            y={8 - i * 3}
            width={3}
            height={4 + i * 3}
            rx={0.75}
            className={i < level ? "fill-ink" : "fill-ink/20"}
          />
        ))}
      </svg>
      <span className="sr-only">{t("requests.urgency.prefix")} </span>
      <span className={`truncate ${nameClassName}`}>{name}</span>
    </span>
  );
}
