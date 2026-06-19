import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import {
  getAutomationSettings,
  getAiUsageCosts,
  getComments,
  getGitAccount,
  getGitAccounts,
  getInstanceSettings,
  getInvites,
  getNotificationSettings,
  getProject,
  getProjects,
  getProjectWebhook,
  getSlackWorkspaceUsers,
  getTicket,
  getTicketActivity,
  getTicketAttachments,
  getTicketJobs,
  getTicketLinks,
  getTicketUsage,
  getUsers,
  listMilestones,
  listSavedViews,
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
  // `boards()` matcha ogni board qualunque sia il filtro progetto: è la
  // chiave da invalidare quando un ticket cambia fuori dalla board (es. dal
  // dettaglio) e ogni vista kanban va riconciliata.
  boards: () => [...ticketKeys.all, "board"] as const,
  board: (projectId?: string) => [...ticketKeys.boards(), projectId ?? null] as const,
  comments: (ticketId: string) => [...ticketKeys.all, "comments", ticketId] as const,
  activity: (ticketId: string) => [...ticketKeys.all, "activity", ticketId] as const,
  jobs: (ticketId: string) => [...ticketKeys.all, "jobs", ticketId] as const,
  usage: (ticketId: string) => [...ticketKeys.all, "usage", ticketId] as const,
  links: (ticketId: string) => [...ticketKeys.all, "links", ticketId] as const,
  attachments: (ticketId: string) => [...ticketKeys.all, "attachments", ticketId] as const,
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

/**
 * La board è uno snapshot a pagina singola: chiede il massimo consentito dal
 * server (100) e ignora il cursore. Oltre quella soglia i ticket più vecchi
 * non compaiono sulla board — limite documentato e accettato: una parete
 * kanban con più di 100 card non è più leggibile, e i filtri per progetto
 * riportano sotto soglia i casi reali.
 */
export const BOARD_TICKETS_LIMIT = 100;

export function boardTicketsQueryOptions(projectId?: string) {
  return queryOptions({
    queryKey: ticketKeys.board(projectId),
    queryFn: async () => {
      const page = await listTickets(
        projectId ? { projectId } : {},
        undefined,
        BOARD_TICKETS_LIMIT,
      );
      return page.items;
    },
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

/**
 * Feed unificato (commenti + eventi di audit + marker job AI) di un ticket,
 * in ordine cronologico crescente. Chiave figlia dei ticket: ogni mutazione
 * che tocca il ticket (commento, run-ai, patch stato/assegnatario, …) la
 * invalida così la timeline resta riconciliata col backend.
 */
export function activityQueryOptions(ticketId: string) {
  return queryOptions({
    queryKey: ticketKeys.activity(ticketId),
    queryFn: () => getTicketActivity(ticketId),
  });
}

export function ticketJobsQueryOptions(ticketId: string) {
  return queryOptions({
    queryKey: ticketKeys.jobs(ticketId),
    queryFn: () => getTicketJobs(ticketId),
  });
}

export function ticketUsageQueryOptions(ticketId: string) {
  return queryOptions({
    queryKey: ticketKeys.usage(ticketId),
    queryFn: () => getTicketUsage(ticketId),
  });
}

/**
 * Relazioni del ticket (link verso/da altri ticket), risolte col ticket
 * "altro". Chiave figlia dei ticket: create/delete di un link la invalidano
 * (assieme al feed, dato che ogni link genera un evento di audit).
 */
export function ticketLinksQueryOptions(ticketId: string) {
  return queryOptions({
    queryKey: ticketKeys.links(ticketId),
    queryFn: () => getTicketLinks(ticketId),
  });
}

/**
 * Allegati di un ticket (inclusi quelli legati ai suoi commenti), con
 * downloadUrl presigned. Chiave figlia dei ticket: upload e delete la
 * invalidano. `staleTime` breve: gli URL firmati scadono, meglio rinfrescarli.
 */
export function ticketAttachmentsQueryOptions(ticketId: string) {
  return queryOptions({
    queryKey: ticketKeys.attachments(ticketId),
    queryFn: () => getTicketAttachments(ticketId),
    staleTime: 30_000,
  });
}

export const usersQueryOptions = queryOptions({
  queryKey: ["team", "users"],
  queryFn: getUsers,
  staleTime: 60_000,
});

/**
 * Inviti in sospeso (solo admin): la pagina Team la abilita in base al ruolo.
 * Chiave gemella di quella degli utenti sotto il prefisso "team": invalidare
 * il prefisso riconcilia membri e inviti in un colpo solo.
 */
export const invitesQueryOptions = queryOptions({
  queryKey: ["team", "invites"],
  queryFn: getInvites,
  staleTime: 30_000,
});

/**
 * Membri del workspace Slack per il picker di link/invito (solo admin).
 * NON suspense: l'endpoint risponde 400 `slack_not_configured` quando Slack
 * non è attivo, e la pagina Team deve degradare con un hint anziché esplodere.
 * `retry: false` evita di riprovare un 400 deterministico; il chiamante usa
 * `useQuery` con `enabled` legato al ruolo admin e legge `error`/`data`.
 */
export const slackWorkspaceUsersQueryOptions = queryOptions({
  queryKey: ["slack", "workspace-users"],
  queryFn: getSlackWorkspaceUsers,
  retry: false,
  staleTime: 60_000,
});

export const projectsQueryOptions = queryOptions({
  queryKey: ["projects"],
  queryFn: getProjects,
  staleTime: 60_000,
});

/**
 * Milestone (con avanzamento) di un progetto. Le milestone sono per-progetto:
 * la query si abilita solo con un projectId definito (il select filtro nella
 * lista, ad esempio, la chiama anche quando nessun progetto è selezionato).
 * Chiave ["milestones", projectId]: una patch/CRUD su una milestone invalida
 * la sola lista del progetto interessato.
 */
export function milestonesQueryOptions(projectId: string | undefined) {
  return queryOptions({
    queryKey: ["milestones", projectId ?? null],
    queryFn: () => listMilestones(projectId!),
    enabled: projectId !== undefined,
    staleTime: 30_000,
  });
}

/**
 * Viste salvate dei filtri della lista ticket: le proprie più quelle condivise
 * dal team. Chiave radice ["saved-views"]: ogni create/update/delete la
 * invalida così la barra delle viste resta riconciliata col backend.
 */
export const savedViewsQueryOptions = queryOptions({
  queryKey: ["saved-views"],
  queryFn: listSavedViews,
  staleTime: 30_000,
});

/**
 * Regole di automazione AI per tipo (solo admin): la pagina Settings la
 * abilita in base al ruolo. Staleness breve: le si modifica raramente ma la
 * UI deve riflettere subito un salvataggio.
 */
export const automationSettingsQueryOptions = queryOptions({
  queryKey: ["settings", "automation"],
  queryFn: getAutomationSettings,
  staleTime: 30_000,
});

/**
 * Impostazioni del webhook di notifica (solo admin): la pagina Settings la
 * abilita in base al ruolo. Chiave gemella di quella dell'automazione sotto il
 * prefisso "settings".
 */
export const notificationSettingsQueryOptions = queryOptions({
  queryKey: ["settings", "notifications"],
  queryFn: getNotificationSettings,
  staleTime: 30_000,
});

/**
 * Impostazioni d'istanza (solo admin): la lingua dei contenuti generati
 * (commenti AI, report PR, notifiche). Chiave gemella delle altre sotto il
 * prefisso "settings".
 */
export const instanceSettingsQueryOptions = queryOptions({
  queryKey: ["settings", "instance"],
  queryFn: getInstanceSettings,
  staleTime: 30_000,
});

/**
 * Range supportati dalla dashboard consumi AI: finestra a 7/30/90 giorni.
 * Il filtro è espresso in giorni; il `from` (YYYY-MM-DD, UTC) si calcola
 * client-side, il `to` lo lascia al default del server (ora).
 */
export const USAGE_RANGE_DAYS = [7, 30, 90] as const;
export type UsageRangeDays = (typeof USAGE_RANGE_DAYS)[number];

/** `from` (YYYY-MM-DD, UTC) di N giorni fa rispetto a `now` (iniettabile). */
export function usageFromDate(days: number, now: number = Date.now()): string {
  return new Date(now - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * Consumi AI aggregati (solo admin) nella finestra a N giorni. Chiave per
 * numero di giorni: cambiare il filtro 7/30/90 è una query a sé in cache.
 * `staleTime` breve: i dati cambiano con i job ma non in tempo reale.
 */
export function aiUsageCostsQueryOptions(days: UsageRangeDays) {
  return queryOptions({
    queryKey: ["ai-usage", "costs", days],
    queryFn: () => getAiUsageCosts({ from: usageFromDate(days) }),
    staleTime: 30_000,
  });
}

/**
 * Dettaglio di un progetto per slug. Chiave figlia di ["projects"]:
 * invalidare il prefisso riconcilia lista e dettagli in un colpo solo.
 */
export function projectQueryOptions(slug: string) {
  return queryOptions({
    queryKey: ["projects", "detail", slug],
    queryFn: () => getProject(slug),
    staleTime: 60_000,
  });
}

/**
 * Account git riutilizzabili: lista visibile a ogni utente autenticato (serve
 * al selettore in creazione progetto), gestione riservata agli admin in
 * Settings. Chiave radice ["git-accounts"]: invalidarla riconcilia lista e
 * dettagli in un colpo solo.
 */
export const gitAccountsQueryOptions = queryOptions({
  queryKey: ["git-accounts"],
  queryFn: getGitAccounts,
  staleTime: 60_000,
});

export function gitAccountQueryOptions(id: string) {
  return queryOptions({
    queryKey: ["git-accounts", "detail", id],
    queryFn: () => getGitAccount(id),
    staleTime: 60_000,
  });
}

/**
 * Config webhook di un progetto (solo admin). Chiave separata dal dettaglio:
 * il segreto si carica solo dove serve (pannello admin) e non finisce nella
 * cache del progetto condivisa con i member.
 */
export function projectWebhookQueryOptions(slug: string) {
  return queryOptions({
    queryKey: ["projects", "detail", slug, "webhook"],
    queryFn: () => getProjectWebhook(slug),
    staleTime: 60_000,
  });
}
