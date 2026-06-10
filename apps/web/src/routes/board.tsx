import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ticketStatusSchema, type TicketStatus } from "@stubwise/shared";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useCallback } from "react";
import { z } from "zod";
import { PriorityBadge, STATUS_DOT, STATUS_LABELS, TypeBadge } from "../components/badges";
import { patchTicket, type Ticket } from "../lib/api";
import { boardTicketsQueryOptions, projectsQueryOptions, ticketKeys } from "../lib/queries";

/**
 * Board kanban: una colonna per stato del ciclo di vita, drag-and-drop con
 * dnd-kit per cambiare stato. Snapshot a pagina singola (vedi
 * BOARD_TICKETS_LIMIT in queries.ts), filtrabile per progetto via URL.
 */

/** Search param della board: solo il progetto, validato come la lista. */
export const boardSearchSchema = z.object({
  projectId: z.uuid().optional().catch(undefined),
});

/** Colonne nell'ordine del ciclo di vita: open → … → closed. */
const BOARD_STATUSES = ticketStatusSchema.options;

interface MoveVariables {
  ticketId: string;
  toStatus: TicketStatus;
}

/**
 * Handler dello spostamento, invocato da `onDragEnd` ma testabile da solo
 * (la simulazione completa del drag in DOM finto è inaffidabile).
 *
 * Pattern ottimistico canonico onMutate/onError/onSettled, diverso dal
 * dettaglio (che aggiorna la cache solo in onSuccess): un drag ha bisogno di
 * feedback istantaneo — la card deve atterrare nella colonna di destinazione
 * al rilascio, non quando il server risponde — quindi serve lo snapshot per
 * il rollback se la PATCH fallisce.
 */
export function useMoveTicket(projectId?: string) {
  const queryClient = useQueryClient();
  const boardKey = ticketKeys.board(projectId);

  const mutation = useMutation({
    mutationFn: ({ ticketId, toStatus }: MoveVariables) =>
      patchTicket(ticketId, { status: toStatus }),
    onMutate: async ({ ticketId, toStatus }) => {
      // Un refetch in volo risolverebbe DOPO il setQueryData ottimistico,
      // sovrascrivendolo con dati stantii: prima si cancella.
      await queryClient.cancelQueries({ queryKey: boardKey });
      const previous = queryClient.getQueryData<Ticket[]>(boardKey);
      queryClient.setQueryData<Ticket[]>(boardKey, (tickets) =>
        tickets?.map((ticket) =>
          ticket.id === ticketId ? { ...ticket, status: toStatus } : ticket,
        ),
      );
      return { previous };
    },
    onError: (_error, _variables, context) => {
      // Rollback: la card torna nella colonna di partenza.
      if (context?.previous) queryClient.setQueryData(boardKey, context.previous);
    },
    onSettled: (_data, _error, { ticketId }) => {
      // Successo o errore, la verità torna al server: board, liste filtrate
      // e dettaglio del ticket spostato sono da riconciliare.
      void queryClient.invalidateQueries({ queryKey: boardKey });
      void queryClient.invalidateQueries({ queryKey: ticketKeys.lists() });
      void queryClient.invalidateQueries({ queryKey: ticketKeys.detail(ticketId) });
    },
  });

  const { mutate } = mutation;
  const moveTicket = useCallback(
    (ticketId: string, toStatus: TicketStatus) => {
      const tickets = queryClient.getQueryData<Ticket[]>(boardKey);
      const ticket = tickets?.find((candidate) => candidate.id === ticketId);
      // Rilascio nella colonna di partenza (o ticket sparito): nessuna PATCH.
      if (!ticket || ticket.status === toStatus) return;
      mutate({ ticketId, toStatus });
    },
    // boardKey è ricreata a ogni render ma stabile nel contenuto: nelle
    // dipendenze va la sola parte variabile per non invalidare la callback.
    [queryClient, projectId, mutate],
  );

  return {
    moveTicket,
    isPending: mutation.isPending,
    isError: mutation.isError,
    error: mutation.error,
    reset: mutation.reset,
  };
}

// L'id della route include il layout autenticato (id "authed").
const route = getRouteApi("/authed/board");

export function BoardPage() {
  const search = route.useSearch();
  const navigate = route.useNavigate();

  const { data: projects } = useSuspenseQuery(projectsQueryOptions);
  const { data: tickets } = useSuspenseQuery(boardTicketsQueryOptions(search.projectId));
  const { moveTicket, isError, error, reset } = useMoveTicket(search.projectId);

  // Distanza di attivazione 8px: sotto è un click (apre il dettaglio), sopra
  // è un drag. Superata la soglia dnd-kit sopprime il click successivo, i due
  // gesti non si pestano i piedi. Da tastiera: Space prende/posa la card (con
  // le coordinate sortable per muoversi tra colonne), Enter resta libero per
  // aprire il dettaglio.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter"] },
    }),
  );

  const byStatus = new Map<TicketStatus, Ticket[]>(
    BOARD_STATUSES.map((status) => [status, []]),
  );
  for (const ticket of tickets) byStatus.get(ticket.status)?.push(ticket);

  function handleDragEnd({ active, over }: DragEndEvent) {
    if (!over) return;
    // `over` può essere la colonna (id = stato) o una card (lo stato viaggia
    // nei suoi data): in entrambi i casi si risale allo stato di destinazione.
    const overStatus = (over.data.current?.status ?? over.id) as string;
    const toStatus = ticketStatusSchema.safeParse(overStatus);
    if (!toStatus.success) return;
    moveTicket(String(active.id), toStatus.data);
  }

  function openTicket(id: string) {
    void navigate({ to: "/tickets/$id", params: { id } });
  }

  return (
    <div className="flex h-screen flex-col p-8">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-4">
        <div>
          <h1 className="text-xl font-semibold">Board</h1>
          <p className="mt-1 text-sm text-fg-muted">
            Trascina le card tra le colonne per cambiare stato. Da tastiera: Spazio prende e
            posa, frecce per muoversi, Invio apre il dettaglio.
          </p>
        </div>

        <div className="flex flex-col gap-1">
          <label
            htmlFor="board-project"
            className="font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase"
          >
            Progetto
          </label>
          <select
            id="board-project"
            value={search.projectId ?? ""}
            onChange={(event) =>
              void navigate({
                search: { projectId: event.target.value || undefined },
                replace: true,
              })
            }
            className="rounded-sm border border-line-strong bg-ink-950/70 px-2 py-1.5 font-mono text-[12px] text-fg transition-colors hover:border-ink-700 focus-visible:border-signal-dim"
          >
            <option value="">Tutti</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>
      </header>

      {isError && (
        <div
          role="alert"
          className="mt-4 flex items-baseline justify-between gap-4 rounded-sm border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-[13px] text-danger"
        >
          <span>Spostamento non riuscito: {error?.message}. La card è tornata al suo posto.</span>
          <button
            type="button"
            onClick={reset}
            className="shrink-0 text-[11px] tracking-[0.12em] uppercase underline underline-offset-2 hover:text-fg"
          >
            Chiudi
          </button>
        </div>
      )}

      <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={handleDragEnd}>
        <div className="mt-6 grid min-h-0 flex-1 auto-cols-[minmax(15rem,1fr)] grid-flow-col gap-3 overflow-x-auto pb-2">
          {BOARD_STATUSES.map((status) => (
            <BoardColumn
              key={status}
              status={status}
              tickets={byStatus.get(status) ?? []}
              onOpen={openTicket}
            />
          ))}
        </div>
      </DndContext>
    </div>
  );
}

interface BoardColumnProps {
  status: TicketStatus;
  tickets: Ticket[];
  onOpen: (id: string) => void;
}

function BoardColumn({ status, tickets, onOpen }: BoardColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: status });

  return (
    <section
      ref={setNodeRef}
      aria-label={`${STATUS_LABELS[status]}: ${tickets.length} ticket`}
      className={`flex min-h-0 flex-col rounded-sm border bg-ink-900 transition-colors ${
        isOver ? "border-signal-dim bg-ink-850" : "border-line"
      }`}
    >
      <header className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <span aria-hidden className={`size-1.5 rounded-full ${STATUS_DOT[status]}`} />
        <h2 className="font-mono text-[11px] font-medium tracking-[0.14em] text-fg-muted uppercase">
          {STATUS_LABELS[status]}
        </h2>
        <span aria-hidden className="ml-auto font-mono text-[11px] text-fg-faint">
          {tickets.length}
        </span>
      </header>

      <SortableContext
        items={tickets.map((ticket) => ticket.id)}
        strategy={verticalListSortingStrategy}
      >
        <ul className="flex min-h-16 flex-1 flex-col gap-2 overflow-y-auto p-2">
          {tickets.map((ticket) => (
            <BoardCard key={ticket.id} ticket={ticket} onOpen={() => onOpen(ticket.id)} />
          ))}
          {tickets.length === 0 && (
            <li className="grid flex-1 place-items-center rounded-sm border border-dashed border-line py-6">
              <span className="font-mono text-[11px] tracking-[0.14em] text-fg-faint uppercase">
                Nessun ticket
              </span>
            </li>
          )}
        </ul>
      </SortableContext>
    </section>
  );
}

interface BoardCardProps {
  ticket: Ticket;
  onOpen: () => void;
}

function BoardCard({ ticket, onOpen }: BoardCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: ticket.id,
    // Lo stato viaggia con la card: onDragEnd lo legge quando si rilascia
    // sopra un'altra card invece che sulla colonna.
    data: { status: ticket.status },
    attributes: { roleDescription: "Card trascinabile" },
  });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
      onClick={onOpen}
      onKeyDown={(event) => {
        // Lo spread di `listeners` mette qui sopra l'attivatore tastiera del
        // sensore (Space): lo si richiama a mano per non perderlo, e Invio —
        // libero, vedi keyboardCodes — apre il dettaglio se non c'è un drag.
        listeners?.onKeyDown?.(event);
        if (event.key === "Enter" && !isDragging && !event.defaultPrevented) onOpen();
      }}
      className={`cursor-grab rounded-sm border bg-ink-850 p-3 transition-colors ${
        isDragging
          ? "z-10 cursor-grabbing border-signal-dim opacity-90 shadow-[0_8px_24px_rgba(0,0,0,0.5)]"
          : "border-line hover:border-line-strong hover:bg-ink-800"
      }`}
    >
      <div className="flex items-baseline gap-2 font-mono text-[12px]">
        <span className="text-fg-faint">#{ticket.number}</span>
        {ticket.occurrences > 1 && (
          <span className="text-signal" title="Occorrenze deduplicate">
            ×{ticket.occurrences}
          </span>
        )}
      </div>
      <p className="mt-1 line-clamp-2 text-sm font-medium text-fg">{ticket.title}</p>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <TypeBadge type={ticket.type} />
        <PriorityBadge priority={ticket.priority} />
      </div>
    </li>
  );
}
