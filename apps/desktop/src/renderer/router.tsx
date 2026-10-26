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
import { useChatChannels, useProject } from "./data/queries";
import { APP_ROUTES, PROJECT_SECTIONS, isProjectSection, isValidSearchParam } from "./data/routes";
import { can, canSeeAdmin, useViewer } from "./data/viewer";
import type { FilterCriteria } from "./data/types";
import { parseCriteria } from "./domain/filters";
import { TasksPage } from "./pages/tasks/TasksPage";
import { AllFiltersPage } from "./pages/filters/AllFiltersPage";
import { FilterPage } from "./pages/filters/FilterPage";
import { HomePage } from "./pages/home/HomePage";
import { MyWeekPage } from "./pages/week/MyWeekPage";
import { PlanningPage } from "./pages/planning/PlanningPage";
import { RequestsPage } from "./pages/requests/RequestsPage";
import { OverviewPage } from "./pages/overview/OverviewPage";
import { AllProjectsPage } from "./pages/projects/AllProjectsPage";
import { ProjectSettingsPage } from "./pages/settings/ProjectSettingsPage";
import { ClaudePage, ConversationPage } from "./pages/claude/ClaudePage";
import { ChannelView, chatHref, type ChannelHref } from "./pages/chat/ChannelView";
import { ChatPage } from "./pages/chat/ChatPage";
import { rememberLastChannel } from "./pages/chat/column";
import { SEARCH_PARAM_KEYS, isSearchParamValue } from "./pages/chat/search";
import { useChatChannel } from "./data/queries";
import { useEffect, useRef } from "react";
import { DocsHome, DocsProjectGate } from "./pages/docs/DocsHome";
import { DocSpace, RepoIndex } from "./pages/docs/DocSpace";
import { DocPageRoute } from "./pages/docs/DocPageView";
import { DocGraph } from "./pages/docs/DocGraph";
import { DocReleases } from "./pages/docs/DocReleases";
import { RepoBrief } from "./pages/docs/RepoBrief";
import { EditManualPageRoute, NewManualPageRoute } from "./pages/docs/ManualPageForm";
import { DrivePage } from "./pages/drive/DrivePage";
import { DRIVE_SEARCH_KEYS, isDriveSearchValue } from "./pages/drive/driveFilters";
import { MailPage } from "./pages/mail/MailPage";
import { MAIL_SEARCH_KEYS, NO_PROJECT, isMailSearchValue } from "./pages/mail/mailFilters";
import { CalendarPage } from "./pages/calendar/CalendarPage";
import { CALENDAR_SEARCH_KEYS } from "./pages/calendar/calendarParams";

/** La ricerca che ogni route accetta (`?task=` apre il pannello, gli altri li montano i dialoghi). */
export interface AppSearch {
  task?: string;
  newTask?: string;
  project?: string;
  newRequest?: string;
  request?: string;
  /** Con `request`: la richiesta si apre nella conversazione di refine (`1`). */
  refine?: string;
  /** Il brief settimanale aperto nel pannello (Overview). */
  brief?: string;
  view?: string;
  group?: string;
  /** Criteri di una pagina di task (oggetto JSON nell'indirizzo). */
  filters?: FilterCriteria;
  /** Destinazione «Claude»: l'elenco aperto (`live`, `mine`, `public`, `finished`). */
  scope?: string;
  /** Destinazione «Claude»: la domanda scritta nella palette («Ask Claude…»), da rivedere e mandare. */
  ask?: string;
  /** All projects → Activity, per persona: il giorno (YYYY-MM-DD). */
  date?: string;
  /** All projects → Activity, per persona: il reparto. */
  dept?: string;
  /** Chat: il thread aperto nel pannello (l'id della radice). */
  thread?: string;
  /** Chat: il messaggio da portare in vista (link, menzione, ricerca). */
  message?: string;
  /** Chat: le impostazioni del canale aperte nel pannello (`1`). */
  settings?: string;
  /** Chat: il dialogo «New message» (`1`). */
  newMessage?: string;
  /** Chat: il dialogo «New channel» (`1`, `company` o il codice del progetto). */
  newChannel?: string;
  /** Chat → ricerca: la query e i filtri (`pages/chat/search.ts`). */
  q?: string;
  in?: string;
  by?: string;
  when?: string;
  since?: string;
  until?: string;
  att?: string;
  cit?: string;
  ppl?: string;
  /** Il dettaglio di un file del Drive (`AUD-F7`): vale ovunque, come `task`. */
  file?: string;
  /** Drive: ordinamento e filtri (`pages/drive/driveFilters.ts`). */
  sort?: string;
  type?: string;
  source?: string;
  addedBy?: string;
  prj?: string;
  hidden?: string;
  /** Posta: la casella e l'importanza (`pages/mail/mailFilters.ts`); `project` e `q` sopra. */
  mailbox?: string;
  importance?: string;
  /** Posta: la nuova email nel pannello di lettura (`new`). */
  compose?: string;
  /** Calendario: l'evento e la serie aperti nel pannello (`view` e `date` sopra). */
  event?: string;
  series?: string;
  /** Calendario: ⌘K «New meeting» apre il dialogo all'arrivo (`1`). */
  newMeeting?: string;
}

const SEARCH_KEYS = [
  "task",
  "newTask",
  "project",
  "newRequest",
  "request",
  "refine",
  "brief",
  "view",
  "group",
  "scope",
  "ask",
  "date",
  "dept",
  "thread",
  "message",
  "settings",
  "newMessage",
  "newChannel",
  ...SEARCH_PARAM_KEYS,
  "file",
  ...DRIVE_SEARCH_KEYS,
  ...MAIL_SEARCH_KEYS,
  ...CALENDAR_SEARCH_KEYS,
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
      (SEARCH_PARAM_KEYS as readonly string[]).includes(key)
        ? isSearchParamValue(key, value)
        : (DRIVE_SEARCH_KEYS as readonly string[]).includes(key)
          ? isDriveSearchValue(key, value)
          : (MAIL_SEARCH_KEYS as readonly string[]).includes(key) ||
              (key === "project" && value === NO_PROJECT)
            ? isMailSearchValue(key, value)
            : key === "request" ||
      key === "event" ||
      key === "series" ||
      key === "brief" ||
      key === "dept" ||
      key === "thread" ||
      key === "message"
        ? /^[\w-]+$/.test(value)
        : key === "date"
          ? /^\d{4}-\d{2}-\d{2}$/.test(value)
          : key === "view" || key === "group" || key === "scope"
            ? /^[a-z-]+$/.test(value)
            : key === "ask"
              ? value.trim().length > 0 && value.length <= ASK_MAX
              : key === "refine" || key === "settings" || key === "newMeeting"
                ? value === "1"
                : false;
    if (shapeOk || isValidSearchParam("", key, value)) out[key] = value;
  }
  out.filters = parseCriteria(search.filters) ?? undefined;
  return out;
}

/** Quanto può essere lunga una domanda portata dalla palette. */
const ASK_MAX = 2000;

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

/** Cambiare persona rimonta la pagina: nessuna carta presa né menu a metà resta aperto. */
function PlanningRoutePage() {
  const { viewer } = useViewer();
  // «Planning» trasversale: solo a chi ha `planning.others` in almeno un progetto.
  if (!can(viewer, "planning.others")) return <Navigate to="/home" replace />;
  return <PlanningPage key={viewer.personId} />;
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

/** Cambiare persona rimonta il portafoglio: filtri e dialoghi della persona di prima non restano. */
function ProjectsRoutePage() {
  const { viewer } = useViewer();
  return <AllProjectsPage key={viewer.personId} />;
}

/** Il Drive di tutti i progetti: cambiare persona lo rimonta (caricamenti, selezione e menu via). */
function DriveRoutePage() {
  const { viewer } = useViewer();
  return <DrivePage key={viewer.personId} />;
}

/**
 * La Posta (`/mail`, `/mail/<threadId>`): cambiare persona la rimonta —
 * schede in modifica, passi «fuori dal progetto», menu e conversazione
 * della persona di prima non restano.
 */
function MailRoutePage() {
  const { viewer } = useViewer();
  // Sopravvive al rimontaggio: la pagina nuova sa che la persona è appena cambiata.
  const switchedPersona = useRef(false);
  return <MailPage key={viewer.personId} switchedPersona={switchedPersona} />;
}

/**
 * Il Calendario (`/calendar?view&date&event&series`): cambiare persona lo
 * rimonta — dialoghi, spostamenti e menu della persona di prima non restano.
 */
function CalendarRoutePage() {
  const { viewer } = useViewer();
  return <CalendarPage key={viewer.personId} />;
}

function AdminPage() {
  const { viewer } = useViewer();
  if (!canSeeAdmin(viewer)) return <Navigate to="/home" replace />;
  return <Placeholder titleKey="nav.admin" bodyKey="placeholder.pages.admin" />;
}

function pageOf(name: (typeof APP_ROUTES)[number]) {
  if (name === "admin") return AdminPage;
  if (name === "planning") return PlanningRoutePage;
  if (name === "filters") return AllFiltersPage;
  if (name === "home") return HomeRoutePage;
  if (name === "projects") return ProjectsRoutePage;
  if (name === "claude") return ClaudePage;
  if (name === "chat") return ChatPage;
  if (name === "drive") return DriveRoutePage;
  if (name === "mail") return MailRoutePage;
  if (name === "calendar") return CalendarRoutePage;
  return () => <Placeholder titleKey={`nav.${name}`} bodyKey={`placeholder.pages.${name}`} />;
}

const appRoutes = APP_ROUTES.map((name) =>
  createRoute({ getParentRoute: () => rootRoute, path: `/${name}`, component: pageOf(name) }),
);

/**
 * Una conversazione aperta nella Posta: figlia di `/mail`, così la pagina
 * (elenco, scorrimento, filtri) resta montata cambiando conversazione. La
 * legge `MailPage` dai parametri; qui non si disegna nulla.
 */
const mailRoute = appRoutes[APP_ROUTES.indexOf("mail")]!;
const mailThreadRoute = createRoute({
  getParentRoute: () => mailRoute,
  path: "$threadId",
  component: () => null,
});

function ConversationRoutePage() {
  const { id } = conversationRoute.useParams();
  return <ConversationPage id={id} />;
}

/** Una conversazione o una sessione di lavoro con Claude. */
const conversationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/claude/$id",
  component: ConversationRoutePage,
});

/**
 * Un canale della Chat. Cambiare persona (o canale) lo rimonta: nessun
 * messaggio, bozza, riga «New» o invio a metà di chi guardava prima resta.
 * La colonna e l'atterraggio di `/chat` arrivano con la destinazione.
 */
function ChatChannelRoutePage() {
  const { channelId } = chatChannelRoute.useParams();
  const { viewer } = useViewer();
  const search = useSearch({ strict: false }) as { message?: string; thread?: string };
  // L'atterraggio di `#/chat` riapre l'ultimo canale aperto (shape chat.md §6).
  useEffect(() => rememberLastChannel(viewer.personId, channelId), [viewer.personId, channelId]);
  return (
    <ChannelView
      key={`${viewer.personId}:${channelId}`}
      channelId={channelId}
      focusMessageId={search.message}
      openThreadId={search.thread}
    />
  );
}

const chatChannelRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/chat/$channelId",
  component: ChatChannelRoutePage,
});

/** I link del canale dentro la sezione Chat del progetto: restano nel progetto. */
const projectChatHref =
  (code: string, channelId: string): ChannelHref =>
  (params) =>
    chatHref(channelId)(params).replace(/^#\/chat\//, `#/p/${code}/chat/`);

/**
 * La sezione Chat del progetto (`/p/<CODE>/chat`): atterra sul «general»
 * del progetto. Lo stesso `ChannelView` e gli stessi letti della Chat.
 */
function ProjectChatLanding({ projectId, code }: { projectId: string; code: string }) {
  const { t } = useTranslation();
  const { data } = useChatChannels({ scope: "project", projectId });
  if (!data) {
    return (
      <p role="status" className="p-8 text-sm text-ink-muted">
        {t("chat.channel.loading")}
      </p>
    );
  }
  const general = data.find((c) => c.isGeneral) ?? data.find((c) => c.isMember && !c.archived);
  if (!general) {
    return (
      <Placeholder titleKey="project.sections.chat" bodyKey="chat.project.noChannels" />
    );
  }
  return (
    <Navigate
      to="/p/$code/chat/$channelId"
      params={{ code, channelId: general.id }}
      replace
    />
  );
}

function ProjectChatChannelRoutePage() {
  const { code, channelId } = projectChatChannelRoute.useParams();
  const { viewer } = useViewer();
  const search = useSearch({ strict: false }) as { message?: string; thread?: string };
  const { data: project, isPending } = useProject(code);
  const channel = useChatChannel(channelId);
  if (isPending) return null;
  if (!project) return <ProjectNotFound />;
  // Un canale di un altro ambito si apre nella Chat, non qui.
  if (channel.data && channel.data.projectId !== project.id) {
    return (
      <Navigate
        to="/chat/$channelId"
        params={{ channelId }}
        search={(prev: Record<string, unknown>) => prev}
        replace
      />
    );
  }
  return (
    <ChannelView
      key={`${viewer.personId}:${channelId}`}
      channelId={channelId}
      hrefFor={projectChatHref(project.code, channelId)}
      focusMessageId={search.message}
      openThreadId={search.thread}
    />
  );
}

const projectChatChannelRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/p/$code/chat/$channelId",
  beforeLoad: ({ params }) => {
    if (upperCaseCode(params.code)) {
      throw redirect({
        to: "/p/$code/chat/$channelId",
        params: { code: params.code.toUpperCase(), channelId: params.channelId },
        search: (prev) => prev,
        replace: true,
      });
    }
  },
  component: ProjectChatChannelRoutePage,
});

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
  const { viewer } = useViewer();
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
  if (section === "planning") {
    return <PlanningPage key={`${project.code}:${viewer.personId}`} projectCode={project.code} />;
  }
  if (section === "overview") {
    return <OverviewPage key={`${project.code}:${viewer.personId}`} projectCode={project.code} />;
  }
  if (section === "requests") {
    return <RequestsPage key={`${project.code}:${viewer.personId}`} projectCode={project.code} />;
  }
  if (section === "chat") return <ProjectChatLanding projectId={project.id} code={project.code} />;
  if (section === "drive") {
    return <DrivePage key={`${project.code}:${viewer.personId}`} projectCode={project.code} />;
  }
  if (section === "settings") {
    return (
      <ProjectSettingsPage key={`${project.code}:${viewer.personId}`} projectCode={project.code} />
    );
  }
  return (
    <Placeholder
      titleKey={`project.sections.${section}`}
      bodyKey={`placeholder.sections.${section}`}
    />
  );
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

/**
 * La sezione Docs del progetto (area 5): pagina iniziale, e lo spazio di un
 * repository (per nome) con le sue viste — indice, pagina per slug, pagina
 * manuale nuova e modifica. Le route letterali (`docs`, `new`, `edit`)
 * vincono sulle parametriche (`$section`, `$slug`) per specificità; uno
 * slug `new` non può esistere (riservato dal livello dati). Cambiare
 * persona rimonta la vista: niente form né stato della persona di prima.
 */
function DocsHomeRoutePage() {
  const { code } = docsHomeRoute.useParams();
  const { viewer } = useViewer();
  return (
    <DocsProjectGate code={code}>
      {(project) => <DocsHome key={`${project.code}:${viewer.personId}`} project={project} />}
    </DocsProjectGate>
  );
}

function DocSpaceRoutePage() {
  const { code, repo } = docSpaceRoute.useParams();
  const { viewer } = useViewer();
  return (
    <DocsProjectGate code={code}>
      {(project) => (
        <DocSpace key={`${project.code}:${repo}:${viewer.personId}`} project={project} repo={repo} />
      )}
    </DocsProjectGate>
  );
}

/** Un codice progetto in minuscolo nelle route dei Docs: si riporta alle maiuscole. */
function upperCaseDocsCode(code: string, pathname: string) {
  if (upperCaseCode(code)) {
    throw redirect({
      href: pathname.replace(`/p/${code}/`, `/p/${code.toUpperCase()}/`),
      replace: true,
    });
  }
}

const docsHomeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/p/$code/docs",
  beforeLoad: ({ params, location }) => upperCaseDocsCode(params.code, location.pathname),
  component: DocsHomeRoutePage,
});

const docSpaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/p/$code/docs/$repo",
  beforeLoad: ({ params, location }) => upperCaseDocsCode(params.code, location.pathname),
  component: DocSpaceRoutePage,
});

const docSpaceIndexRoute = createRoute({
  getParentRoute: () => docSpaceRoute,
  path: "/",
  component: RepoIndex,
});

const docNewPageRoute = createRoute({
  getParentRoute: () => docSpaceRoute,
  path: "new",
  component: NewManualPageRoute,
});

// Le viste dello spazio (Task 3): letterali, vincono su `$slug` (slug riservati).
const docBriefRoute = createRoute({
  getParentRoute: () => docSpaceRoute,
  path: "brief",
  component: RepoBrief,
});

const docReleasesRoute = createRoute({
  getParentRoute: () => docSpaceRoute,
  path: "releases",
  component: DocReleases,
});

const docGraphRoute = createRoute({
  getParentRoute: () => docSpaceRoute,
  path: "graph",
  component: DocGraph,
});

function DocPageRoutePage() {
  const { slug } = docPageRoute.useParams();
  return <DocPageRoute slug={slug} />;
}

const docPageRoute = createRoute({
  getParentRoute: () => docSpaceRoute,
  path: "$slug",
  component: DocPageRoutePage,
});

function DocEditRoutePage() {
  const { slug } = docEditRoute.useParams();
  return <EditManualPageRoute slug={slug} />;
}

const docEditRoute = createRoute({
  getParentRoute: () => docSpaceRoute,
  path: "$slug/edit",
  component: DocEditRoutePage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  ...appRoutes.map((r) => (r === mailRoute ? mailRoute.addChildren([mailThreadRoute]) : r)),
  conversationRoute,
  chatChannelRoute,
  filterRoute,
  projectIndexRoute,
  projectSectionRoute,
  projectChatChannelRoute,
  docsHomeRoute,
  docSpaceRoute.addChildren([
    docSpaceIndexRoute,
    docNewPageRoute,
    docBriefRoute,
    docReleasesRoute,
    docGraphRoute,
    docPageRoute,
    docEditRoute,
  ]),
]);

export function createAppRouter(history: RouterHistory) {
  return createRouter({ routeTree, history });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
