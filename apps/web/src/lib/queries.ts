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

/**
 * Key factory dei ticket: unica fonte delle chiavi, sia per le queryOptions
 * qui sotto sia per invalidazioni/cancellazioni mirate altrove. Le chiavi
 * sono gerarchiche: `lists()` matcha ogni lista filtrata, `all` tutto.
 */
export const ticketKeys = {
  all: ["tickets"] as const,
  lists: () => [...ticketKeys.all, "list"] as const,
  list: (filters: TicketFilters) => [...ticketKeys.lists(), filters] as const,
  detail: (id: string) => [...ticketKeys.all, "detail", id] as const,
  comments: (ticketId: string) => [...ticketKeys.all, "comments", ticketId] as const,
  jobs: (ticketId: string) => [...ticketKeys.all, "jobs", ticketId] as const,
};

export function ticketsInfiniteQueryOptions(filters: TicketFilters) {
  return infiniteQueryOptions({
    // I filtri nella chiave: ogni combinazione è una lista a sé.
    queryKey: ticketKeys.list(filters),
    queryFn: ({ pageParam }) => listTickets(filters, pageParam ?? undefined),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: 10_000,
  });
}

export function ticketQueryOptions(id: string) {
  return queryOptions({
    queryKey: ticketKeys.detail(id),
    queryFn: () => getTicket(id),
    staleTime: 10_000,
  });
}

export function commentsQueryOptions(ticketId: string) {
  return queryOptions({
    queryKey: ticketKeys.comments(ticketId),
    queryFn: () => getComments(ticketId),
  });
}

export function ticketJobsQueryOptions(ticketId: string) {
  return queryOptions({
    queryKey: ticketKeys.jobs(ticketId),
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
