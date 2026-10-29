import { useTranslation } from "react-i18next";
import type { TaskSource } from "../data/types";

// Da dove è arrivata una task: un segno disegnato per ogni origine e la
// parola accanto (mai il solo segno), e «×N» quando la stessa segnalazione è
// arrivata più volte. D'inchiostro: l'origine non è uno stato né un reparto.

const PATHS: Record<TaskSource, string> = {
  // Matita.
  manual: "M10.5 3.5 12.5 5.5 6 12H4v-2l6.5-6.5Z",
  // Parentesi del codice.
  sdk: "M6 4.5 2.75 8 6 11.5M10 4.5 13.25 8 10 11.5",
  // Due frecce: domanda e risposta.
  api: "M3 6h9.5M10 3.5 12.5 6 10 8.5M13 10H3.5M6 7.5 3.5 10 6 12.5",
  // Cancelletto dei canali.
  slack: "M6.25 2.75 5 13.25M11 2.75 9.75 13.25M3 6h10.5M2.5 10H13",
  // Gancio.
  webhook:
    "M6.5 9.25 4.6 12.5M4.6 12.5a1.75 1.75 0 1 1 0-.01M8 5.25a1.75 1.75 0 1 1 1.5 1.73L11.4 10.25M11.4 10.25a1.75 1.75 0 1 1 0 .01M9.75 12h-4",
  // Fumetto della chat.
  widget: "M3 3.5h10v7H7.25L4.5 13v-2.5H3z",
  // Busta.
  email: "M2.75 4.25h10.5v7.5H2.75zM2.75 4.75 8 8.75l5.25-4",
  // Fulmine dell'automazione.
  automation: "M9 2.25 4 9h3.5L7 13.75 12 7H8.5L9 2.25Z",
  // Server a due cassetti (area 8b: l'analisi di un server).
  server: "M3 3h10v4.25H3zM3 8.75h10V13H3zM5.25 5.1h.01M5.25 10.9h.01",
};

export function SourceIcon({ source }: { source: TaskSource }) {
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
      data-source-icon={source}
      className="shrink-0"
    >
      <path d={PATHS[source]} />
    </svg>
  );
}

/** «SDK ×12»: segno, parola e, se è arrivata più volte, quante (detto per intero nel `title`). */
export function SourceMark({
  source,
  occurrences,
  serverCode,
}: {
  source: TaskSource;
  occurrences: number;
  /** Una task di server: da quale server è nata (lo dice il `title`). */
  serverCode?: string | undefined;
}) {
  const { t } = useTranslation();
  const name = t(`taskDetail.source.kinds.${source}`);
  const times = t("taskDetail.source.occurrences", { count: occurrences });
  const title =
    source === "server" && serverCode
      ? t("taskDetail.source.serverTitle", { code: serverCode })
      : undefined;
  return (
    <span
      data-source={source}
      title={title}
      className="flex min-w-0 items-center gap-1.5 text-sm text-ink"
    >
      <SourceIcon source={source} />
      <span className="truncate">{name}</span>
      {occurrences > 1 && (
        <span title={times} className="num shrink-0 text-ink-muted">
          <span aria-hidden="true">×{occurrences}</span>
          <span className="sr-only">{times}</span>
        </span>
      )}
    </span>
  );
}
