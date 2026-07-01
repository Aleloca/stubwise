import {
  ticketPrioritySchema,
  ticketStatusSchema,
  ticketTypeSchema,
} from "@stubwise/shared";
import {
  useQueryClient,
  useSuspenseInfiniteQuery,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { NewTicketDialog } from "../../components/new-ticket-dialog";
import { SavedViews } from "../../components/saved-views";
import { TicketFilters } from "../../components/ticket-filters";
import { TicketRow } from "../../components/ticket-row";
import {
  postTicket,
  type SavedViewFilters,
  type TicketDraft,
  type TicketFilters as TicketFiltersValue,
} from "../../lib/api";
import {
  projectsQueryOptions,
  ticketKeys,
  ticketsInfiniteQueryOptions,
} from "../../lib/queries";

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
  milestoneId: z.uuid().optional().catch(undefined),
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
  const { t } = useTranslation();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);

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

  // Filtri correnti per le viste salvate: i soli search param effettivamente
  // definiti (assenti = chiave omessa, non `undefined`), così la vista salva
  // esattamente la combinazione attiva. `assigneeId` non è un filtro della
  // lista: non compare nello schema dei search param, quindi non è incluso.
  const currentFilters: SavedViewFilters = {
    ...(search.projectId !== undefined && { projectId: search.projectId }),
    ...(search.status !== undefined && { status: search.status }),
    ...(search.type !== undefined && { type: search.type }),
    ...(search.priority !== undefined && { priority: search.priority }),
    ...(search.milestoneId !== undefined && { milestoneId: search.milestoneId }),
    ...(search.q !== undefined && { q: search.q }),
  };

  // Applica una vista riscrivendo ESATTAMENTE i suoi filtri: ogni search param
  // di filtro non presente nella vista viene azzerato (sostituzione completa,
  // non merge), così l'applicazione è "pulita". La lista non ha param
  // non-filtro da preservare; `assigneeId` della vista non ha un controllo
  // corrispondente e viene ignorato.
  function handleApply(filters: SavedViewFilters) {
    void navigate({
      search: {
        projectId: filters.projectId,
        status: filters.status,
        type: filters.type,
        priority: filters.priority,
        milestoneId: filters.milestoneId,
        q: filters.q,
      },
      replace: true,
    });
  }

  async function handleCreate(draft: TicketDraft) {
    await postTicket(draft);
    // Liste e board mostrano subito il nuovo ticket; await sulle liste così
    // alla chiusura del dialog la riga è già lì.
    await queryClient.invalidateQueries({ queryKey: ticketKeys.lists() });
    void queryClient.invalidateQueries({ queryKey: ticketKeys.boards() });
    setCreating(false);
  }

  return (
    <div className="page">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-4">
        <div>
          <h1 className="text-xl font-semibold">{t("tickets:list.title")}</h1>
          <p className="mt-1 text-sm text-fg-muted">{t("tickets:list.subtitle")}</p>
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          disabled={projects.length === 0}
          title={projects.length === 0 ? t("tickets:list.createProjectFirst") : undefined}
          className="rounded-sm bg-signal px-4 py-2 font-mono text-[12px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright active:bg-signal-dim disabled:cursor-not-allowed disabled:bg-signal-dim disabled:opacity-60"
        >
          {t("tickets:list.newTicket")}
        </button>
      </header>

      {creating && (
        <NewTicketDialog
          projects={projects}
          onSubmit={handleCreate}
          onClose={() => setCreating(false)}
        />
      )}

      <div className="mt-6">
        <TicketFilters value={search} projects={projects} onChange={handleFiltersChange} />
      </div>

      <div className="mt-4">
        <SavedViews currentFilters={currentFilters} onApply={handleApply} />
      </div>

      {tickets.length === 0 ? (
        <div className="mt-6 grid place-items-center rounded-sm border border-dashed border-line-strong py-24">
          <p className="font-mono text-[12px] tracking-[0.18em] text-fg-faint uppercase">
            {t("tickets:list.empty")}
          </p>
          <p className="mt-2 text-sm text-fg-muted">{t("tickets:list.emptyHint")}</p>
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
                {isFetchingNextPage ? t("tickets:list.loadingMore") : t("tickets:list.loadMore")}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
