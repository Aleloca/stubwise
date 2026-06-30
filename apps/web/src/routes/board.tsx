import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
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
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { PriorityBadge, STATUS_DOT, STATUS_LABEL_KEYS, TypeBadge } from "../components/badges";
import { patchTicket, type Ticket } from "../lib/api";
import {
  BOARD_TICKETS_LIMIT,
  boardTicketsQueryOptions,
  projectsQueryOptions,
  repositoriesQueryOptions,
  ticketKeys,
} from "../lib/queries";

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
      // La chiave viaggia nel context insieme allo snapshot: TanStack
      // aggiorna le opzioni della mutation pendente a ogni re-render, quindi
      // se il filtro progetto cambia con la PATCH in volo, leggere `boardKey`
      // dallo scope di render in onError/onSettled colpirebbe la board
      // SBAGLIATA (corruzione cross-progetto).
      return { previous, boardKey };
    },
    onError: (_error, _variables, context) => {
      // Rollback sulla chiave catturata alla mutate: la card torna nella
      // colonna di partenza della board originale.
      if (context?.previous) queryClient.setQueryData(context.boardKey, context.previous);
    },
    onSettled: (_data, _error, { ticketId }, context) => {
      // Successo o errore, la verità torna al server: board, liste filtrate
      // e dettaglio del ticket spostato sono da riconciliare.
      void queryClient.invalidateQueries({ queryKey: context?.boardKey ?? boardKey });
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
  const { t } = useTranslation();
  const search = route.useSearch();
  const navigate = route.useNavigate();

  const { data: projects } = useSuspenseQuery(projectsQueryOptions);
  const { data: tickets } = useSuspenseQuery(boardTicketsQueryOptions(search.projectId));
  // Repository per il badge del bersaglio sulle card. Non-suspense: assente →
  // nessun badge (degradazione innocua).
  const { data: repositories } = useQuery(repositoriesQueryOptions());
  const repositoryNames = new Map((repositories ?? []).map((repo) => [repo.id, repo.name]));
  const { moveTicket, isError, error, reset } = useMoveTicket(search.projectId);

  // PointerSensor (mouse) — distanza di attivazione 8px: sotto è un click (apre
  // il dettaglio), sopra è un drag. Superata la soglia dnd-kit sopprime il click
  // successivo, i due gesti non si pestano i piedi.
  //
  // TouchSensor (touch) — attivazione a tempo (delay 200ms, tolerance 8px): un
  // tap rapido o uno swipe NON avviano un drag e restano allo scroll nativo (le
  // colonne scrollano in verticale via `<ul>` e in orizzontale con snap), mentre
  // un breve press-and-hold lo avvia. Senza questo, su touch una panoramica che
  // parte da una card corre contro l'attivazione a distanza e litiga con lo
  // scroll nativo. dnd-kit sceglie il sensore giusto in base all'input.
  // NB: la validazione su device reale resta raccomandata.
  //
  // Da tastiera: Space prende e posa la card (con le coordinate sortable per
  // muoversi tra colonne); Enter posa la card durante un drag (è in
  // keyboardCodes.end), fuori dal drag apre il dettaglio (vedi onKeyDown).
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
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
    <div className="page flex h-full flex-col">
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-line pb-3 sm:gap-4 sm:pb-4">
        <div>
          <h1 className="text-lg font-semibold sm:text-xl">{t("tickets:board.title")}</h1>
          <p className="mt-1 text-sm text-fg-muted">{t("tickets:board.subtitle")}</p>
        </div>

        <div className="flex flex-col gap-1">
          <label
            htmlFor="board-project"
            className="font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase"
          >
            {t("tickets:board.project")}
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
            <option value="">{t("tickets:board.all")}</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>
      </header>

      {tickets.length === BOARD_TICKETS_LIMIT && (
        <p className="mt-4 rounded-sm border border-line bg-ink-900 px-3 py-2 font-mono text-[12px] text-fg-muted">
          {t("tickets:board.truncated", { limit: BOARD_TICKETS_LIMIT })}
        </p>
      )}

      {isError && (
        <div
          role="alert"
          className="mt-4 flex items-baseline justify-between gap-4 rounded-sm border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-[13px] text-danger"
        >
          <span>{t("tickets:board.moveFailed", { error: error?.message })}</span>
          <button
            type="button"
            onClick={reset}
            className="shrink-0 text-[11px] tracking-[0.12em] uppercase underline underline-offset-2 hover:text-fg"
          >
            {t("tickets:board.dismiss")}
          </button>
        </div>
      )}

      <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={handleDragEnd}>
        <div className="mt-4 grid min-h-0 flex-1 snap-x snap-mandatory auto-cols-[minmax(15rem,1fr)] grid-flow-col gap-3 overflow-x-auto pb-2 sm:mt-6">
          {BOARD_STATUSES.map((status) => (
            <BoardColumn
              key={status}
              status={status}
              tickets={byStatus.get(status) ?? []}
              repositoryNames={repositoryNames}
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
  /** Mappa repositoryId → nome, per il badge del bersaglio sulle card. */
  repositoryNames: Map<string, string>;
  onOpen: (id: string) => void;
}

function BoardColumn({ status, tickets, repositoryNames, onOpen }: BoardColumnProps) {
  const { t } = useTranslation();
  const { setNodeRef, isOver } = useDroppable({ id: status });

  return (
    <section
      ref={setNodeRef}
      aria-label={t("tickets:board.columnLabel", {
        status: t(STATUS_LABEL_KEYS[status]),
        count: tickets.length,
      })}
      className={`flex min-h-0 snap-start flex-col rounded-sm border bg-ink-900 transition-colors ${
        isOver ? "border-signal-dim bg-ink-850" : "border-line"
      }`}
    >
      <header className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <span aria-hidden className={`size-1.5 rounded-full ${STATUS_DOT[status]}`} />
        <h2 className="font-mono text-[11px] font-medium tracking-[0.14em] text-fg-muted uppercase">
          {t(STATUS_LABEL_KEYS[status])}
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
            <BoardCard
              key={ticket.id}
              ticket={ticket}
              repositoryName={
                ticket.repositoryId ? (repositoryNames.get(ticket.repositoryId) ?? null) : null
              }
              onOpen={() => onOpen(ticket.id)}
            />
          ))}
          {tickets.length === 0 && (
            <li className="grid flex-1 place-items-center rounded-sm border border-dashed border-line py-6">
              <span className="font-mono text-[11px] tracking-[0.14em] text-fg-faint uppercase">
                {t("tickets:board.emptyColumn")}
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
  /** Nome del repository bersaglio, o null se assente/non risolvibile. */
  repositoryName: string | null;
  onOpen: () => void;
}

function BoardCard({ ticket, repositoryName, onOpen }: BoardCardProps) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: ticket.id,
    // Lo stato viaggia con la card: onDragEnd lo legge quando si rilascia
    // sopra un'altra card invece che sulla colonna.
    data: { status: ticket.status },
    attributes: { roleDescription: t("tickets:board.cardRoleDescription") },
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
        // sensore (Space): lo si richiama a mano per non perderlo. Invio è in
        // keyboardCodes.end — durante un drag posa la card (il sensore fa
        // preventDefault) — e solo fuori dal drag apre il dettaglio.
        listeners?.onKeyDown?.(event);
        if (event.key === "Enter" && !isDragging && !event.defaultPrevented) onOpen();
      }}
      // touch-none SOLO sulla card (è l'handle che spreda {...listeners}): una
      // volta che il drag è inteso il browser non rivendica il gesto. Lo scroll
      // verticale della colonna resta sul `<ul>` contenitore, non sulla card.
      className={`cursor-grab touch-none rounded-sm border bg-ink-850 p-3 transition-colors ${
        isDragging
          ? "z-10 cursor-grabbing border-signal-dim opacity-90 shadow-[0_8px_24px_rgba(0,0,0,0.5)]"
          : "border-line hover:border-line-strong hover:bg-ink-800"
      }`}
    >
      <div className="flex items-baseline gap-2 font-mono text-[12px]">
        <span className="text-fg-faint">#{ticket.number}</span>
        {ticket.occurrences > 1 && (
          <span className="text-signal" title={t("tickets:row.occurrences")}>
            ×{ticket.occurrences}
          </span>
        )}
      </div>
      <p className="mt-1 line-clamp-2 text-sm font-medium text-fg">{ticket.title}</p>
      {repositoryName && (
        <p className="mt-1.5 truncate font-mono text-[10px] tracking-[0.06em] text-fg-faint">
          <span className="rounded-sm border border-line bg-ink-900 px-1.5 py-0.5 text-fg-muted">
            {repositoryName}
          </span>
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <TypeBadge type={ticket.type} />
        <PriorityBadge priority={ticket.priority} />
      </div>
    </li>
  );
}
