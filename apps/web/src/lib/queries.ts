import { infiniteQueryOptions, keepPreviousData, queryOptions } from "@tanstack/react-query";
import {
  getActivity,
  getAutomationSettings,
  getAiUsageCosts,
  getAiUsageSnapshots,
  getBacklogItem,
  getComments,
  getGitAccount,
  getGitAccounts,
  getInstanceSettings,
  getInvites,
  getNotificationSettings,
  getObservedAuthors,
  listPats,
  getProject,
  getProjects,
  getRepositories,
  getRepository,
  getRepositoryWebhook,
  listEnvFiles,
  getServer,
  getServerMetrics,
  getSlackWorkspaceUsers,
  getTicket,
  getTicketActivity,
  getTicketAttachments,
  getTicketJobs,
  getTicketLinks,
  getTicketUsage,
  getUsers,
  getWidgetConversationMessages,
  getWidgetConversations,
  getWidgets,
  listAiProviders,
  listBacklogItems,
  listMilestones,
  listSavedViews,
  listServerChecks,
  listServers,
  listTickets,
  type BacklogFilters,
  type ServerMetricsRange,
  type TicketFilters,
} from "./api";
import {
  getDocBrief,
  getDocPage,
  getDocSpaces,
  getDocStatus,
  getDocTree,
  getProjectDocSpaces,
} from "./docs-api";

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
 * Key factory del backlog di discovery: gerarchica come quella dei ticket.
 * `lists()` matcha ogni lista filtrata, `detail(id)` la singola voce.
 */
export const backlogKeys = {
  all: ["backlog"] as const,
  lists: () => [...backlogKeys.all, "list"] as const,
  list: (filters: BacklogFilters) => [...backlogKeys.lists(), filters] as const,
  detail: (id: string) => [...backlogKeys.all, "detail", id] as const,
};

export function backlogInfiniteQueryOptions(filters: BacklogFilters) {
  return infiniteQueryOptions({
    // I filtri nella chiave: ogni combinazione è una lista a sé.
    queryKey: backlogKeys.list(filters),
    queryFn: ({ pageParam }) => listBacklogItems(filters, pageParam ?? undefined),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: 10_000,
  });
}

export function backlogItemQueryOptions(id: string) {
  return queryOptions({
    queryKey: backlogKeys.detail(id),
    queryFn: () => getBacklogItem(id),
    staleTime: 10_000,
    // Polling adattivo mentre il worker lavora in modo asincrono (pattern
    // /activity): finché `pendingTurn` è vero (turno di analisi sul codice in
    // corso) ricarichiamo ogni 2s così la risposta dell'agente compare appena
    // pronta; finché `deepDivePending` è vero ogni 10s (documento + metadati
    // suggeriti); altrimenti stop. Il turno ha priorità sul cadenza più corta.
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data?.pendingTurn) return 2_000;
      if (data?.deepDivePending) return 10_000;
      return false;
    },
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
 * Personal Access Token dell'utente corrente (Impostazioni → Token). Isolamento
 * per-utente lato server; niente refetch periodico (la lista cambia solo su
 * azione dell'utente, che invalida la chiave).
 */
export const patsQueryOptions = queryOptions({
  queryKey: ["pats"],
  queryFn: listPats,
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

/**
 * Autori git osservati dal poller per il picker di link in /team (solo admin).
 * `retry: false`: l'endpoint richiede il ruolo admin e non ha senso riprovare
 * un 403 deterministico.
 */
export const observedAuthorsQueryOptions = queryOptions({
  queryKey: ["git", "observed-authors"],
  queryFn: getObservedAuthors,
  retry: false,
  staleTime: 60_000,
});

/**
 * Lista dei progetti (gruppi), con il conteggio repository. Chiave radice
 * ["projects"]: ogni create/update/delete di un progetto la invalida.
 */
export const projectsQueryOptions = queryOptions({
  queryKey: ["projects"],
  queryFn: getProjects,
  staleTime: 60_000,
});

/**
 * Lista dei repository, opzionalmente filtrata per progetto (gruppo). Chiave
 * ["repositories", projectId|null]: la lista globale e quella di un progetto
 * sono cache distinte. Usata dal dettaglio progetto per elencare i repository
 * del gruppo.
 */
export function repositoriesQueryOptions(projectId?: string) {
  return queryOptions({
    queryKey: ["repositories", projectId ?? null],
    queryFn: () => getRepositories(projectId),
    staleTime: 60_000,
  });
}

/**
 * Dettaglio di un repository per slug. Chiave figlia di ["repositories"]:
 * invalidare il prefisso riconcilia liste e dettagli in un colpo solo.
 */
export function repositoryQueryOptions(slug: string) {
  return queryOptions({
    queryKey: ["repositories", "detail", slug],
    queryFn: () => getRepository(slug),
    staleTime: 60_000,
  });
}

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
 * Provider AI configurati (solo admin), ordinati per position di failover. La
 * pagina Settings la abilita in base al ruolo; chiave radice ["ai-providers"]:
 * ogni create/update/delete/reorder la invalida così la catena resta
 * riconciliata col backend.
 */
export const aiProvidersQueryOptions = queryOptions({
  queryKey: ["ai-providers"],
  queryFn: listAiProviders,
  staleTime: 30_000,
  // Polling adattivo dell'esito dei test credenziale: il worker scrive
  // `passed`/`failed` in modo asincrono, quindi finché c'è almeno una riga
  // `pending` ricarichiamo ogni 2s; altrimenti niente refetch periodico.
  refetchInterval: (query) =>
    (query.state.data ?? []).some((p) => p.testStatus === "pending") ? 2000 : false,
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
 * Usage residuo dell'abbonamento (solo admin): ultimo snapshot per credenziale
 * `account`. Affiancato alla catena in Settings → AI providers. `staleTime`
 * breve: il worker aggiorna gli snapshot a ogni poll, ma non serve real-time.
 */
export const aiUsageSnapshotsQueryOptions = queryOptions({
  queryKey: ["ai-usage", "snapshots"],
  queryFn: getAiUsageSnapshots,
  staleTime: 30_000,
});

/**
 * Dettaglio di un progetto (gruppo) per id, con l'elenco dei suoi repository.
 * Chiave figlia di ["projects"]: invalidare il prefisso riconcilia lista e
 * dettagli in un colpo solo.
 */
export function projectQueryOptions(projectId: string) {
  return queryOptions({
    queryKey: ["projects", "detail", projectId],
    queryFn: () => getProject(projectId),
    staleTime: 60_000,
  });
}

/**
 * Elenco dei widget di assistenza di un progetto. Lettura per ogni utente
 * autenticato (create/update/delete sono solo admin, arbitrati dal server).
 * Chiave figlia del progetto: le mutazioni la invalidano/riconciliano.
 */
export function widgetsQueryOptions(projectId: string) {
  return queryOptions({
    queryKey: ["projects", "detail", projectId, "widgets"],
    queryFn: () => getWidgets(projectId),
    staleTime: 30_000,
  });
}

/**
 * Elenco delle conversazioni widget di un progetto (viewer interno), ordinate
 * lastMessageAt desc. Chiave figlia del progetto: i filtri `ticketId` (link dal
 * ticket) e `widgetId` (select in testa alla lista) entrano nella chiave così
 * ogni combinazione filtrata e la lista intera sono cache distinte. `staleTime`
 * breve: nuove conversazioni arrivano di continuo.
 */
export function widgetConversationsQueryOptions(
  projectId: string,
  filters?: { ticketId?: string; widgetId?: string },
) {
  const ticketId = filters?.ticketId;
  const widgetId = filters?.widgetId;
  return queryOptions({
    queryKey: [
      "projects",
      "detail",
      projectId,
      "widget-conversations",
      ticketId ?? null,
      widgetId ?? null,
    ],
    queryFn: () =>
      getWidgetConversations(
        projectId,
        ticketId || widgetId ? { ticketId, widgetId } : undefined,
      ),
    staleTime: 10_000,
  });
}

/**
 * Filo completo di una conversazione widget (identità + messaggi). Chiave figlia
 * della conversazione, sotto il sotto-albero widget del progetto. `enabled` sul
 * conversationId: il pannello dettaglio la interroga solo a selezione fatta.
 */
export function widgetConversationMessagesQueryOptions(
  projectId: string,
  conversationId: string | undefined,
) {
  return queryOptions({
    queryKey: ["projects", "detail", projectId, "widget-conversation", conversationId ?? null],
    queryFn: () => getWidgetConversationMessages(projectId, conversationId!),
    enabled: conversationId !== undefined,
    staleTime: 10_000,
  });
}

/**
 * File d'ambiente di un repository (solo admin): la pagina di dettaglio del
 * repository la abilita in base al ruolo. Chiave figlia del repository: ogni
 * create/import/delete sulle variabili o sui file la invalida così la lista
 * resta riconciliata col backend.
 */
export function projectEnvFilesQueryOptions(repositoryId: string) {
  return queryOptions({
    queryKey: ["repositories", "env-files", repositoryId],
    queryFn: () => listEnvFiles(repositoryId),
    staleTime: 30_000,
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
 * Config webhook di un repository (solo admin). Chiave separata dal dettaglio:
 * il segreto si carica solo dove serve (pannello admin) e non finisce nella
 * cache del repository condivisa con i member.
 */
export function repositoryWebhookQueryOptions(slug: string) {
  return queryOptions({
    queryKey: ["repositories", "detail", slug, "webhook"],
    queryFn: () => getRepositoryWebhook(slug),
    staleTime: 60_000,
  });
}

/**
 * Key factory del dominio Monitor (server): unica fonte delle chiavi, sia per le
 * queryOptions qui sotto sia per invalidazioni mirate altrove. Gerarchiche:
 * `lists()` matcha ogni lista (globale o filtrata per progetto), `detail(id)`
 * ogni dato di un server, e `checks`/`metrics` ne sono figlie così una mutazione
 * su un server invalida tutto il suo sotto-albero in un colpo solo.
 */
export const serverKeys = {
  all: ["servers"] as const,
  lists: () => [...serverKeys.all, "list"] as const,
  list: (projectId?: string) => [...serverKeys.lists(), projectId ?? null] as const,
  details: () => [...serverKeys.all, "detail"] as const,
  detail: (id: string) => [...serverKeys.details(), id] as const,
  checks: (id: string) => [...serverKeys.detail(id), "checks"] as const,
  // Il range entra nella chiave così com'è: il chiamante deve quantizzare `to`
  // (es. al minuto) per chiavi cache stabili — un toISOString() per render
  // creerebbe una entry nuova a ogni render.
  metrics: (id: string, range: ServerMetricsRange) =>
    [...serverKeys.detail(id), "metrics", range] as const,
};

/**
 * Lista dei server monitorati, opzionalmente filtrata per progetto associato.
 * Dati live: `refetchInterval` a 30s tiene aggiornati stato/heartbeat/CPU senza
 * intervento dell'utente; `staleTime` breve così un rientro nella pagina rinfresca.
 */
export function serversQueryOptions(projectId?: string) {
  return queryOptions({
    queryKey: serverKeys.list(projectId),
    queryFn: () => listServers(projectId),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
}

/**
 * Dettaglio di un server (snapshot corrente incluso). Chiave figlia di
 * ["servers"]: invalidare il prefisso riconcilia lista e dettagli in un colpo
 * solo. Dati live: `refetchInterval` a 30s.
 */
export function serverDetailQueryOptions(id: string) {
  return queryOptions({
    queryKey: serverKeys.detail(id),
    queryFn: () => getServer(id),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
}

/**
 * Check di servizio di un server. Chiave figlia del dettaglio server: ogni
 * create/update/delete di un check la invalida così la lista resta riconciliata.
 * Dati live come lista/dettaglio (`lastStatus`/`downSince` cambiano da soli):
 * `refetchInterval` a 30s, coerente col dettaglio affiancato in pagina.
 */
export function serverChecksQueryOptions(id: string) {
  return queryOptions({
    queryKey: serverKeys.checks(id),
    queryFn: () => listServerChecks(id),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
}

/**
 * Serie temporale delle metriche di un server nel range dato (con eventuale
 * `checkId`). Il range entra nella chiave: ogni finestra/zoom è una query a sé in
 * cache — il chiamante deve quantizzare `to` (es. al minuto) per chiavi cache
 * stabili, un toISOString() per render creerebbe una entry nuova a ogni render.
 * `staleTime` breve: i dati sono storici ma la coda cresce coi nuovi campioni;
 * il refetch periodico lo gestiscono le query live (lista/dettaglio).
 *
 * `placeholderData: keepPreviousData`: quando la chiave cambia (il `to`
 * quantizzato avanza al minuto, o si cambia range/checkId) i dati precedenti
 * restano visibili durante il fetch della nuova finestra, invece di tornare a
 * `undefined`. Senza, la pagina smonterebbe i pannelli (ramo "loading") a ogni
 * scatto di minuto → sfarfallio; i grafici si aggiornano poi in-place (setData).
 */
export function serverMetricsQueryOptions(id: string, range: ServerMetricsRange) {
  return queryOptions({
    queryKey: serverKeys.metrics(id, range),
    queryFn: () => getServerMetrics(id, range),
    staleTime: 10_000,
    placeholderData: keepPreviousData,
  });
}

/**
 * Key factory del dominio Docs: unica fonte delle chiavi, sia per le
 * queryOptions qui sotto sia per invalidazioni mirate altrove. Gerarchiche:
 * `spaces()` matcha l'hub, `space(repositoryId)` ogni dato di uno spazio, e
 * `tree`/`page`/`status` ne sono figlie così una rigenerazione invalida tutto
 * lo spazio in un colpo solo. Lo spazio è per-repository.
 */
export const docsKeys = {
  all: ["docs"] as const,
  spaces: () => [...docsKeys.all, "spaces"] as const,
  space: (repositoryId: string) => [...docsKeys.all, "space", repositoryId] as const,
  tree: (repositoryId: string) => [...docsKeys.space(repositoryId), "tree"] as const,
  page: (repositoryId: string, slug: string) =>
    [...docsKeys.space(repositoryId), "page", slug] as const,
  status: (repositoryId: string) => [...docsKeys.space(repositoryId), "status"] as const,
  brief: (repositoryId: string) => [...docsKeys.space(repositoryId), "brief"] as const,
  // Sotto-albero della documentazione di PROGETTO (Fase 2): scoped al projectId,
  // distinto dallo spazio per-repository sopra.
  project: (projectId: string) => [...docsKeys.all, "project", projectId] as const,
  projectSpaces: (projectId: string) => [...docsKeys.project(projectId), "spaces"] as const,
};

/**
 * Hub degli spazi di documentazione: i repository con doc (conteggio pagine,
 * data/commit dell'ultima generazione). Chiave radice del dominio docs: una
 * generazione o una pagina manuale la invalida così l'hub resta riconciliato.
 */
export const docSpacesQueryOptions = queryOptions({
  queryKey: docsKeys.spaces(),
  queryFn: getDocSpaces,
  staleTime: 30_000,
});

/**
 * Spazi-doc di un PROGETTO (Fase 2): i repository del gruppo con documentazione,
 * per la landing di progetto. Chiave figlia del progetto: una generazione o una
 * pagina manuale di un repo del gruppo dovrebbe invalidarla.
 */
export function projectDocSpacesQueryOptions(projectId: string) {
  return queryOptions({
    queryKey: docsKeys.projectSpaces(projectId),
    queryFn: () => getProjectDocSpaces(projectId),
    staleTime: 30_000,
  });
}

/**
 * Albero delle pagine di uno spazio (generazione corrente + manuali). Chiave
 * figlia dello spazio: ogni CRUD manuale o rigenerazione la invalida.
 */
export function docTreeQueryOptions(repositoryId: string) {
  return queryOptions({
    queryKey: docsKeys.tree(repositoryId),
    queryFn: () => getDocTree(repositoryId),
    staleTime: 30_000,
  });
}

/**
 * Pagina singola di uno spazio per slug. Chiave figlia dello spazio: una patch
 * della pagina (o una rigenerazione) la invalida.
 */
export function docPageQueryOptions(repositoryId: string, slug: string) {
  return queryOptions({
    queryKey: docsKeys.page(repositoryId, slug),
    queryFn: () => getDocPage(repositoryId, slug),
    staleTime: 30_000,
  });
}

/**
 * Stato Docs di un repository (generazione corrente + ultimo job): alimenta il
 * pannello trigger/stato. `staleTime` breve: il worker aggiorna lo stato in
 * modo asincrono mentre la generazione avanza.
 */
export function docStatusQueryOptions(repositoryId: string) {
  return queryOptions({
    queryKey: docsKeys.status(repositoryId),
    queryFn: () => getDocStatus(repositoryId),
    staleTime: 10_000,
  });
}

/**
 * Project brief della generazione corrente del repository (tab "Brief"): sola
 * lettura, cambia solo a una nuova generazione → `staleTime` largo. Un 404
 * (nessun brief) è un esito atteso, gestito dal componente senza retry.
 */
export function docBriefQueryOptions(repositoryId: string) {
  return queryOptions({
    queryKey: docsKeys.brief(repositoryId),
    queryFn: () => getDocBrief(repositoryId),
    staleTime: 60_000,
    retry: false,
  });
}

/**
 * Report di attività di una data (`YYYY-MM-DD`, UTC): alimenta la sezione SPA
 * "Attività". La data entra nella chiave così ogni giorno è una query a sé in
 * cache. `staleTime` di un minuto: i report sono prodotti dal poller notturno,
 * non cambiano durante la navigazione.
 *
 * `refetchInterval` adattivo: quando la generazione manuale accoda dei report,
 * questi arrivano `queued`/`running` (entries vuote) e il worker li finalizza in
 * modo asincrono. Ricarichiamo ogni 10s finché almeno un report è `queued`/
 * `running` OPPURE il rollup dei riassunti per-dev è ancora in corso
 * (`developersSummaryPending`): così la vista passa da "in generazione" al
 * report vero — riassunti compresi — senza intervento; poi niente più refetch.
 */
export function activityReportQueryOptions(date: string) {
  return queryOptions({
    queryKey: ["activity", date],
    queryFn: () => getActivity(date),
    staleTime: 60_000,
    refetchInterval: (query) => {
      const data = query.state.data;
      const pending =
        data?.projects.some((p) => p.status === "queued" || p.status === "running") ||
        data?.developersSummaryPending === true;
      return pending ? 10_000 : false;
    },
  });
}
