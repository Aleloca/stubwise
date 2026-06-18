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
  automationSettingsQueryOptions,
  boardTicketsQueryOptions,
  commentsQueryOptions,
  gitAccountsQueryOptions,
  instanceSettingsQueryOptions,
  invitesQueryOptions,
  milestonesQueryOptions,
  notificationSettingsQueryOptions,
  projectQueryOptions,
  projectsQueryOptions,
  ticketAttachmentsQueryOptions,
  ticketJobsQueryOptions,
  ticketLinksQueryOptions,
  ticketQueryOptions,
  ticketsInfiniteQueryOptions,
  ticketUsageQueryOptions,
  usersQueryOptions,
} from "./lib/queries";
import { boardSearchSchema, BoardPage } from "./routes/board";
import { LoginPage } from "./routes/login";
import { ProjectDetailPage } from "./routes/projects/$slug";
import { ProjectsPage } from "./routes/projects/index";
import { NewProjectPage } from "./routes/projects/new";
import { registerSearchSchema, RegisterPage } from "./routes/register";
import { SettingsAccountPage } from "./routes/settings/account";
import { SettingsAutomationPage } from "./routes/settings/automation";
import { SettingsGitAccountsPage } from "./routes/settings/git-accounts";
import { SettingsLayout } from "./routes/settings/layout";
import { SettingsNotificationsPage } from "./routes/settings/notifications";
import { SettingsSlackPage } from "./routes/settings/slack";
import { SettingsStoragePage } from "./routes/settings/storage";
import { SetupPage } from "./routes/setup";
import { TeamPage } from "./routes/team";
import { TicketDetailPage } from "./routes/tickets/$id";
import { ticketSearchSchema, TicketsPage } from "./routes/tickets/index";

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
      context.queryClient.ensureInfiniteQueryData(ticketsInfiniteQueryOptions(deps)),
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

const projectsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/projects",
  loader: ({ context }) => context.queryClient.ensureQueryData(projectsQueryOptions),
  component: ProjectsPage,
});

const projectNewRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/projects/new",
  // Creazione riservata agli admin: un member che digita l'URL torna alla
  // lista invece di compilare un form che il server rifiuterebbe con 403.
  beforeLoad: ({ context }) => {
    if (context.user.role !== "admin") throw redirect({ to: "/projects" });
  },
  component: NewProjectPage,
});

const projectDetailRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/projects/$slug",
  loader: async ({ context, params }) => {
    // Il progetto prima (serve l'id per le milestone), poi le sue milestone:
    // il MilestoneManager usa useSuspenseQuery e non deve attendere al render.
    const project = await context.queryClient.ensureQueryData(projectQueryOptions(params.slug));
    await context.queryClient.ensureQueryData(milestonesQueryOptions(project.id));
  },
  component: ProjectDetailPage,
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
  component: SettingsAccountPage,
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
    await context.queryClient.ensureQueryData(automationSettingsQueryOptions).catch(() => undefined);
  },
  component: SettingsAutomationPage,
});

const settingsNotificationsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/notifications",
  beforeLoad: ({ context }) => requireAdmin(context.user.role),
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(notificationSettingsQueryOptions).catch(() => undefined);
  },
  component: SettingsNotificationsPage,
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

const routeTree = rootRoute.addChildren([
  loginRoute,
  registerRoute,
  setupRoute,
  authedRoute.addChildren([
    indexRoute,
    ticketsRoute,
    ticketDetailRoute,
    boardRoute,
    projectsRoute,
    projectNewRoute,
    projectDetailRoute,
    teamRoute,
    settingsRoute.addChildren([
      settingsIndexRoute,
      settingsAccountRoute,
      settingsAutomationRoute,
      settingsNotificationsRoute,
      settingsGitAccountsRoute,
      settingsStorageRoute,
      settingsSlackRoute,
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
