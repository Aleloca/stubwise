import { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import type { RouterHistory } from "@tanstack/react-router";
import { AppLayout } from "./components/app-layout";
import { RouteError } from "./components/route-error";
import { ApiError } from "./lib/api";
import { meQueryOptions, setupStatusQueryOptions } from "./lib/auth";
import {
  activityQueryOptions,
  activityReportQueryOptions,
  aiProvidersQueryOptions,
  pluginsQueryOptions,
  backlogInfiniteQueryOptions,
  backlogItemQueryOptions,
  automationSettingsQueryOptions,
  boardTicketsQueryOptions,
  calendarSeriesQueryOptions,
  commentsQueryOptions,
  docPageQueryOptions,
  docSpacesQueryOptions,
  docTreeQueryOptions,
  gitAccountsQueryOptions,
  googleWorkspacesQueryOptions,
  inboxQueryOptions,
  instanceSettingsQueryOptions,
  invitesQueryOptions,
  briefQueryOptions,
  mailAdmissionQueryOptions,
  mailQueryOptions,
  mailSummaryQueryOptions,
  milestonesQueryOptions,
  myFollowsQueryOptions,
  myGoogleAccountsQueryOptions,
  notificationPrefsQueryOptions,
  notificationSettingsQueryOptions,
  patsQueryOptions,
  projectDocSpacesQueryOptions,
  projectQueryOptions,
  projectsPulseQueryOptions,
  projectsQueryOptions,
  releaseQueueQueryOptions,
  repositoriesQueryOptions,
  repositoryQueryOptions,
  serverDetailQueryOptions,
  serversQueryOptions,
  ticketAttachmentsQueryOptions,
  ticketJobsQueryOptions,
  ticketLinksQueryOptions,
  ticketQueryOptions,
  ticketsInfiniteQueryOptions,
  ticketUsageQueryOptions,
  usersQueryOptions,
  widgetConversationsQueryOptions,
  widgetsQueryOptions,
} from "./lib/queries";
import { ActivityPage, yesterdayUtc } from "./routes/activity";
import { BacklogDetailPage } from "./routes/backlog/$id";
import { backlogSearchSchema, BacklogPage } from "./routes/backlog/index";
import { boardSearchSchema, BoardPage } from "./routes/board";
import {
  DocsManualNew,
  DocsPageView,
  DocsReleasesView,
  DocsSpaceIndex,
  DocsSpaceLayout,
} from "./routes/docs/$projectId";
import { DocsBriefView } from "./routes/docs/brief.$projectId";
import { DocsGraphView } from "./routes/docs/graph.$projectId";
import { DocsPage } from "./routes/docs/index";
import { ProjectDocsLanding } from "./routes/docs/project.$projectId";
import { InboxPage } from "./routes/inbox";
import { CalendarPage } from "./routes/calendar";
import { MailPage } from "./routes/mail";
import { ReleaseQueuePage } from "./routes/release";
import { MailDetailPage } from "./routes/mail.$source.$id";
import { LoginPage } from "./routes/login";
import { MonitorListPage } from "./routes/monitor/index";
import { ServerDetailPage } from "./routes/monitor/server-detail";
import { ProjectDetailPage } from "./routes/projects/$projectId";
import { BriefPage } from "./routes/briefs/$id";
import { ProjectDecisionsPage } from "./routes/docs/project.$projectId.decisions";
import { ProjectRoadmapPage } from "./routes/projects/$projectId.roadmap";
import { ProjectsPage } from "./routes/projects/index";
import {
  widgetConversationsSearchSchema,
  WidgetConversationsPage,
} from "./routes/projects/widget-conversations";
import { RepositoryDetailPage } from "./routes/repositories/$slug";
import { RepositoriesListPage } from "./routes/repositories/index";
import { NewRepositoryPage } from "./routes/repositories/new";
import { NewRepositoryStandalonePage } from "./routes/repositories/new-standalone";
import { registerSearchSchema, RegisterPage } from "./routes/register";
import { SettingsAccessTokensPage } from "./routes/settings/access-tokens";
import { SettingsAccountPage, settingsAccountSearchSchema } from "./routes/settings/account";
import { SettingsAiProvidersPage } from "./routes/settings/ai-providers";
import { SettingsAutomationPage } from "./routes/settings/automation";
import { SettingsGitAccountsPage } from "./routes/settings/git-accounts";
import { SettingsGooglePage } from "./routes/settings/google";
import { SettingsLayout } from "./routes/settings/layout";
import { SettingsNotificationsPage } from "./routes/settings/notifications";
import { SettingsPluginsPage } from "./routes/settings/plugins";
import { SettingsSlackPage } from "./routes/settings/slack";
import { SettingsStoragePage } from "./routes/settings/storage";
import { SettingsUsagePage } from "./routes/settings/usage";
import { SetupPage } from "./routes/setup";
import { TeamPage } from "./routes/team";
import { TicketDetailPage } from "./routes/tickets/$id";
import { effectiveTicketFilters, ticketSearchSchema, TicketsPage } from "./routes/tickets/index";

/*
 * Routing code-based (createRoute, niente plugin file-router): l'albero è
 * piccolo e dichiararlo qui per intero lo rende leggibile in un colpo solo,
 * senza generazione di codice né magia sui nomi dei file.
 */

interface RouterContext {
  queryClient: QueryClient;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
});

const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/register",
  // Pagina pubblica: ci si arriva dal link di invito con ?token=…
  validateSearch: (search) => registerSearchSchema.parse(search),
  component: RegisterPage,
});

const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/setup",
  // La pagina di primo setup esiste solo finché non c'è nessun utente.
  beforeLoad: async ({ context }) => {
    const { needed } = await context.queryClient.fetchQuery(setupStatusQueryOptions);
    if (!needed) throw redirect({ to: "/login" });
  },
  component: SetupPage,
});

/**
 * Layout autenticato (route senza path): la guardia carica `me` via Query;
 * su 401 controlla se il primo setup è disponibile e reindirizza a /setup,
 * altrimenti a /login.
 */
const authedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "authed",
  beforeLoad: async ({ context }) => {
    try {
      const { user } = await context.queryClient.ensureQueryData(meQueryOptions);
      return { user };
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        const { needed } = await context.queryClient.fetchQuery(setupStatusQueryOptions);
        throw redirect({ to: needed ? "/setup" : "/login" });
      }
      throw error;
    }
  },
  component: AppLayout,
});

const indexRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/tickets" });
  },
});

const ticketsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/tickets",
  // I filtri vivono nei search param: validati qui, tipati ovunque.
  validateSearch: (search) => ticketSearchSchema.parse(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ context, deps }) => {
    // Prima pagina della lista e progetti (nomi + select filtro) in cache
    // prima del render: il componente usa le useSuspenseQuery senza attese.
    await Promise.all([
      context.queryClient.ensureInfiniteQueryData(
        ticketsInfiniteQueryOptions(effectiveTicketFilters(deps)),
      ),
      context.queryClient.ensureQueryData(projectsQueryOptions),
    ]);
  },
  component: TicketsPage,
});

const ticketDetailRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/tickets/$id",
  loader: async ({ context, params }) => {
    // Tutto il dettaglio (ticket, commenti, job, utenti, progetti) in
    // parallelo prima del render: niente cascate di spinner.
    await Promise.all([
      context.queryClient.ensureQueryData(ticketQueryOptions(params.id)),
      context.queryClient.ensureQueryData(commentsQueryOptions(params.id)),
      context.queryClient.ensureQueryData(activityQueryOptions(params.id)),
      context.queryClient.ensureQueryData(ticketJobsQueryOptions(params.id)),
      context.queryClient.ensureQueryData(ticketUsageQueryOptions(params.id)),
      context.queryClient.ensureQueryData(ticketLinksQueryOptions(params.id)),
      context.queryClient.ensureQueryData(ticketAttachmentsQueryOptions(params.id)),
      context.queryClient.ensureQueryData(usersQueryOptions),
      context.queryClient.ensureQueryData(projectsQueryOptions),
    ]);
  },
  component: TicketDetailPage,
});

const boardRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/board",
  // Il filtro progetto vive nel search param, come per la lista.
  validateSearch: (search) => boardSearchSchema.parse(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ context, deps }) => {
    // Snapshot della board e progetti (select del filtro) in cache prima del
    // render: le useSuspenseQuery del componente non attendono.
    await Promise.all([
      context.queryClient.ensureQueryData(boardTicketsQueryOptions(deps.projectId)),
      context.queryClient.ensureQueryData(projectsQueryOptions),
    ]);
  },
  component: BoardPage,
});

/**
 * Backlog di discovery: lista delle idee raccolte da feedback/feature. I filtri
 * vivono nei search param (validati qui, tipati ovunque); il default della lista
 * nasconde converted/archived. Prefetch della prima pagina filtrata + progetti
 * (nomi + select filtro) prima del render: le useSuspenseQuery non attendono.
 */
const backlogRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/backlog",
  validateSearch: (search) => backlogSearchSchema.parse(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ context, deps }) => {
    await Promise.all([
      context.queryClient.ensureInfiniteQueryData(backlogInfiniteQueryOptions(deps)),
      context.queryClient.ensureQueryData(projectsQueryOptions),
    ]);
  },
  component: BacklogPage,
});

/**
 * Dettaglio di una voce del backlog: documento, metadati suggeriti, ticket
 * collegati e chat di raffinamento. Segmento dinamico `$id` distinto dallo
 * statico `/backlog`. Prefetch della voce + progetti (nome nell'header) prima
 * del render, così le useSuspenseQuery del componente non attendono.
 */
const backlogDetailRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/backlog/$id",
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(backlogItemQueryOptions(params.id)),
      context.queryClient.ensureQueryData(projectsQueryOptions),
    ]);
  },
  component: BacklogDetailPage,
});

const projectsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/projects",
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(projectsQueryOptions);
    // Polso (fase 7, Task 10): best-effort, non blocca la pagina — è
    // un'annotazione per riga, non il dato che decide cosa renderizzare.
    await context.queryClient.ensureQueryData(projectsPulseQueryOptions).catch(() => undefined);
  },
  component: ProjectsPage,
});

const projectDetailRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/projects/$projectId",
  loader: async ({ context, params }) => {
    // Il progetto (gruppo) prima — l'id coincide col param — poi le sue
    // milestone: il MilestoneManager usa useSuspenseQuery e non deve attendere.
    const project = await context.queryClient.ensureQueryData(
      projectQueryOptions(params.projectId),
    );
    await context.queryClient.ensureQueryData(milestonesQueryOptions(project.id));
    // I progetti seguiti alimentano il bottone Segui dell'header: si scaldano
    // qui senza attendere (`void`) — il dettaglio non deve aspettarli, e se la
    // GET fallisce il bottone semplicemente non compare.
    void context.queryClient.ensureQueryData(myFollowsQueryOptions).catch(() => undefined);
  },
  component: ProjectDetailPage,
});

/**
 * Roadmap del progetto (Fase 5): milestone aperte con avanzamento e timeline
 * degli ultimi eventi, in sola lettura. Prefetch di progetto e milestone (le
 * `useSuspenseQuery` della pagina non devono attendere); la timeline resta
 * fuori dal loader perché dipende dai filtri, che sono stato del componente.
 */
const projectRoadmapRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/projects/$projectId/roadmap",
  loader: async ({ context, params }) => {
    const project = await context.queryClient.ensureQueryData(
      projectQueryOptions(params.projectId),
    );
    await context.queryClient.ensureQueryData(milestonesQueryOptions(project.id));
  },
  component: ProjectRoadmapPage,
});

/**
 * UN brief settimanale (Fase 5). Rotta di PRIMO LIVELLO come il suo endpoint:
 * il link al brief viaggia dentro la notifica `project.brief`, sul separatore
 * della roadmap e nel tool MCP, e nessuno di quei tre porta con sé il progetto.
 * Il loader prefetcha il brief; il progetto lo carica la pagina (serve il
 * `projectId`, che è nel brief).
 */
const briefRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/briefs/$id",
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(briefQueryOptions(params.id));
  },
  component: BriefPage,
});

/**
 * Viewer read-only delle conversazioni del widget di un progetto: lista +
 * pannello dettaglio. `?ticketId` (link "Vedi conversazione" dal ticket) filtra
 * la lista e auto-seleziona la conversazione. Prefetch best-effort dell'elenco
 * (con l'eventuale filtro), dei widget (select del filtro) e del progetto (nome
 * nell'header) prima del render.
 */
const widgetConversationsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/projects/$projectId/conversations",
  validateSearch: (search) => widgetConversationsSearchSchema.parse(search),
  loaderDeps: ({ search }) => ({ ticketId: search.ticketId, widgetId: search.widgetId }),
  loader: async ({ context, params, deps }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(projectQueryOptions(params.projectId)),
      context.queryClient
        .ensureQueryData(widgetsQueryOptions(params.projectId))
        .catch(() => undefined),
      context.queryClient
        .ensureQueryData(
          widgetConversationsQueryOptions(params.projectId, {
            ticketId: deps.ticketId,
            widgetId: deps.widgetId,
          }),
        )
        .catch(() => undefined),
    ]);
  },
  component: WidgetConversationsPage,
});

const repositoryNewRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/projects/$projectId/repositories/new",
  // Aggiunta di un repository riservata agli admin: un member che digita l'URL
  // torna al dettaglio del progetto invece di un form che il server rifiuterebbe.
  beforeLoad: ({ context, params }) => {
    if (context.user.role !== "admin") {
      throw redirect({ to: "/projects/$projectId", params: { projectId: params.projectId } });
    }
  },
  component: NewRepositoryPage,
});

/**
 * Elenco di TUTTI i repository collegati (voce di primo livello in sidebar),
 * raggruppati per progetto. Prefetch di repository + progetti prima del render:
 * le useSuspenseQuery del componente non attendono.
 *
 * Fase 7, Task 10: fuori dal MENU per un `member` (contenuto d'infrastruttura,
 * non serve a un operatore non tecnico — vedi `app-layout.tsx`), ma NON dietro
 * una guardia: nascosto dal menu ≠ inaccessibile. Il problema che questa fase
 * risolve è rumore visivo — non inciampare in una voce che poi si rivela
 * un vicolo cieco —, non un problema di superficie: la pagina si degrada già
 * bene per un member (`isAdmin && ...` nasconde solo i bottoni di creazione),
 * il contenuto (nomi di repository, stato) non è sensibile, e un link diretto
 * mandato da un collega deve continuare a funzionare. Solo le AZIONI DI
 * SCRITTURA restano guardate (`/repositories/new`, sotto).
 */
const repositoriesIndexRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/repositories",
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(repositoriesQueryOptions()),
      context.queryClient.ensureQueryData(projectsQueryOptions),
    ]),
  component: RepositoriesListPage,
});

/**
 * Aggiunta STANDALONE di un repository (solo admin): segmento statico `new`, ha
 * priorità sul dinamico `$slug` (nessun repo può avere slug "new"). Il progetto
 * di appartenenza si sceglie in un selettore nella pagina, non nell'URL. Un
 * member che digita l'URL torna alla lista invece di un form che il server
 * rifiuterebbe. Prefetch di progetti (selettore) e account git (wizard).
 */
const repositoryStandaloneNewRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/repositories/new",
  beforeLoad: ({ context }) => {
    if (context.user.role !== "admin") {
      throw redirect({ to: "/repositories" });
    }
  },
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(projectsQueryOptions),
      context.queryClient.ensureQueryData(gitAccountsQueryOptions),
    ]),
  component: NewRepositoryStandalonePage,
});

const repositoryDetailRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/repositories/$slug",
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(repositoryQueryOptions(params.slug)),
  component: RepositoryDetailPage,
});

/**
 * Hub della documentazione (sezione di primo livello): elenco degli spazi
 * (un progetto = uno spazio). Prefetch dell'hub prima del render, così la
 * useSuspenseQuery del componente non attende.
 */
const docsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/docs",
  // Spazi (hub globale) + progetti + repository: l'hub raggruppa i repo-spazi
  // per progetto lato client, quindi tutte e tre le liste in cache prima del
  // render (le useSuspenseQuery del componente non attendono).
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(docSpacesQueryOptions),
      context.queryClient.ensureQueryData(projectsQueryOptions),
      context.queryClient.ensureQueryData(repositoriesQueryOptions()),
    ]),
  component: DocsPage,
});

/**
 * Landing della documentazione di progetto (`/docs/project/$projectId`): spazi
 * del progetto + chat cross-repo. Segmento statico `project/` distinto dal
 * `/docs/$projectId` per-repo. Prefetch del progetto e dei suoi spazi.
 */
const projectDocsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/docs/project/$projectId",
  loader: ({ context, params }) =>
    Promise.all([
      context.queryClient.ensureQueryData(projectQueryOptions(params.projectId)),
      context.queryClient.ensureQueryData(projectDocSpacesQueryOptions(params.projectId)),
    ]),
  component: ProjectDocsLanding,
});

/**
 * REGISTRO DECISIONI del progetto (`/docs/project/$projectId/decisions`, Fase 5).
 *
 * Rotta PIATTA sotto `authedRoute` come `projectDocsRoute`, di cui è la
 * sotto-pagina logica: la landing dei Docs di progetto non è un layout con
 * `Outlet` (non ha figli), quindi annidarcela sotto la trasformerebbe in uno —
 * un cambio strutturale che nessuna delle due pagine chiede.
 */
const projectDecisionsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/docs/project/$projectId/decisions",
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(projectQueryOptions(params.projectId)),
  component: ProjectDecisionsPage,
});

/**
 * Spazio di un progetto: layout a tre zone (albero a sinistra, Outlet al
 * centro, zona chat riservata a destra). Prefetch dell'albero prima del
 * render; ricerca/trigger (M7.4) e chat (M7.5) arrivano dopo.
 */
const docsSpaceRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/docs/$projectId",
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(docTreeQueryOptions(params.projectId)),
  component: DocsSpaceLayout,
});

/** Indice dello spazio (nessuno slug): stato "seleziona una pagina". */
const docsSpaceIndexRoute = createRoute({
  getParentRoute: () => docsSpaceRoute,
  path: "/",
  component: DocsSpaceIndex,
});

/**
 * Creazione di una pagina manuale (`/docs/$projectId/new`): rotta statica, ha
 * priorità sul segmento dinamico `$slug` (nessuna pagina può avere slug "new").
 */
const docsManualNewRoute = createRoute({
  getParentRoute: () => docsSpaceRoute,
  path: "/new",
  component: DocsManualNew,
});

/**
 * Tab "Brief" dello spazio (`/docs/$projectId/brief`): pannello sola-lettura del
 * project brief. Rotta statica, ha priorità sul segmento dinamico `$slug`
 * (nessuna pagina può avere slug "brief").
 */
const docsBriefRoute = createRoute({
  getParentRoute: () => docsSpaceRoute,
  path: "/brief",
  component: DocsBriefView,
});

/**
 * Tab "Grafo" dello spazio (`/docs/$projectId/graph`): knowledge graph del
 * codice (graphify). Rotta statica, ha priorità sul segmento dinamico `$slug`
 * (nessuna pagina di documentazione può avere slug "graph"). Nessun loader: la
 * vista fa polling da sé e i suoi stati (toggle spento, mai generato, in corso)
 * non sono errori da anticipare.
 */
const docsGraphRoute = createRoute({
  getParentRoute: () => docsSpaceRoute,
  path: "/graph",
  component: DocsGraphView,
});

/**
 * Vista changelog dello spazio (`/docs/$projectId/releases`): timeline delle
 * release. Rotta statica, ha priorità sul segmento dinamico `$slug` (gli slug
 * delle release sono `release-…`, nessuna pagina si chiama "releases").
 */
const docsReleasesRoute = createRoute({
  getParentRoute: () => docsSpaceRoute,
  path: "/releases",
  component: DocsReleasesView,
});

/**
 * Pagina singola dello spazio: render markdown + badge sorgente/commit.
 * Prefetch best-effort della pagina (un 404 — pagina rimossa da una
 * rigenerazione — lo gestisce il componente inline, non il pannello d'errore).
 */
const docsPageRoute = createRoute({
  getParentRoute: () => docsSpaceRoute,
  path: "/$slug",
  loader: async ({ context, params }) => {
    await context.queryClient
      .ensureQueryData(docPageQueryOptions(params.projectId, params.slug))
      .catch(() => undefined);
  },
  component: DocsPageView,
});

/**
 * Sezione Monitor: lista dei server monitorati. Prefetch best-effort della lista
 * prima del render, così la useSuspenseQuery del componente non attende; un
 * errore non blocca la pagina (la query lo ripropone col retry/refetch).
 *
 * Fase 7, Task 10: fuori dal MENU per un `member` (contenuto d'infrastruttura,
 * stessa ragione di `/repositories` sopra), ma NON dietro una guardia —
 * nascosto dal menu ≠ inaccessibile: il link che le notifiche di monitoraggio
 * emettono verso `/monitor/servers/$serverId` deve continuare a funzionare, e
 * la pagina si degrada già bene per un member (`isAdmin && ...`).
 */
const monitorRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/monitor",
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(serversQueryOptions()).catch(() => undefined),
  component: MonitorListPage,
});

/**
 * Dettaglio di un server (`/monitor/servers/$serverId`): route DEFINITIVA,
 * allineata ai link emessi dalle notifiche (`${publicUrl}/monitor/servers/${id}`).
 * Grafici uPlot, servizi/check e soglie. Prefetch best-effort del dettaglio
 * prima del render, così la `useSuspenseQuery` del componente non attende; un
 * errore non blocca la pagina (la query lo ripropone col retry/refetch). Le
 * metriche restano nel componente (dipendono dal range in state locale).
 */
const serverDetailRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/monitor/servers/$serverId",
  loader: ({ context, params }) =>
    context.queryClient
      .ensureQueryData(serverDetailQueryOptions(params.serverId))
      .catch(() => undefined),
  component: ServerDetailPage,
});

/**
 * Inbox personale: la home operativa. Il loader prefetcha la vista d'ingresso
 * — le notifiche APERTE, senza filtro progetto — nella stessa forma canonica
 * dei filtri che usa il componente (`{ status: "open" }`, mai `{}`), altrimenti
 * la chiave di cache non coinciderebbe e si vedrebbe un doppio caricamento.
 * Best-effort: la pagina ha un proprio stato d'errore con retry, quindi un
 * fallimento qui non deve mandare la route all'error component.
 */
const inboxRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/inbox",
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient
        .ensureQueryData(inboxQueryOptions({ status: "open" }))
        .catch(() => undefined),
      // I progetti alimentano il select del filtro (useSuspenseQuery): qui
      // NON si cattura, come nelle altre rotte che li richiedono.
      context.queryClient.ensureQueryData(projectsQueryOptions),
    ]);
  },
  component: InboxPage,
});

/**
 * Pagina Posta (fase 6, Task 12): messaggi ed eventi TRATTATI dal poller
 * Google, per l'utente autenticato. `projects` e `myGoogleAccounts`
 * alimentano i select dei filtri (`useSuspenseQuery`, non catturati); la lista
 * e il contatore sono best-effort come l'inbox — la pagina ha un proprio
 * stato d'errore con retry.
 */
const mailRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/mail",
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(mailQueryOptions({})).catch(() => undefined),
      context.queryClient.ensureQueryData(mailSummaryQueryOptions).catch(() => undefined),
      context.queryClient.ensureQueryData(projectsQueryOptions),
      context.queryClient.ensureQueryData(myGoogleAccountsQueryOptions),
    ]);
  },
  component: MailPage,
});

/**
 * Sezione Calendario (fase 7b/9): la griglia giorno/settimana/mese e la
 * sidebar delle serie ricorrenti (spente di default) — l'equivalente della
 * pagina Posta per il calendario. `myGoogleAccounts` e `projects` alimentano
 * il filtro casella e il picker di progetto del form di serie;
 * `calendarSeriesQueryOptions` alimenta `CalendarSeriesSidebar`. Gli
 * appuntamenti visti li porta `calendarRangeQueryOptions`, dipendente dalla
 * vista/anchor correnti (stato del componente): non prefetchabile qui, la
 * `useQuery` della pagina lo richiede al montaggio.
 *
 * Fix di review (fase 9, Task 3): prima qui c'era ANCHE un
 * `ensureQueryData(calendarEventsQueryOptions({}))` — il keyset della 7b,
 * che nessun componente consuma più da quando la pagina usa `/range` — una
 * `GET /api/me/calendar` sprecata a ogni apertura del calendario. Rimosso.
 */
const calendarRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/calendar",
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(calendarSeriesQueryOptions()).catch(() => undefined),
      context.queryClient.ensureQueryData(projectsQueryOptions),
      context.queryClient.ensureQueryData(myGoogleAccountsQueryOptions),
    ]);
  },
  component: CalendarPage,
});

/**
 * Coda di rilascio (fase 8, Task 9-10): "una pagina sola, per il maintainer"
 * (design §4) — admin-only anche lato rotta server (403 per un member, non
 * solo bottoni degradati come per gli ambienti), quindi `requireAdmin` qui
 * evita di far vedere a un member uno stato di errore invece di reindirizzarlo
 * subito.
 */
const releaseQueueRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/release",
  beforeLoad: ({ context }) => requireAdmin(context.user.role),
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(releaseQueueQueryOptions).catch(() => undefined);
  },
  component: ReleaseQueuePage,
});

/**
 * Dettaglio di un'email (fase 7b, Task 8) — dalla fase 9, Task 5, la STESSA
 * pagina a tre colonne di `/mail` (`MailWorkspace`) con questo messaggio già
 * selezionato: il loader precarica quindi le STESSE query di `mailRoute`
 * (la lista resta visibile al centro, non solo il pannello di lettura),
 * così le `useSuspenseQuery` del componente non attendono. Il dettaglio del
 * SINGOLO messaggio (`mailDetailQueryOptions`) resta senza prefetch: a
 * differenza della lista, non serve finché non si arriva su una riga
 * precisa, e prefetchare ogni riga della lista sarebbe N chiamate per una
 * pagina che ne mostra una sola alla volta.
 */
const mailDetailRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/mail/$source/$id",
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(mailQueryOptions({})).catch(() => undefined),
      context.queryClient.ensureQueryData(mailSummaryQueryOptions).catch(() => undefined),
      context.queryClient.ensureQueryData(projectsQueryOptions),
      context.queryClient.ensureQueryData(myGoogleAccountsQueryOptions),
    ]);
  },
  component: MailDetailPage,
});

/**
 * Sezione Attività (standup giornaliero), visibile a ogni membro. Prefetch
 * best-effort del report di IERI (default del componente): la data vive nello
 * stato del componente, quindi il loader può solo precaricare il default; il
 * cambio data è gestito dal confine Suspense dentro la pagina. Un errore non
 * blocca la pagina (la query lo ripropone col retry/refetch).
 */
const activityRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/activity",
  // Il default della data DEVE coincidere con quello del componente
  // (`yesterdayUtc`), altrimenti il loader prefetcha una queryKey diversa da
  // quella richiesta al render → flash del Suspense + doppia fetch.
  loader: ({ context }) =>
    context.queryClient
      .ensureQueryData(activityReportQueryOptions(yesterdayUtc()))
      .catch(() => undefined),
  component: ActivityPage,
});

const teamRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/team",
  // Membri in cache prima del render; gli inviti (solo admin) si prefetchano
  // qui se il ruolo lo consente, altrimenti la sezione resta non montata e la
  // query non parte. Best-effort: un eventuale errore non blocca la pagina.
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(usersQueryOptions);
    if (context.user.role === "admin") {
      await context.queryClient.ensureQueryData(invitesQueryOptions).catch(() => undefined);
    }
  },
  component: TeamPage,
});

/**
 * Layout delle impostazioni: la sotto-navigazione + l'Outlet della sotto-rotta.
 * `/settings` da solo reindirizza ad Account (vedi settingsIndexRoute).
 */
const settingsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/settings",
  component: SettingsLayout,
});

const settingsIndexRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/settings/account" });
  },
});

const settingsAccountRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/account",
  // `?google=<esito>`: è qui che il callback OAuth del server rimanda dopo il
  // consenso. Lo schema lo accetta anche sbagliato (`.catch(undefined)`) — la
  // barra degli indirizzi non deve poter rompere la pagina.
  validateSearch: (search) => settingsAccountSearchSchema.parse(search),
  // Progetti seguiti, preferenze di notifica e caselle Google sono sezioni
  // della pagina: si precaricano qui insieme alla lista progetti (che alimenta
  // le checkbox), così le useSuspenseQuery della pagina non attendono.
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(projectsQueryOptions),
      context.queryClient.ensureQueryData(myFollowsQueryOptions),
      context.queryClient.ensureQueryData(notificationPrefsQueryOptions),
      context.queryClient.ensureQueryData(myGoogleAccountsQueryOptions),
    ]);
  },
  component: SettingsAccountPage,
});

/**
 * Token di accesso personali (per-utente): visibile a tutti, niente
 * `requireAdmin`. Prefetch best-effort della lista prima del render, così la
 * `useSuspenseQuery` del componente non attende; un errore non blocca la pagina.
 */
const settingsAccessTokensRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/access-tokens",
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(patsQueryOptions).catch(() => undefined);
  },
  component: SettingsAccessTokensPage,
});

/**
 * Guardia comune alle sotto-rotte admin: un member che digita l'URL viene
 * rimandato ad Account invece di montare una sezione che il server rifiuterebbe.
 */
function requireAdmin(role: string): void {
  if (role !== "admin") throw redirect({ to: "/settings/account" });
}

const settingsAutomationRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/automation",
  beforeLoad: ({ context }) => requireAdmin(context.user.role),
  // Prefetch best-effort: la sezione monta senza attese; un errore non blocca.
  loader: async ({ context }) => {
    await context.queryClient
      .ensureQueryData(automationSettingsQueryOptions)
      .catch(() => undefined);
  },
  component: SettingsAutomationPage,
});

const settingsNotificationsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/notifications",
  beforeLoad: ({ context }) => requireAdmin(context.user.role),
  loader: async ({ context }) => {
    await context.queryClient
      .ensureQueryData(notificationSettingsQueryOptions)
      .catch(() => undefined);
  },
  component: SettingsNotificationsPage,
});

const settingsUsageRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/usage",
  beforeLoad: ({ context }) => requireAdmin(context.user.role),
  component: SettingsUsagePage,
});

const settingsGitAccountsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/git-accounts",
  beforeLoad: ({ context }) => requireAdmin(context.user.role),
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(gitAccountsQueryOptions).catch(() => undefined);
  },
  component: SettingsGitAccountsPage,
});

const settingsStorageRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/storage",
  beforeLoad: ({ context }) => requireAdmin(context.user.role),
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(instanceSettingsQueryOptions).catch(() => undefined);
  },
  component: SettingsStoragePage,
});

const settingsSlackRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/slack",
  beforeLoad: ({ context }) => requireAdmin(context.user.role),
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(instanceSettingsQueryOptions).catch(() => undefined);
  },
  component: SettingsSlackPage,
});

/**
 * Il registro dei Google Workspace (fase 6) e, dalla fase 6c, la sezione
 * «Posta ammessa» (`GET /api/settings/mail-admission`, aperta a OGNI utente
 * autenticato — vedi il commento sulla rotta lato server). NIENTE
 * `beforeLoad: requireAdmin` qui, a differenza delle altre sotto-rotte admin
 * di questo file: un member deve poter atterrare su questa pagina per
 * vedere (in sola lettura) l'ammissione della posta. `SettingsGooglePage`
 * decide da sé, col ruolo, se montare `GoogleWorkspacesSection` (quella sì
 * solo admin, la rotta `google-workspaces` risponde 403 a un member).
 * Prefetch best-effort di entrambe: quello dei Workspace fallisce in
 * silenzio per un member (403 atteso, non un errore da propagare).
 */
const settingsGoogleRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/google",
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(googleWorkspacesQueryOptions).catch(() => undefined),
      context.queryClient.ensureQueryData(mailAdmissionQueryOptions).catch(() => undefined),
    ]);
  },
  component: SettingsGooglePage,
});

const settingsAiProvidersRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/ai-providers",
  beforeLoad: ({ context }) => requireAdmin(context.user.role),
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(aiProvidersQueryOptions).catch(() => undefined);
  },
  component: SettingsAiProvidersPage,
});

/**
 * Registro plugin d'istanza (solo admin): plugin di Claude Code abilitabili per
 * progetto. Prefetch best-effort come le altre sotto-rotte admin.
 */
const settingsPluginsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/plugins",
  beforeLoad: ({ context }) => requireAdmin(context.user.role),
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(pluginsQueryOptions).catch(() => undefined);
  },
  component: SettingsPluginsPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  registerRoute,
  setupRoute,
  authedRoute.addChildren([
    indexRoute,
    ticketsRoute,
    ticketDetailRoute,
    boardRoute,
    backlogRoute,
    backlogDetailRoute,
    projectsRoute,
    projectDetailRoute,
    projectRoadmapRoute,
    briefRoute,
    widgetConversationsRoute,
    repositoryNewRoute,
    repositoriesIndexRoute,
    repositoryStandaloneNewRoute,
    repositoryDetailRoute,
    docsRoute,
    projectDocsRoute,
    projectDecisionsRoute,
    docsSpaceRoute.addChildren([
      docsSpaceIndexRoute,
      docsManualNewRoute,
      docsBriefRoute,
      docsGraphRoute,
      docsReleasesRoute,
      docsPageRoute,
    ]),
    monitorRoute,
    serverDetailRoute,
    activityRoute,
    inboxRoute,
    mailRoute,
    mailDetailRoute,
    calendarRoute,
    releaseQueueRoute,
    teamRoute,
    settingsRoute.addChildren([
      settingsIndexRoute,
      settingsAccountRoute,
      settingsAccessTokensRoute,
      settingsAutomationRoute,
      settingsNotificationsRoute,
      settingsUsageRoute,
      settingsGitAccountsRoute,
      settingsStorageRoute,
      settingsSlackRoute,
      settingsGoogleRoute,
      settingsAiProvidersRoute,
      settingsPluginsRoute,
    ]),
  ]),
]);

/** `history` iniettabile: i test usano una memory history. */
export function createAppRouter(queryClient: QueryClient, history?: RouterHistory) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: "intent",
    // Un 401 da un loader (sessione scaduta ad app montata) reindirizza al
    // login; gli altri errori mostrano il pannello con retry.
    defaultErrorComponent: RouteError,
    history,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
