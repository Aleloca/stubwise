import {
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  redirect,
  type RouterHistory,
} from "@tanstack/react-router";
import { AppLayout } from "./layout/AppLayout";
import { Placeholder } from "./pages/Placeholder";
import { NotFound } from "./pages/NotFound";
import { ProjectNotFound } from "./pages/ProjectNotFound";
import { useTranslation } from "react-i18next";
import { useProject } from "./data/queries";
import { APP_ROUTES, PROJECT_SECTIONS, isProjectSection } from "./data/routes";
import { canSeeAdmin, useViewer } from "./data/viewer";

const rootRoute = createRootRoute({ component: AppLayout, notFoundComponent: NotFound });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/home", replace: true });
  },
});

function AdminPage() {
  const { viewer } = useViewer();
  if (!canSeeAdmin(viewer)) return <Navigate to="/home" replace />;
  return <Placeholder titleKey="nav.admin" quiet />;
}

const appRoutes = APP_ROUTES.map((name) =>
  createRoute({
    getParentRoute: () => rootRoute,
    path: `/${name}`,
    component: name === "admin" ? AdminPage : () => <Placeholder titleKey={`nav.${name}`} quiet />,
  }),
);

const projectIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/p/$code",
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/p/$code/$section",
      params: { code: params.code, section: "overview" },
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
  return <Placeholder titleKey={`project.sections.${section}`} />;
}

const projectSectionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/p/$code/$section",
  beforeLoad: ({ params }) => {
    if (!isProjectSection(params.section)) {
      throw redirect({
        to: "/p/$code/$section",
        params: { code: params.code, section: "overview" },
        replace: true,
      });
    }
  },
  component: ProjectSectionPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  ...appRoutes,
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
