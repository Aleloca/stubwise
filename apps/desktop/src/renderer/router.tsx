import {
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  redirect,
  useSearch,
  type RouterHistory,
} from "@tanstack/react-router";
import { AppLayout } from "./layout/AppLayout";
import { Placeholder } from "./pages/Placeholder";
import { NotFound } from "./pages/NotFound";
import { ProjectNotFound } from "./pages/ProjectNotFound";
import { useTranslation } from "react-i18next";
import { useProject } from "./data/queries";
import {
  APP_ROUTES,
  PROJECT_SECTIONS,
  isProjectSection,
  isValidSearchParam,
} from "./data/routes";
import { can, canSeeAdmin, useViewer } from "./data/viewer";
import type { FilterCriteria } from "./data/types";
import { parseCriteria } from "./domain/filters";
import { TasksPage } from "./pages/tasks/TasksPage";
import { AllFiltersPage } from "./pages/filters/AllFiltersPage";
import { FilterPage } from "./pages/filters/FilterPage";
import { HomePage } from "./pages/home/HomePage";
import { MyWeekPage } from "./pages/week/MyWeekPage";

/** La ricerca che ogni route accetta (`?task=` apre il pannello, gli altri li montano i dialoghi). */
export interface AppSearch {
  task?: string;
  newTask?: string;
  project?: string;
  newRequest?: string;
  request?: string;
  view?: string;
  group?: string;
  /** Criteri di una pagina di task (oggetto JSON nell'indirizzo). */
  filters?: FilterCriteria;
}

const SEARCH_KEYS = [
  "task",
  "newTask",
  "project",
  "newRequest",
  "request",
  "view",
  "group",
] as const;

/**
 * Un parametro malformato si scarta in silenzio (non rompe la route). `request`,
 * `view`, `group` e `filters` valgono solo sulla loro route: lì vengono
 * riletti dal componente. `filters` arriva già come oggetto (il parser
 * dell'indirizzo legge il JSON): si tiene ciò che ha la forma di criteri.
 */
function validateSearch(search: Record<string, unknown>): AppSearch {
  const out: AppSearch = {};
  for (const key of SEARCH_KEYS) {
    // Il parser dell'indirizzo legge `1` come numero: si rilegge come testo.
    const raw = search[key];
    const value = typeof raw === "number" ? String(raw) : raw;
    // Esplicitamente `undefined`: il router fonde la ricerca grezza con questa,
    // e una chiave solo omessa resterebbe com'era scritta nell'indirizzo.
    out[key] = undefined;
    if (typeof value !== "string") continue;
    // `request` e `view` dipendono dal percorso: qui si controlla la forma, la route decide.
    const shapeOk =
      key === "request"
        ? /^[\w-]+$/.test(value)
        : key === "view" || key === "group"
          ? /^[a-z-]+$/.test(value)
          : false;
    if (shapeOk || isValidSearchParam("", key, value)) out[key] = value;
  }
  out.filters = parseCriteria(search.filters) ?? undefined;
  return out;
}

const rootRoute = createRootRoute({
  component: AppLayout,
  notFoundComponent: NotFound,
  validateSearch,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/home", replace: true });
  },
});

function PlanningPage() {
  const { viewer } = useViewer();
  // «Planning» trasversale: solo a chi ha `planning.others` in almeno un progetto.
  if (!can(viewer, "planning.others")) return <Navigate to="/home" replace />;
  return <Placeholder titleKey="nav.planning" />;
}

function FilterRoutePage() {
  const { id } = filterRoute.useParams();
  return <FilterPage id={id} />;
}

/**
 * `/home`: la Home a blocchi; `?view=week` è La mia settimana a pagina
 * intera (Task 10). Cambiare persona rimonta la Home: nessuna modifica a
 * metà della persona precedente resta aperta.
 */
function HomeRoutePage() {
  const { viewer } = useViewer();
  const search = useSearch({ strict: false }) as { view?: string };
  if (search.view === "week") return <MyWeekPage key={viewer.personId} />;
  return <HomePage key={viewer.personId} />;
}

function AdminPage() {
  const { viewer } = useViewer();
  if (!canSeeAdmin(viewer)) return <Navigate to="/home" replace />;
  return <Placeholder titleKey="nav.admin" />;
}

function pageOf(name: (typeof APP_ROUTES)[number]) {
  if (name === "admin") return AdminPage;
  if (name === "planning") return PlanningPage;
  if (name === "filters") return AllFiltersPage;
  if (name === "home") return HomeRoutePage;
  return () => <Placeholder titleKey={`nav.${name}`} />;
}

const appRoutes = APP_ROUTES.map((name) =>
  createRoute({ getParentRoute: () => rootRoute, path: `/${name}`, component: pageOf(name) }),
);

const filterRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/filters/$id",
  component: FilterRoutePage,
});

/** Un codice progetto in minuscolo (`#/p/aud`) si riporta alle maiuscole, conservando la ricerca. */
function upperCaseCode(code: string): boolean {
  return code !== code.toUpperCase();
}

const projectIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/p/$code",
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/p/$code/$section",
      params: { code: params.code.toUpperCase(), section: "overview" },
      search: (prev) => prev,
      replace: true,
    });
  },
});

function ProjectSectionPage() {
  const { code, section } = projectSectionRoute.useParams();
  const { t } = useTranslation();
  const { data: project, isPending, isError, refetch } = useProject(code);
  if (isError) {
    return (
      <section role="alert" className="flex h-full flex-col items-start gap-3 p-8">
        <p className="text-md text-ink">{t("project.error")}</p>
        <button
          type="button"
          onClick={() => void refetch()}
          className="rounded-md border border-rule-strong px-3 py-1.5 text-sm font-medium text-ink hover:bg-ink/6"
        >
          {t("project.retry")}
        </button>
      </section>
    );
  }
  if (isPending) {
    return (
      <p role="status" className="p-8 text-sm text-ink-muted">
        {t("project.loading")}
      </p>
    );
  }
  if (!project) return <ProjectNotFound />;
  const def = PROJECT_SECTIONS.find((s) => s.id === section);
  const needed = def && "module" in def ? def.module : undefined;
  if (needed && !project.modules.includes(needed)) {
    return <Navigate to="/p/$code/$section" params={{ code, section: "overview" }} replace />;
  }
  if (section === "tasks") return <TasksPage projectCode={project.code} />;
  return <Placeholder titleKey={`project.sections.${section}`} />;
}

const projectSectionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/p/$code/$section",
  beforeLoad: ({ params }) => {
    const section = isProjectSection(params.section) ? params.section : "overview";
    if (section !== params.section || upperCaseCode(params.code)) {
      throw redirect({
        to: "/p/$code/$section",
        params: { code: params.code.toUpperCase(), section },
        search: (prev) => prev,
        replace: true,
      });
    }
  },
  component: ProjectSectionPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  ...appRoutes,
  filterRoute,
  projectIndexRoute,
  projectSectionRoute,
]);

export function createAppRouter(history: RouterHistory) {
  return createRouter({ routeTree, history });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
