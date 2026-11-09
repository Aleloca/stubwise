import { useTranslation } from "react-i18next";
import type { ProjectStatus, StatusFamily } from "../data/types";

const FAMILY_TONE: Record<StatusFamily, string> = {
  todo: "text-ink-faint",
  active: "text-ink",
  closed: "text-positive",
};

/**
 * Il segno della famiglia di stato, disegnato: cerchio vuoto (da fare),
 * mezzo pieno (in corso), cerchio con la spunta (chiusa). È la FORMA a
 * distinguere le famiglie; il tono (verde solo per «chiusa») viene dopo.
 */
export function FamilySign({ family }: { family: StatusFamily }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      aria-hidden="true"
      focusable="false"
      className={`shrink-0 ${FAMILY_TONE[family]}`}
    >
      <circle cx="8" cy="8" r="6" />
      {family === "active" && <path d="M8 2a6 6 0 0 0 0 12z" fill="currentColor" stroke="none" />}
      {family === "closed" && (
        <path d="m5.2 8.2 2 2 3.6-4" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}

/**
 * Lo stato di una task: segno della famiglia + nome dello stato del progetto
 * (fino a ~22 caratteri, con ellissi e nome intero nel `title`). `compact`
 * lascia il solo segno, col nome per i lettori di schermo e nel `title`:
 * serve quando la riga è stretta (pannello aperto a 1200 px).
 */
export function StatusLabel({
  status,
  compact = false,
  nameClassName = "",
}: {
  status: ProjectStatus | undefined;
  compact?: boolean;
  /** Classi del nome, es. per nasconderlo sotto una certa larghezza della riga. */
  nameClassName?: string;
}) {
  const { t } = useTranslation();
  if (!status) return null;
  return (
    <span
      data-status-family={status.family}
      title={t("taskUi.status", { name: status.name })}
      className="flex min-w-0 items-center gap-1.5 text-sm text-ink-muted"
    >
      <FamilySign family={status.family} />
      <span className={compact ? "sr-only" : `truncate ${nameClassName}`}>{status.name}</span>
    </span>
  );
}
