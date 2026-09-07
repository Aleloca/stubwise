import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type { ProjectTimelineEntry } from "../lib/api";
import { formatDate, formatDateTime } from "../lib/format";

/**
 * LA TIMELINE DI PROGETTO, sola lettura (Fase 5).
 *
 * Il racconto è raggruppato per SETTIMANA e non per giorno: un progetto reale
 * ha giorni vuoti, e un elenco di date senza eventi racconta le pause meglio di
 * quanto racconti il lavoro. La settimana è l'unità in cui una persona pensa
 * "cosa è successo", ed è anche il periodo del brief — che infatti qui compare
 * come SEPARATORE dentro il gruppo, non come una riga fra le altre.
 *
 * Componente puramente presentazionale: niente fetch, niente stato. Chi lo usa
 * (la pagina Roadmap) decide finestra e filtri.
 */

/**
 * Il lunedì della settimana a cui un istante appartiene, in `YYYY-MM-DD`.
 *
 * ⚠️ `getDay()` dà 0 per DOMENICA: senza la correzione una domenica finirebbe
 * nel gruppo della settimana successiva, che è esattamente il bug che chi legge
 * la pagina noterebbe per primo ("il rilascio di domenica è nella settimana
 * dopo"). Esportata perché è la sola regola non ovvia del componente, e un test
 * la sorveglia da sé.
 */
export function weekStart(iso: string): string {
  const date = new Date(iso);
  const day = date.getUTCDay();
  const offset = day === 0 ? 6 : day - 1;
  const monday = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - offset),
  );
  return monday.toISOString().slice(0, 10);
}

/** L'etichetta i18n del tipo di voce: il "cosa è successo" in due parole. */
function entryLabel(kind: ProjectTimelineEntry["kind"]): string {
  const keys: Record<ProjectTimelineEntry["kind"], string> = {
    ticket_opened: "ticketOpened",
    ticket_done: "ticketDone",
    milestone_due: "milestoneDue",
    milestone_closed: "milestoneClosed",
    pr_opened: "prOpened",
    pr_merged: "prMerged",
    pr_closed: "prClosed",
    report_day: "reportDay",
    decision: "decision",
    brief: "brief",
  };
  return `projects:roadmap.entry.${keys[kind]}`;
}

/** Marcatore colorato a sinistra della riga: dà il tono senza usare parole. */
function accentClass(kind: ProjectTimelineEntry["kind"]): string {
  if (kind === "pr_merged" || kind === "ticket_done" || kind === "milestone_closed") {
    return "bg-ok";
  }
  if (kind === "pr_closed") return "bg-danger";
  if (kind === "decision") return "bg-signal";
  return "bg-line-strong";
}

function TimelineRow({ entry }: { entry: ProjectTimelineEntry }) {
  const { t } = useTranslation();
  return (
    <li className="flex gap-3 py-2">
      <span
        aria-hidden="true"
        className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${accentClass(entry.kind)}`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-mono text-[10px] tracking-[0.1em] text-fg-faint uppercase">
            {t(entryLabel(entry.kind))}
          </span>
          <time dateTime={entry.at} className="font-mono text-[11px] text-fg-faint">
            {formatDateTime(entry.at)}
          </time>
        </div>
        <TimelineBody entry={entry} />
      </div>
    </li>
  );
}

/** Il corpo della riga, diverso per ogni tipo di voce. */
function TimelineBody({ entry }: { entry: ProjectTimelineEntry }) {
  const { t } = useTranslation();

  switch (entry.kind) {
    case "ticket_opened":
      return (
        <p className="mt-0.5 text-[13px] text-fg">
          <span className="font-mono text-fg-faint">#{entry.ticketNumber}</span> {entry.title}
        </p>
      );
    case "ticket_done":
      return (
        <p className="mt-0.5 text-[13px] text-fg">
          <Link
            to="/tickets/$id"
            params={{ id: entry.ticketId }}
            className="transition-colors hover:text-signal"
          >
            <span className="font-mono text-fg-faint">#{entry.ticketNumber}</span> {entry.title}
          </Link>
        </p>
      );
    case "milestone_due":
    case "milestone_closed":
      return <p className="mt-0.5 text-[13px] text-fg">{entry.name}</p>;
    case "pr_opened":
    case "pr_merged":
    case "pr_closed":
      return (
        <div className="mt-0.5">
          <p className="text-[13px] text-fg">
            <span className="font-mono text-fg-faint">#{entry.ticketNumber}</span>{" "}
            {entry.ticketTitle}
          </p>
          {entry.prSummary !== undefined && (
            <p className="mt-1 border-l-2 border-line-strong pl-3 text-[12px] text-fg-muted">
              {entry.prSummary}
            </p>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            {entry.reviewVerdict !== undefined && (
              <span
                className={`font-mono text-[11px] ${
                  entry.reviewVerdict === "approve" ? "text-ok" : "text-signal"
                }`}
              >
                {t(`projects:roadmap.verdict.${entry.reviewVerdict}`)}
              </span>
            )}
            <a
              href={entry.prUrl}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-[11px] text-fg-faint underline transition-colors hover:text-signal"
            >
              {t("projects:roadmap.openPr")}
            </a>
          </div>
        </div>
      );
    case "report_day":
      return (
        <p className="mt-0.5 text-[13px] text-fg-muted">
          {entry.summary ?? t("projects:roadmap.noSummary")}
        </p>
      );
    case "decision":
      return (
        <div className="mt-0.5">
          <p className="text-[13px] text-fg">{entry.title}</p>
          <p className="mt-1 text-[12px] text-fg-muted">{entry.decision}</p>
          <p className="mt-1 font-mono text-[11px] text-fg-faint">
            {entry.decidedBy === null
              ? t("projects:roadmap.decidedBySystem")
              : t("projects:roadmap.decidedBy", { who: entry.decidedBy.email })}
          </p>
        </div>
      );
    case "brief":
      // Il brief non passa mai di qui: è reso come separatore (vedi sotto).
      return null;
  }
}

/**
 * Il brief settimanale come SEPARATORE: chiude idealmente la settimana con la
 * sua sintesi, invece di stare in coda alle righe come un evento qualsiasi.
 *
 * La `headline` è l'incipit, non il brief: il testo intero sta su `/briefs/$id`
 * (Fase D), e ci si arriva da qui — il link che la Fase C aveva lasciato in
 * sospeso perché la rotta non esisteva ancora. È lo STESSO incipit che si legge
 * nella card d'inbox: le due superfici lo prendono da `briefHeadline`, in un
 * punto solo, perché lo stesso brief non sembri due brief diversi.
 */
function BriefSeparator({
  entry,
}: {
  entry: Extract<ProjectTimelineEntry, { kind: "brief" }>;
}) {
  const { t } = useTranslation();
  return (
    <li
      role="separator"
      className="my-2 rounded-sm border border-line-strong bg-ink-800/40 px-3 py-3"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-[10px] tracking-[0.1em] text-signal uppercase">
          {t("projects:roadmap.entry.brief")}
        </span>
        <span className="font-mono text-[11px] text-fg-faint">
          {t("projects:roadmap.briefPeriod", {
            from: formatDate(`${entry.periodStart}T00:00:00.000Z`),
            to: formatDate(`${entry.periodEnd}T00:00:00.000Z`),
          })}
        </span>
      </div>
      <p className="mt-1 text-[13px] text-fg-muted">
        {entry.headline ?? t("projects:roadmap.noSummary")}
      </p>
      <Link
        to="/briefs/$id"
        params={{ id: entry.id }}
        className="mt-2 inline-block font-mono text-[11px] tracking-[0.08em] text-fg-faint uppercase transition-colors hover:text-signal"
      >
        {t("projects:roadmap.openBrief")}
      </Link>
    </li>
  );
}

export function ProjectTimeline({ entries }: { entries: ProjectTimelineEntry[] }) {
  const { t } = useTranslation();

  if (entries.length === 0) {
    return (
      <div className="rounded-sm border border-line px-4 py-6">
        <p className="text-[13px] text-fg-muted">{t("projects:roadmap.empty")}</p>
        <p className="mt-1 font-mono text-[11px] text-fg-faint">
          {t("projects:roadmap.emptyHint")}
        </p>
      </div>
    );
  }

  // Raggruppamento in ordine di comparsa: le voci arrivano GIÀ ordinate dal
  // server (`at` crescente), quindi una Map preserva l'ordine dei gruppi senza
  // un secondo sort che potrebbe divergere da quello del server.
  const byWeek = new Map<string, ProjectTimelineEntry[]>();
  for (const entry of entries) {
    const week = weekStart(entry.at);
    const bucket = byWeek.get(week);
    if (bucket) bucket.push(entry);
    else byWeek.set(week, [entry]);
  }

  return (
    <div className="flex flex-col gap-6">
      {[...byWeek.entries()].map(([week, weekEntries]) => {
        const label = t("projects:roadmap.weekOf", {
          date: formatDate(`${week}T00:00:00.000Z`),
        });
        return (
        <section key={week} role="group" aria-label={label}>
          <h3 className="border-b border-line pb-1 font-mono text-[11px] tracking-[0.12em] text-fg-faint uppercase">
            {label}
          </h3>
          <ul className="divide-y divide-line/60">
            {weekEntries.map((entry) =>
              entry.kind === "brief" ? (
                <BriefSeparator key={`${entry.kind}:${entry.id}`} entry={entry} />
              ) : (
                <TimelineRow key={`${entry.kind}:${entry.id}`} entry={entry} />
              ),
            )}
          </ul>
        </section>
        );
      })}
    </div>
  );
}
