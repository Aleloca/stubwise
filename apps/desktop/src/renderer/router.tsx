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
import { ProjectNotFound } from "./pages/ProjectNotFound";
import { useProject } from "./data/queries";
import { APP_ROUTES, PROJECT_SECTIONS, isProjectSection } from "./data/routes";
import { canSeeAdmin, useViewer } from "./data/viewer";

const rootRoute = createRootRoute({ component: AppLayout });

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
  return <Placeholder titleKey="nav.admin" />;
}

const appRoutes = APP_ROUTES.map((name) =>
  createRoute({
    getParentRoute: () => rootRoute,
    path: `/${name}`,
    component: name === "admin" ? AdminPage : () => <Placeholder titleKey={`nav.${name}`} />,
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
  const { data: project, isPending } = useProject(code);
  if (isPending) return null;
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
