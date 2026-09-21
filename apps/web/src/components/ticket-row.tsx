import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type { TicketListItem } from "../lib/api";
import { formatRelativeTime } from "../lib/format";
import { PriorityBadge, SourceBadge, StatusBadge, TypeBadge } from "./badges";

interface TicketRowProps {
  ticket: TicketListItem;
  /** Nome del progetto risolto dal chiamante (la lista ha già i progetti). */
  projectName: string;
}

/**
 * Riga della lista ticket: tutta cliccabile verso il dettaglio. Numero e
 * metadati in mono, titolo in sans; i badge raccontano stato/tipo/priorità
 * a colpo d'occhio. Se il fix ha toccato dei repository, un badge mostra il
 * numero di repo/PR del ticket (Fase 3, fix multi-repo).
 */
export function TicketRow({ ticket, projectName }: TicketRowProps) {
  const { t } = useTranslation();

  return (
    <Link
      to="/tickets/$id"
      params={{ id: ticket.id }}
      className="group grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-x-4 gap-y-1 border-b border-line px-4 py-3 transition-colors last:border-b-0 hover:bg-ink-850 sm:grid-cols-[4.5rem_minmax(0,1fr)_auto]"
    >
      <span className="font-mono text-[12px] text-fg-faint transition-colors group-hover:text-signal">
        #{ticket.number}
      </span>

      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-fg">{ticket.title}</span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px] text-fg-faint">
          <span className="text-fg-muted">{projectName}</span>
          {ticket.repositoryCount > 0 && (
            <span
              className="rounded-sm border border-line bg-ink-850 px-1.5 text-fg-muted"
              title={t("tickets:row.repositoryCount", { count: ticket.repositoryCount })}
            >
              {t("tickets:row.repositoryCountBadge", { count: ticket.repositoryCount })}
            </span>
          )}
          <SourceBadge source={ticket.source} />
          {ticket.occurrences > 1 && (
            <span className="text-signal" title={t("tickets:row.occurrences")}>
              ×{ticket.occurrences}
            </span>
          )}
          {ticket.labels.map((label) => (
            <span key={label} className="rounded-sm border border-line px-1.5 text-fg-muted">
              {label}
            </span>
          ))}
        </span>
      </span>

      <span className="col-start-2 flex flex-wrap items-center gap-3 sm:col-start-3 sm:justify-end">
        <TypeBadge type={ticket.type} />
        <PriorityBadge priority={ticket.priority} />
        <StatusBadge status={ticket.status} />
        {/*
          ⚠️ `updatedAt`, non `createdAt` (21 set 2026). Questa riga mostrava
          l'ETÀ del ticket, ed è peggio del non mostrare niente: se non dicesse
          nulla chi guarda saprebbe di non sapere, così invece SEMBRA dire
          l'ultima attività. Un ticket aperto due mesi fa e lavorato ieri
          leggeva «2 mesi fa» e pareva fermo. In un elenco che serve a decidere
          su cosa lavorare, la domanda è «da quanto non si muove», non «quanti
          anni ha». Il `title` porta la data per esteso, per chi vuole il dato
          esatto.
        */}
        <time
          dateTime={ticket.updatedAt}
          title={ticket.updatedAt}
          className="w-16 text-right font-mono text-[11px] text-fg-faint"
        >
          {formatRelativeTime(ticket.updatedAt)}
        </time>
      </span>
    </Link>
  );
}
