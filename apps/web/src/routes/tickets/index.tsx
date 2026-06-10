import {
  ticketPrioritySchema,
  ticketStatusSchema,
  ticketTypeSchema,
} from "@stubwise/shared";
import { useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { z } from "zod";
import { TicketFilters } from "../../components/ticket-filters";
import { TicketRow } from "../../components/ticket-row";
import type { TicketFilters as TicketFiltersValue } from "../../lib/api";
import { projectsQueryOptions, ticketsInfiniteQueryOptions } from "../../lib/queries";

/**
 * Search param della lista: ogni filtro è opzionale e validato contro gli
 * enum di dominio. `.catch(undefined)` scarta i valori malformati di un URL
 * scritto a mano invece di mandare la route in errore.
 */
export const ticketSearchSchema = z.object({
  projectId: z.uuid().optional().catch(undefined),
  status: ticketStatusSchema.optional().catch(undefined),
  type: ticketTypeSchema.optional().catch(undefined),
  priority: ticketPrioritySchema.optional().catch(undefined),
  q: z.string().min(1).optional().catch(undefined),
});

export type TicketSearch = z.infer<typeof ticketSearchSchema>;

// L'id della route include il layout autenticato (id "authed").
const route = getRouteApi("/authed/tickets");

/**
 * Lista dei ticket. Lo stato dei filtri vive interamente nell'URL: la pagina
 * legge i search param, ogni modifica naviga (replace) e il loader della
 * route ha già messo in cache la prima pagina per quei filtri.
 */
export function TicketsPage() {
  const search = route.useSearch();
  const navigate = route.useNavigate();

  const { data: projects } = useSuspenseQuery(projectsQueryOptions);
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = useSuspenseInfiniteQuery(
    ticketsInfiniteQueryOptions(search),
  );

  const tickets = data.pages.flatMap((page) => page.items);
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));

  function handleFiltersChange(patch: Partial<TicketFiltersValue>) {
    void navigate({
      search: (prev) => ({ ...prev, ...patch }),
      // I filtri non devono intasare la history: avanti/indietro naviga tra
      // pagine, non tra ogni combinazione di filtri provata.
      replace: true,
    });
  }

  return (
    <div className="p-8">
      <header className="border-b border-line pb-4">
        <h1 className="text-xl font-semibold">Tickets</h1>
        <p className="mt-1 text-sm text-fg-muted">
          Tutti i ticket dei tuoi progetti, dal più recente.
        </p>
      </header>

      <div className="mt-6">
        <TicketFilters value={search} projects={projects} onChange={handleFiltersChange} />
      </div>

      {tickets.length === 0 ? (
        <div className="mt-6 grid place-items-center rounded-sm border border-dashed border-line-strong py-24">
          <p className="font-mono text-[12px] tracking-[0.18em] text-fg-faint uppercase">
            // nessun ticket trovato
          </p>
          <p className="mt-2 text-sm text-fg-muted">
            Prova ad allargare i filtri o a cambiare il termine di ricerca.
          </p>
        </div>
      ) : (
        <div className="mt-6 rounded-sm border border-line bg-ink-900">
          {tickets.map((ticket) => (
            <TicketRow
              key={ticket.id}
              ticket={ticket}
              projectName={projectNames.get(ticket.projectId) ?? "—"}
            />
          ))}

          {hasNextPage && (
            <div className="grid place-items-center py-4">
              <button
                type="button"
                onClick={() => void fetchNextPage()}
                disabled={isFetchingNextPage}
                className="rounded-sm border border-line-strong px-4 py-1.5 font-mono text-[11px] tracking-[0.12em] text-fg-muted uppercase transition-colors hover:border-signal-dim hover:text-fg disabled:opacity-50"
              >
                {isFetchingNextPage ? "Carico…" : "Carica altri"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
