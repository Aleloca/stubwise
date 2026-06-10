import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import {
  getComments,
  getProjects,
  getTicket,
  getTicketJobs,
  getUsers,
  listTickets,
  type TicketFilters,
} from "./api";

/**
 * Query del dominio ticket/progetti, condivise tra loader delle route e
 * componenti: stessa chiave, stessa cache, zero richieste duplicate.
 */

export function ticketsInfiniteQueryOptions(filters: TicketFilters) {
  return infiniteQueryOptions({
    // I filtri nella chiave: ogni combinazione è una lista a sé.
    queryKey: ["tickets", "list", filters],
    queryFn: ({ pageParam }) => listTickets(filters, pageParam ?? undefined),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: 10_000,
  });
}

export function ticketQueryOptions(id: string) {
  return queryOptions({
    queryKey: ["tickets", "detail", id],
    queryFn: () => getTicket(id),
    staleTime: 10_000,
  });
}

export function commentsQueryOptions(ticketId: string) {
  return queryOptions({
    queryKey: ["tickets", "comments", ticketId],
    queryFn: () => getComments(ticketId),
  });
}

export function ticketJobsQueryOptions(ticketId: string) {
  return queryOptions({
    queryKey: ["tickets", "jobs", ticketId],
    queryFn: () => getTicketJobs(ticketId),
  });
}

export const usersQueryOptions = queryOptions({
  queryKey: ["users"],
  queryFn: getUsers,
  staleTime: 60_000,
});

export const projectsQueryOptions = queryOptions({
  queryKey: ["projects"],
  queryFn: getProjects,
  staleTime: 60_000,
});
