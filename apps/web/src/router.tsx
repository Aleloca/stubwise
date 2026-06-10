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
import { BoardPage } from "./routes/board";
import { LoginPage } from "./routes/login";
import { ProjectsPage } from "./routes/projects";
import { SettingsPage } from "./routes/settings";
import { SetupPage } from "./routes/setup";
import { TicketsPage } from "./routes/tickets";

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
  component: TicketsPage,
});

const boardRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/board",
  component: BoardPage,
});

const projectsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/projects",
  component: ProjectsPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/settings",
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  setupRoute,
  authedRoute.addChildren([
    indexRoute,
    ticketsRoute,
    boardRoute,
    projectsRoute,
    settingsRoute,
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
